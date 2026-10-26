import { cloud } from '../cloud'
import type { QuestionType, QuestionCounts, DocKind } from './types'
import { LETTERS } from './types'
import { loadAISettings, type AISettings } from './settings'

/* ------------------------------------------------------------------ */
/* 基础调用层                                                          */
/* ------------------------------------------------------------------ */

const CHUNK_SIZE = 5200
const MAX_CHUNKS = 12

/** 调参开关：把命题自检的明细打到控制台。调完改成 false 即可静默。 */
const DEBUG_REVIEW = true

let cachedModelId: string | null = null

async function resolveModel(): Promise<string> {
  if (cachedModelId) return cachedModelId
  const models = await cloud.llm.models.list()
  const usable = (models || []).filter((m: any) => m && m.disabled !== true && m.id)
  if (!usable.length) {
    throw new Error('当前环境没有可用模型，请稍后重试。')
  }
  cachedModelId = usable[0].id
  return cachedModelId
}

export function describeError(err: any): string {
  const code: string = err?.error?.code || ''
  const message: string = err?.error?.message || err?.message || '未知错误'
  if (err instanceof Error && !code) return message
  if (code.startsWith('quota_')) return 'AI 额度已用尽或触发限流，请稍后再试。'
  if (code.startsWith('auth_')) return 'AI 服务鉴权失败，请通过正式发布的域名访问后重试。'
  if (code.startsWith('model_') || code.startsWith('gateway_')) return '模型服务暂时不可用，请稍后重试。'
  if (code.startsWith('request_')) return `请求参数有误：${message}`
  if (code.startsWith('internal_')) {
    return `服务内部错误${err?.requestId ? `（请求号 ${err.requestId}）` : ''}，请稍后重试。`
  }
  return message
}

/* ------------------------ 用户自带模型接口 ------------------------ */

async function chatViaCustom(
  config: AISettings,
  opts: { system: string; user: string; temperature?: number },
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        temperature: opts.temperature ?? 0.4,
      }),
    })
  } catch {
    throw new Error(
      '连不上自定义模型接口。常见原因是该服务商不允许浏览器直连（CORS），或接口地址填错。',
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`自定义模型接口返回 ${response.status}：${detail.slice(0, 160)}`)
  }

  const data = await response.json().catch(() => null)
  let content = data?.choices?.[0]?.message?.content
  if (Array.isArray(content)) {
    content = content.map((part: any) => part?.text || '').join('')
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('自定义模型接口没有返回文本，请确认模型名与接口地址是否匹配。')
  }
  return content
}

export async function testCustomEndpoint(config: AISettings): Promise<string> {
  const reply = await chatViaCustom(config, {
    system: '你是测试助手，回答尽量短。',
    user: '只回复两个字：通了',
    temperature: 0,
  })
  return reply.trim().slice(0, 30)
}

async function chatText(opts: {
  system: string
  user: string
  temperature?: number
  signal?: AbortSignal
}): Promise<string> {
  const custom = loadAISettings()
  if (custom) return chatViaCustom(custom, opts)

  const model = await resolveModel()

  const run = async (structured: boolean): Promise<string> => {
    let text = ''
    const stream = await cloud.llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      stream: true,
      temperature: opts.temperature ?? 0.4,
      ...(structured ? { response_format: { type: 'json_object' } } : {}),
      signal: opts.signal,
    } as any)
    for await (const chunk of stream as any) {
      const delta = chunk?.choices?.[0]?.delta
      if (delta?.content) text += delta.content
    }
    return text
  }

  try {
    return await run(true)
  } catch (err) {
    // 部分模型不支持 response_format，退回纯提示词约束再试一次
    const code = String((err as any)?.error?.code || '')
    if (code.startsWith('request_')) return run(false)
    throw err
  }
}

function extractJSON(raw: string): any {
  let s = (raw || '').trim()
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) s = fenced[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  return JSON.parse(s)
}

async function chatJSON(opts: { system: string; user: string; temperature?: number }): Promise<any> {
  const first = await chatText(opts)
  try {
    return extractJSON(first)
  } catch {
    const retry = await chatText({
      ...opts,
      temperature: 0.2,
      user: `${opts.user}\n\n注意：上一次输出不是合法 JSON。请只输出一个合法的 JSON 对象，不要任何解释文字、不要 Markdown 代码块。`,
    })
    return extractJSON(retry)
  }
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/* ------------------------------------------------------------------ */
/* 文本分块                                                            */
/* ------------------------------------------------------------------ */

export interface Chunked {
  chunks: string[]
  truncated: boolean
}

export function splitChunks(text: string): Chunked {
  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let buffer = ''

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_SIZE) {
      if (buffer.trim()) {
        chunks.push(buffer.trim())
        buffer = ''
      }
      for (let i = 0; i < paragraph.length; i += CHUNK_SIZE) {
        chunks.push(paragraph.slice(i, i + CHUNK_SIZE).trim())
      }
      continue
    }
    if ((buffer + '\n\n' + paragraph).length > CHUNK_SIZE) {
      chunks.push(buffer.trim())
      buffer = paragraph
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim())

  const all = chunks.filter(Boolean)
  return { chunks: all.slice(0, MAX_CHUNKS), truncated: all.length > MAX_CHUNKS }
}

/* ------------------------------------------------------------------ */
/* 第一步：抽取知识点                                                  */
/* ------------------------------------------------------------------ */

export interface RawKP {
  title: string
  summary: string
  excerpts: string[]
}

const EXTRACT_SYSTEM =
  '你是一位严谨的学科教研员，擅长从教材与学习笔记中梳理可考察的知识点。' +
  '你只输出 JSON，不输出任何解释性文字。'

function buildExtractPrompt(chunk: string, index: number, total: number): string {
  return `请从下面的资料片段中抽取知识点。

要求：
1. 每个知识点包含：title（不超过 18 字，具体到可考察的概念，不要用"第一部分"这类标题层级）、summary（1-2 句话说明它讲了什么）、excerpts（原文摘录数组）。
2. excerpts 必须是原文中**逐字出现**的连续片段，不得改写、不得概括、不得把不相邻的句子拼在一起；每段 30-200 字，每个知识点给 2-5 段。
3. 优先抽取有明确定义、分类、因果、步骤、公式、易混淆对比的内容；跳过目录、序言、致谢、参考文献、习题答案等无考察价值的部分。
4. 本片段抽取 3-8 个知识点。如果片段内容确实很少，可以少于 3 个。

输出格式（JSON）：
{"knowledgePoints":[{"title":"...","summary":"...","excerpts":["...","..."]}]}

资料片段（第 ${index + 1}/${total} 段）：
"""
${chunk}
"""`
}

export async function extractKnowledgePoints(
  chunks: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<RawKP[]> {
  if (!chunks.length) return []

  let done = 0
  let firstError: any = null

  const batches = await runPool(chunks, 3, async (chunk, index) => {
    try {
      const data = await chatJSON({
        system: EXTRACT_SYSTEM,
        user: buildExtractPrompt(chunk, index, chunks.length),
        temperature: 0.3,
      })
      const list = Array.isArray(data?.knowledgePoints) ? data.knowledgePoints : []
      return list
        .map((item: any) => ({
          title: String(item?.title || '').trim(),
          summary: String(item?.summary || '').trim(),
          excerpts: Array.isArray(item?.excerpts)
            ? item.excerpts.map((e: any) => String(e || '').trim()).filter((e: string) => e.length > 15)
            : [],
        }))
        .filter((item: RawKP) => item.title && item.excerpts.length > 0)
    } catch (err) {
      if (!firstError) firstError = err
      return [] as RawKP[]
    } finally {
      done += 1
      onProgress?.(done, chunks.length)
    }
  })

  const flat = batches.flat()
  if (!flat.length) {
    throw firstError || new Error('没有从资料中抽取到知识点，请确认文档内容是否为正文。')
  }

  return mergeKnowledgePoints(flat)
}

function normalizeKey(title: string): string {
  return title
    .replace(/[\s，。、：；！？（）()【】\[\]"'“”‘’·,.:;!?\-—_/\\]/g, '')
    .toLowerCase()
}

function mergeKnowledgePoints(list: RawKP[]): RawKP[] {
  const out: RawKP[] = []
  const byKey = new Map<string, RawKP>()

  for (const item of list) {
    const key = normalizeKey(item.title)
    if (!key) continue

    let target = byKey.get(key)
    if (!target) {
      for (const [existingKey, existing] of byKey) {
        if (existingKey.length >= 4 && key.length >= 4) {
          if (existingKey.includes(key) || key.includes(existingKey)) {
            target = existing
            break
          }
        }
      }
    }

    if (target) {
      for (const excerpt of item.excerpts) {
        const duplicated = target.excerpts.some(
          (e) => e.includes(excerpt) || excerpt.includes(e),
        )
        if (!duplicated && target.excerpts.length < 6) target.excerpts.push(excerpt)
      }
      if (item.summary.length > target.summary.length) target.summary = item.summary
    } else {
      const created: RawKP = {
        title: item.title,
        summary: item.summary,
        excerpts: [...new Set(item.excerpts)].slice(0, 6),
      }
      out.push(created)
      byKey.set(key, created)
    }
  }

  return out.slice(0, 20)
}

/* ------------------------------------------------------------------ */
/* 资料结构路由：逐块判断是知识、题目还是无实质内容                      */
/* ------------------------------------------------------------------ */

export type ChunkKind = 'knowledge' | 'questions' | 'empty'

export interface RoutedDoc {
  chunks: string[]
  kinds: ChunkKind[]
  kind: DocKind
  truncated: boolean
}

const ROUTE_SYSTEM = '你是文档结构判别助手。只输出 JSON，不做解释。'

function buildRoutePrompt(chunks: string[]): string {
  const snippets = chunks
    .map((chunk, index) => `【片段 ${index + 1}】\n${chunk.slice(0, 400)}`)
    .join('\n\n')

  return `下面是一份资料按顺序切成的 ${chunks.length} 个片段，每个片段只截取了开头。

请逐段判断它的主要内容属于哪一类：
- "knowledge"：在阐述知识（定义、原理、推导、讲义、笔记）
- "questions"：在罗列题目（题号、"（　）"、"答："、"参考答案"等）
- "empty"：目录、扉页、版权页、页码、参考文献等没有考察价值的内容

${snippets}

只输出：{"kinds":["knowledge","questions",...]}
数组长度必须正好是 ${chunks.length}，顺序与片段一一对应。`
}

/**
 * 把资料切块并逐块判定类型。
 * 混合文档（前半讲义、后半题库）会同时出现 knowledge 与 questions。
 */
export async function routeDocument(text: string): Promise<RoutedDoc> {
  const { chunks, truncated } = splitChunks(text)
  if (!chunks.length) {
    return { chunks: [], kinds: [], kind: 'knowledge', truncated: false }
  }

  let kinds: ChunkKind[] = []

  try {
    const data = await chatJSON({
      system: ROUTE_SYSTEM,
      user: buildRoutePrompt(chunks),
      temperature: 0,
    })
    const raw = Array.isArray(data?.kinds) ? data.kinds : []
    kinds = chunks.map((_, index) => {
      const value = String(raw[index] || '').toLowerCase()
      if (value === 'questions' || value === 'empty') return value
      return 'knowledge'
    })
  } catch {
    kinds = chunks.map(() => 'knowledge' as ChunkKind)
  }

  const hasKnowledge = kinds.includes('knowledge')
  const hasQuestions = kinds.includes('questions')
  const kind: DocKind = hasKnowledge && hasQuestions ? 'mixed' : hasQuestions ? 'questions' : 'knowledge'

  return { chunks, kinds, kind, truncated }
}

/* ------------------------------------------------------------------ */
/* 已有题库：把原有题目抽出来                                          */
/* ------------------------------------------------------------------ */

const EXTRACT_QUESTION_SYSTEM =
  '你是资料整理助手，负责把资料中已经存在的题目原样抽出来，不新增题目、不改动题意。只输出 JSON。'

function buildExtractQuestionPrompt(chunk: string, index: number, total: number): string {
  return `请从下面的资料中抽取**已经存在的题目**，不要自己出题。

要求：
1. 保留原题的表述与选项顺序，不要改写题干含义。
2. 题型判断：有 3-4 个选项的单选题记为 choice；只有"正确/错误"两选一的记为 judge；问答、简答、论述、名词解释、材料分析记为 short。
3. answer 字段：choice 填选项字母（如 "B"）；judge 填"对"或"错"；short 填资料中给出的答案原文，保留要点。
4. 只有在资料**确实没有给出答案**时，才依据学科知识补一个参考答案。
5. explanation：资料里有解析就整理进来，没有就填空字符串。
6. 跳过目录、页码、章节标题、重复的题号；本片段有几道就抽几道。

输出格式（JSON）：
{"questions":[
{"type":"choice","stem":"题干","options":["选项1","选项2","选项3","选项4"],"answer":"B","explanation":""},
{"type":"judge","stem":"陈述句","options":[],"answer":"对","explanation":""},
{"type":"short","stem":"题干","options":[],"answer":"参考答案","explanation":""}
]}

资料片段（第 ${index + 1}/${total} 段）：
"""
${chunk}
"""`
}

export async function extractExistingQuestions(
  chunks: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<RawQuestion[]> {
  if (!chunks.length) return []

  let done = 0
  let firstError: any = null

  const batches = await runPool(chunks, 3, async (chunk, index) => {
    try {
      const data = await chatJSON({
        system: EXTRACT_QUESTION_SYSTEM,
        user: buildExtractQuestionPrompt(chunk, index, chunks.length),
        temperature: 0.2,
      })
      const list = Array.isArray(data?.questions) ? data.questions : []
      return list
        .map((item: any) => normalizeOne(item))
        .filter((item: RawQuestion | null): item is RawQuestion => !!item)
    } catch (err) {
      if (!firstError) firstError = err
      return [] as RawQuestion[]
    } finally {
      done += 1
      onProgress?.(done, chunks.length)
    }
  })

  const flat = batches.flat()
  if (!flat.length) {
    throw firstError || new Error('没有从这份资料里识别出题目，可能需要按知识内容处理。')
  }

  return flat
}

/* ------------------------------------------------------------------ */
/* 第二步：按知识点出题                                                */
/* ------------------------------------------------------------------ */

export interface RawQuestion {
  type: QuestionType
  stem: string
  options: string[]
  answer: string
  explanation: string
  /** 支撑该题的原文片段，必须是原文逐字复制 */
  evidence?: string
  /** 解答题的评分要点，用于和盲答结果比对 */
  keyPoints?: string[]
}

const QUESTION_SYSTEM =
  '你是一位资深命题人。你出的每一道题都必须能由给定材料原文直接支撑，' +
  '不得引入材料之外的知识，也不得靠常识补充细节。你只输出 JSON。'

/** 题干归一化：去掉空白与标点，只留实义字符用于比对 */
function normalizeStem(stem: string): string {
  return String(stem || '')
    .toLowerCase()
    .replace(/[\s，。、：；！？（）()【】\[\]"'“”‘’·,.:;!?\-—_/\\]/g, '')
}

/** 同一知识点下，与已出题目完全相同或高度重叠的都算重复 */
function isDuplicateStem(stem: string, seen: Set<string>): boolean {
  const key = normalizeStem(stem)
  if (!key) return true
  if (seen.has(key)) return true

  for (const existing of seen) {
    const shorter = Math.min(existing.length, key.length)
    const longer = Math.max(existing.length, key.length)
    if (shorter < 8 || longer === 0) continue
    if (shorter / longer < 0.8) continue
    if (existing.includes(key) || key.includes(existing)) return true
  }
  return false
}

function buildQuestionPrompt(kp: RawKP, counts: QuestionCounts, existing: string[]): string {
  const parts: string[] = []
  if (counts.choice > 0) {
    parts.push(
      `- 选择题 ${counts.choice} 道：4 个选项，只有 1 个正确。干扰项要针对常见误解或材料中的邻近概念设计，不能一眼看出荒谬。`,
    )
  }
  if (counts.judge > 0) {
    parts.push(
      `- 判断题 ${counts.judge} 道：陈述句，答案为"对"或"错"。错项必须改动关键条件或偷换概念，不能只加一个"不"字。`,
    )
  }
  if (counts.short > 0) {
    parts.push(
      `- 解答题 ${counts.short} 道：需要 2-4 句话作答，考察理解、因果或步骤，不要考原文背诵。同时给出 keyPoints（3-5 条评分要点，每条一句话），用于核对答案是否答到了点上。`,
    )
  }

  const avoid = existing.length
    ? `

这个知识点已经出过下面这些题目，**不要重复或稍作改写再出一遍**（不要只改数字、换个说法、调换选项顺序）：
${existing
  .slice(0, 30)
  .map((stem, index) => `${index + 1}. ${stem}`)
  .join('\n')}`
    : ''

  return `知识点：${kp.title}
要点：${kp.summary || '（无）'}

原文材料：
"""
${kp.excerpts.join('\n\n')}
"""

请基于以上材料出题：
${parts.join('\n')}${avoid}

每道题都必须附带 evidence：从上面【原文材料】里**逐字复制**的一段连续文字（不少于 15 字），
必须能直接支撑该题的正确答案。不得改写、不得概括、不得拼接不相邻的句子。
如果某道题在原文里找不到明确依据，就不要出这道题。

输出格式（JSON）：
{"questions":[
{"type":"choice","stem":"题干","options":["选项内容1","选项内容2","选项内容3","选项内容4"],"answer":"B","explanation":"解析：说明正确答案的依据，以及其它选项错在哪里","evidence":"原文逐字片段"},
{"type":"judge","stem":"陈述句","options":[],"answer":"对","explanation":"解析","evidence":"原文逐字片段"},
{"type":"short","stem":"题干","options":[],"answer":"参考答案（分点作答，2-4 句）","explanation":"评分要点","evidence":"原文逐字片段","keyPoints":["要点1","要点2","要点3"]}
]}

注意：choice 的 answer 只能是一个大写选项字母；options 里不要写"A."这类前缀；所有题干不要编号。`
}

function normalizeAnswerLetter(raw: string, optionCount: number): string {
  const value = String(raw || '').trim().toUpperCase()
  const direct = value.match(/^[A-F]/)
  if (direct) return direct[0]
  const index = Number(value)
  if (!Number.isNaN(index) && optionCount > 0) {
    const position = Number.isInteger(index) && index < optionCount ? index : index - 1
    if (position >= 0 && position < optionCount) return LETTERS[position]
  }
  return ''
}

function normalizeJudgeAnswer(raw: string): string {
  const value = String(raw || '').trim()
  if (/^(对|正确|是|true|T|√|✓|yes)$/i.test(value)) return '对'
  if (/^(错|错误|否|false|F|×|✗|no)$/i.test(value)) return '错'
  return ''
}

function normalizeQuestions(list: any[], type: QuestionType, expected: number): RawQuestion[] {
  const out: RawQuestion[] = []
  for (const item of list) {
    const normalized = normalizeOne(item, type)
    if (normalized && normalized.type === type) out.push(normalized)
  }
  return out.slice(0, expected || out.length)
}

/** 把模型返回的单条题目归一化；题型缺失时按结构推断 */
function normalizeOne(item: any, declaredType?: QuestionType): RawQuestion | null {
  const stem = String(item?.stem || '').trim()
  if (!stem) return null

  const explanation = String(item?.explanation || '').trim()
  const evidence = String(item?.evidence || '').trim()
  const rawOptions = Array.isArray(item?.options) ? item.options : []
  const rawType = String(item?.type || '').trim().toLowerCase()

  let type: QuestionType
  if (rawType === 'choice' || rawType === 'judge' || rawType === 'short') {
    type = rawType
  } else if (declaredType) {
    type = declaredType
  } else if (rawOptions.length >= 3) {
    type = 'choice'
  } else if (normalizeJudgeAnswer(item?.answer)) {
    type = 'judge'
  } else {
    type = 'short'
  }

  if (type === 'choice') {
    const options = rawOptions.map((option: any) =>
      String(option || '')
        .replace(/^\s*[A-Fa-f][.、)]\s*/, '')
        .trim(),
    )
    if (options.length < 3) return null
    const answer = normalizeAnswerLetter(item?.answer, options.length)
    if (!answer) return null
    return { type, stem, options, answer, explanation, evidence }
  }

  if (type === 'judge') {
    const answer = normalizeJudgeAnswer(item?.answer)
    if (!answer) return null
    return { type, stem, options: [], answer, explanation, evidence }
  }

  const answer = String(item?.answer || '').trim()
  if (!answer) return null
  const keyPoints = Array.isArray(item?.keyPoints)
    ? item.keyPoints.map((point: any) => String(point || '').trim()).filter(Boolean)
    : []
  return { type, stem, options: [], answer, explanation, evidence, keyPoints }
}

async function requestQuestions(
  kp: RawKP,
  counts: QuestionCounts,
  existing: string[],
): Promise<RawQuestion[]> {
  const total = counts.choice + counts.judge + counts.short
  if (total <= 0) return []

  const data = await chatJSON({
    system: QUESTION_SYSTEM,
    user: buildQuestionPrompt(kp, counts, existing),
    temperature: 0.7,
  })

  const list = Array.isArray(data?.questions) ? data.questions : []
  const raw: RawQuestion[] = []
  for (const type of ['choice', 'judge', 'short'] as QuestionType[]) {
    const expected = counts[type]
    if (!expected) continue
    const subset = list.filter((q: any) => String(q?.type || '').toLowerCase() === type)
    raw.push(...normalizeQuestions(subset, type, expected))
  }

  if (DEBUG_REVIEW && raw.length < list.length) {
    console.log(`[命题自检] ${kp.title}：模型返回 ${list.length} 道，结构不合格丢弃 ${list.length - raw.length} 道`)
  }
  return raw
}

const REVIEW_SYSTEM = '你是严谨的命题审核员，只挑真正不能用的题。只输出 JSON，不做解释。'

interface ReviewIssue {
  index: number
  reason: string
}

/** 拿题干和答案回原文核验，返回不合格题目的下标与原因 */
async function reviewQuestions(kp: RawKP, questions: RawQuestion[]): Promise<ReviewIssue[]> {
  if (!questions.length) return []

  const payload = questions.map((question, index) => ({
    index,
    type: question.type,
    stem: question.stem,
    options: question.options,
    answer: question.answer,
  }))

  const data = await chatJSON({
    system: REVIEW_SYSTEM,
    user: `知识点：${kp.title}

原文材料（唯一事实依据）：
"""
${kp.excerpts.join('\n\n')}
"""

待审核的题目：
${JSON.stringify(payload, null, 2)}

逐题检查，只挑出**确实有问题**的题，不要吹毛求疵：
1. 题干里的术语、事实、数据必须能在原文中找到依据，不能凭空捏造。
2. 标注的答案必须唯一，且确实能由原文推出。
3. 选择题的干扰项要合理：不能出现两个正确答案，不能有"以上都对""都不对"这类凑数项。
4. 题干不能空泛到无法作答，也不能与该知识点无关。

输出 {"bad":[{"index":0,"reason":"简短说明"}]}；全部合格则输出 {"bad":[]}`,
    temperature: 0,
  })

  const list = Array.isArray(data?.bad) ? data.bad : []
  if (!Array.isArray(data?.bad) && DEBUG_REVIEW) {
    console.warn('[命题自检] 审核返回结构异常，本次按「全部通过」处理：', data)
  }
  return list
    .map((item: any) => ({
      index: Number(item?.index),
      reason: String(item?.reason || '').trim(),
    }))
    .filter(
      (item: ReviewIssue) =>
        Number.isInteger(item.index) && item.index >= 0 && item.index < questions.length,
    )
}

/* ------------------------------------------------------------------ */
/* 严格出题：原文依据 + 双盲复核 + 文本自检                             */
/* ------------------------------------------------------------------ */

function normalizeChoiceAnswer(value: string): string {
  const match = String(value || '')
    .trim()
    .toUpperCase()
    .match(/^[A-F]/)
  return match ? match[0] : ''
}

function normalizeJudgeText(value: string): string {
  const text = String(value || '').trim()
  if (/^(对|正确|是|真|true|t|yes|y|√|✓)$/i.test(text)) return '对'
  if (/^(错|错误|否|假|false|f|no|n|×|x|✗)$/i.test(text)) return '错'
  return ''
}

/** 原文依据校验：evidence 必须逐字出现在知识点摘录中 */
function matchesSource(kp: RawKP, question: RawQuestion): boolean {
  const squeeze = (value: string) => String(value || '').replace(/\s+/g, '')
  const evidence = squeeze(question.evidence || '')
  if (evidence.length < 12) return false
  return squeeze(kp.excerpts.join('')).includes(evidence)
}

interface BlindResult {
  answers: Map<number, string>
  points: Map<number, string[]>
}

/**
 * 双盲复核：把标注答案去掉，只给题干和选项，让模型重新作答。
 * 这是唯一能破除「自己出题自己审」相关性错误的环节。
 */
async function blindAnswers(kp: RawKP, questions: RawQuestion[]): Promise<BlindResult> {
  const answers = new Map<number, string>()
  const points = new Map<number, string[]>()
  if (!questions.length) return { answers, points }

  const payload = questions.map((question, index) => ({
    index,
    type: question.type,
    stem: question.stem,
    options: question.options,
  }))

  const data = await chatJSON({
    system: '你是答题者。只输出 JSON，不做解释。',
    user: `请仅依据下面的原文材料作答，不要揣测出题意图。

原文材料：
"""
${kp.excerpts.join('\n\n')}
"""

题目：
${JSON.stringify(payload, null, 2)}

要求：
- choice：answer 只能是一个大写选项字母，如 "B"
- judge：answer 只能是 "对" 或 "错"
- short：answer 用 2-4 句作答，同时给出 points（3-5 条要点，每条一句话）
- 每题都必须作答，不要留空

输出 {"answers":[{"index":0,"answer":"B"},{"index":2,"answer":"……","points":["要点1","要点2"]}]}`,
    temperature: 0,
  })

  const list = Array.isArray(data?.answers) ? data.answers : []
  for (const item of list) {
    const index = Number(item?.index)
    if (!Number.isInteger(index) || index < 0 || index >= questions.length) continue
    const answer = String(item?.answer || '').trim()
    if (answer) answers.set(index, answer)
    if (Array.isArray(item?.points)) {
      const parsed = item.points.map((point: any) => String(point || '').trim()).filter(Boolean)
      if (parsed.length) points.set(index, parsed)
    }
  }
  return { answers, points }
}

interface ShortPair {
  index: number
  labeled: string[]
  blind: string[]
}

/**
 * 简答题没有唯一答案，无法逐字比对。
 * 这里比较「两组独立产出的要点」，比较者不参与任何一方的生成，相关性已被切断。
 */
async function compareShortAnswers(pairs: ShortPair[]): Promise<Set<number>> {
  const equivalent = new Set<number>()
  if (!pairs.length) return equivalent

  const payload = pairs.map((pair) => ({
    index: pair.index,
    A: pair.labeled.slice(0, 6),
    B: pair.blind.slice(0, 6),
  }))

  const data = await chatJSON({
    system: '你是答案核对员。只输出 JSON，不做解释。',
    user: `下面是几组简答题要点。每组 A 和 B 是对同一道题的两次独立作答，先后顺序不代表对错。

请判断每组 A 和 B 表达的意思是否实质相同：
- 措辞不同、顺序不同，但说的是同一件事 → 相同
- 遗漏关键要点，或结论相互矛盾 → 不同

${JSON.stringify(payload, null, 2)}

输出 {"results":[{"index":0,"equivalent":true}]}，必须覆盖每一组。`,
    temperature: 0,
  })

  const list = Array.isArray(data?.results) ? data.results : []
  for (const item of list) {
    const index = Number(item?.index)
    if (Number.isInteger(index) && item?.equivalent === true) equivalent.add(index)
  }
  return equivalent
}

export interface GenerationStats {
  questions: RawQuestion[]
  skipped: number
  rejected: number
  conflicts: number
  unsupported: number
}

/**
 * 严格出题：出题 → 原文依据 → 双盲复核 → 文本自检 → 去重。
 * 任何一环不过的题直接剔除，不重出——宁可少出，不可出错。
 */
export async function generateQuestionsForKP(
  kp: RawKP,
  counts: QuestionCounts,
  existing: string[] = [],
): Promise<GenerationStats> {
  const total = counts.choice + counts.judge + counts.short
  if (total <= 0) {
    return { questions: [], skipped: 0, rejected: 0, conflicts: 0, unsupported: 0 }
  }

  const generated = await requestQuestions(kp, counts, existing)

  // 1. 原文依据（确定性校验，不依赖模型判断）
  const supported = generated.filter((question) => matchesSource(kp, question))
  const unsupported = generated.length - supported.length

  // 2. 双盲复核（独立采样，与标注答案比对）
  const blind = await blindAnswers(kp, supported)
  const passed: { index: number; question: RawQuestion }[] = []
  const shortPairs: ShortPair[] = []

  supported.forEach((question, index) => {
    if (question.type === 'short') {
      const blindPoints = blind.points.get(index) || []
      const labeled = question.keyPoints || []
      if (blindPoints.length && labeled.length) {
        shortPairs.push({ index, labeled, blind: blindPoints })
        passed.push({ index, question })
      }
      return
    }

    const answered = blind.answers.get(index) || ''
    const same =
      question.type === 'choice'
        ? normalizeChoiceAnswer(answered) === normalizeChoiceAnswer(question.answer)
        : normalizeJudgeText(answered) === normalizeJudgeText(question.answer)
    if (same) passed.push({ index, question })
  })

  if (shortPairs.length) {
    const equivalent = await compareShortAnswers(shortPairs)
    for (let i = passed.length - 1; i >= 0; i -= 1) {
      const entry = passed[i]
      if (entry.question.type !== 'short') continue
      if (!equivalent.has(entry.index)) passed.splice(i, 1)
    }
  }

  const consistent = passed
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.question)
  const conflicts = supported.length - consistent.length

  // 3. 文本自检（同一模型，补双盲覆盖不到的问题；失败不阻塞）
  let issues: ReviewIssue[] = []
  try {
    issues = await reviewQuestions(kp, consistent)
  } catch (error) {
    if (DEBUG_REVIEW) console.warn('[命题自检] 审核调用失败，已跳过文本自检：', error)
    issues = []
  }

  const badIndex = new Set(issues.map((issue) => issue.index))
  const clean = consistent.filter((_, index) => !badIndex.has(index))

  // 4. 去重
  const seen = new Set(existing.map(normalizeStem).filter(Boolean))
  const questions: RawQuestion[] = []
  let skipped = 0

  for (const question of clean) {
    if (isDuplicateStem(question.stem, seen)) {
      skipped += 1
      continue
    }
    seen.add(normalizeStem(question.stem))
    questions.push(question)
  }

  if (DEBUG_REVIEW) {
    console.groupCollapsed(
      `[命题自检] ${kp.title}：出 ${generated.length} → 保留 ${questions.length}`,
    )
    console.log(
      `无原文依据 ${unsupported}｜双盲答案不一致 ${conflicts}｜文本自检不合格 ${issues.length}｜重复 ${skipped}`,
    )
    for (const issue of issues) {
      console.log(
        `自检 #${issue.index + 1} ${issue.reason || '未说明原因'}\n  题干：${consistent[issue.index]?.stem || ''}`,
      )
    }
    console.groupEnd()
  }

  return { questions, skipped, rejected: issues.length, conflicts, unsupported }
}

/* ------------------------------------------------------------------ */
/* 第三步：批改解答题                                                  */
/* ------------------------------------------------------------------ */

export interface GradeResult {
  score: number
  comment: string
}

const GRADE_SYSTEM =
  '你是一位严谨的阅卷老师。依据参考答案给学生的解答题打分并给出简短点评，只输出 JSON。'

export async function gradeShortAnswers(
  items: { id: number; stem: string; reference: string; student: string }[],
): Promise<Map<number, GradeResult>> {
  const map = new Map<number, GradeResult>()
  if (!items.length) return map

  const batches: (typeof items)[] = []
  for (let i = 0; i < items.length; i += 6) batches.push(items.slice(i, i + 6))

  for (const batch of batches) {
    const payload = batch.map((item) => ({
      id: item.id,
      question: item.stem,
      reference: item.reference,
      student: item.student || '（未作答）',
    }))

    const data = await chatJSON({
      system: GRADE_SYSTEM,
      user: `请逐题评分。

评分标准：
- score 为 0-100 的整数，按覆盖参考答案要点的比例给分。
- 意思正确即可满分，不要求措辞与参考答案一致。
- 未作答给 0 分。

待批改内容：
${JSON.stringify(payload, null, 2)}

输出格式（JSON）：
{"results":[{"id":1,"score":85,"comment":"指出答对的部分与遗漏的要点，2 句以内"}]}`,
      temperature: 0.2,
    })

    const results = Array.isArray(data?.results) ? data.results : []
    for (const row of results) {
      const id = Number(row?.id)
      if (Number.isNaN(id)) continue
      const score = Math.max(0, Math.min(100, Math.round(Number(row?.score) || 0)))
      map.set(id, { score, comment: String(row?.comment || '').trim() })
    }
  }

  return map
}
