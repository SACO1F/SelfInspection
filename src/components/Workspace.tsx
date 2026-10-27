import { useEffect, useMemo, useState } from 'react'
import type { Doc, DocKind, KnowledgePoint, Question, QuestionCounts } from '../lib/types'
import { TYPE_LABEL, LETTERS } from '../lib/types'
import type { Repo, NewQuestion, QuestionPatch } from '../lib/repo'
import { loadQueue, saveQueue, type QueueItem } from '../lib/queue'
import { LIMITS, consumeImport, consumePoints, remainingImports, remainingPoints } from '../lib/quota'
import type { TaskItem } from './TaskProgress'
import {
  extractKnowledgePoints,
  generateQuestionsForKP,
  describeError,
  routeDocument,
} from '../lib/llm'
import {
  buildSections,
  toMarkdown,
  printAsPdf,
  exportDocx,
  downloadBlob,
  downloadText,
  safeFileName,
} from '../lib/export'
import { Logo } from './Logo'
import Quiz from './Quiz'

interface Props {
  doc: Doc & { content: string }
  repo: Repo
  onBack: () => void
  onOpenSettings: () => void
  onTaskStart: (title: string) => string
  onTaskUpdate: (id: string, patch: Partial<TaskItem>) => void
  onTaskFinish: (id: string, status: 'done' | 'error', error?: string) => void
  notify: (message: string) => void
}

type Tab = 'points' | 'drafts' | 'questions'

const DEFAULT_COUNTS: QuestionCounts = { choice: 3, judge: 2, short: 1 }
const COUNT_KEYS: (keyof QuestionCounts)[] = ['choice', 'judge', 'short']
const COUNT_LABEL: Record<keyof QuestionCounts, string> = {
  choice: '选择',
  judge: '判断',
  short: '解答',
}

function CountsEditor({
  counts,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
}: {
  counts: QuestionCounts
  onChange: (counts: QuestionCounts) => void
  onSubmit: () => void
  onCancel: () => void
  submitting: boolean
  submitLabel: string
}) {
  const total = counts.choice + counts.judge + counts.short

  return (
    <div className="counts-panel">
      {COUNT_KEYS.map((key) => (
        <div className="counts-row" key={key}>
          <span className="counts-label">{COUNT_LABEL[key]}题</span>
          <div className="stepper">
            <button
              type="button"
              onClick={() => onChange({ ...counts, [key]: Math.max(0, counts[key] - 1) })}
              disabled={counts[key] <= 0}
            >
              −
            </button>
            <span className="stepper-value">{counts[key]}</span>
            <button
              type="button"
              onClick={() => onChange({ ...counts, [key]: Math.min(10, counts[key] + 1) })}
              disabled={counts[key] >= 10}
            >
              +
            </button>
          </div>
        </div>
      ))}
      <div className="counts-actions">
        <button className="btn subtle" onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" disabled={submitting || total === 0} onClick={onSubmit}>
          {submitting ? '处理中…' : `${submitLabel}（${total} 题）`}
        </button>
      </div>
    </div>
  )
}

/** 选项 + 答案区，出题文档与题库共用；默认收起答案，避免直接看到答案 */
function QuestionPreview({
  question,
  showAnswer,
  onToggle,
}: {
  question: Question
  showAnswer: boolean
  onToggle: () => void
}) {
  const [showEvidence, setShowEvidence] = useState(false)

  return (
    <>
      {question.type === 'choice' && (
        <ul className="bank-options">
          {question.options.map((option, oi) => (
            <li key={oi} className={showAnswer && LETTERS[oi] === question.answer ? 'right' : ''}>
              <span>{LETTERS[oi]}</span>
              {option}
            </li>
          ))}
        </ul>
      )}

      <div className="draft-reveal">
        <button className="text-btn" onClick={onToggle}>
          {showAnswer ? '隐藏答案' : '显示答案'}
        </button>
        {question.evidence ? (
          <button className="text-btn" onClick={() => setShowEvidence((value) => !value)}>
            {showEvidence ? '收起依据' : '查看原文依据'}
          </button>
        ) : null}
      </div>

      {showEvidence && question.evidence ? (
        <blockquote className="evidence-block">{question.evidence}</blockquote>
      ) : null}

      {showAnswer && (
        <>
          <div className="bank-answer">
            <span className="bank-answer-label">答案</span>
            {question.type === 'choice'
              ? `${question.answer}. ${question.options[LETTERS.indexOf(question.answer)] || ''}`
              : question.answer}
          </div>
          {question.explanation && <p className="bank-explain">{question.explanation}</p>}
        </>
      )}
    </>
  )
}

function DraftCard({
  question,
  index,
  onSave,
  onDelete,
}: {
  question: Question
  index: number
  onSave: (id: number, patch: QuestionPatch) => Promise<void>
  onDelete: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [showAnswer, setShowAnswer] = useState(false)
  const [stem, setStem] = useState(question.stem)
  const [options, setOptions] = useState<string[]>(question.options)
  const [answer, setAnswer] = useState(question.answer)
  const [explanation, setExplanation] = useState(question.explanation)
  const [saving, setSaving] = useState(false)

  function reset() {
    setStem(question.stem)
    setOptions(question.options)
    setAnswer(question.answer)
    setExplanation(question.explanation)
  }

  async function save() {
    if (!stem.trim()) return
    setSaving(true)
    await onSave(question.id, {
      stem: stem.trim(),
      options: question.type === 'choice' ? options.map((item) => item.trim()) : [],
      answer: answer.trim(),
      explanation: explanation.trim(),
    })
    setSaving(false)
    setEditing(false)
  }

  return (
    <article className="draft-card">
      <div className="draft-head">
        <span className="quiz-no">{String(index + 1).padStart(2, '0')}</span>
        <span className="type-chip">{TYPE_LABEL[question.type]}</span>
        <div className="draft-actions">
          {editing ? (
            <>
              <button
                className="text-btn"
                onClick={() => {
                  reset()
                  setEditing(false)
                }}
              >
                取消
              </button>
              <button className="btn primary small" onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <>
              <button className="text-btn" onClick={() => setEditing(true)}>
                编辑
              </button>
              <button className="text-btn danger" onClick={() => onDelete(question.id)}>
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="draft-edit">
          <label className="draft-field">
            <span>题干</span>
            <textarea rows={3} value={stem} onChange={(event) => setStem(event.target.value)} />
          </label>

          {question.type === 'choice' && (
            <div className="draft-field">
              <span>选项</span>
              <div className="draft-options">
                {options.map((option, oi) => (
                  <label className="draft-option" key={oi}>
                    <span className="option-letter">{LETTERS[oi]}</span>
                    <input
                      value={option}
                      onChange={(event) => {
                        const next = [...options]
                        next[oi] = event.target.value
                        setOptions(next)
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="draft-field">
            <span>{question.type === 'judge' ? '答案' : '参考答案 / 答案'}</span>
            {question.type === 'choice' ? (
              <div className="answer-picker">
                {options.map((_, oi) => (
                  <button
                    key={oi}
                    type="button"
                    className={answer === LETTERS[oi] ? 'answer-chip active' : 'answer-chip'}
                    onClick={() => setAnswer(LETTERS[oi])}
                  >
                    {LETTERS[oi]}
                  </button>
                ))}
              </div>
            ) : question.type === 'judge' ? (
              <div className="answer-picker">
                {['对', '错'].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={answer === option ? 'answer-chip active' : 'answer-chip'}
                    onClick={() => setAnswer(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <textarea rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} />
            )}
          </label>

          <label className="draft-field">
            <span>解析</span>
            <textarea
              rows={2}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <>
          <p className="draft-stem">{question.stem}</p>
          <QuestionPreview
            question={question}
            showAnswer={showAnswer}
            onToggle={() => setShowAnswer((value) => !value)}
          />
        </>
      )}
    </article>
  )
}

function BankItem({
  question,
  onDelete,
}: {
  question: Question
  onDelete: (id: number) => void
}) {
  const [showAnswer, setShowAnswer] = useState(false)

  return (
    <div className="bank-item">
      <div className="bank-item-head">
        <span className="type-chip">{TYPE_LABEL[question.type]}</span>
        <span className="bank-stem">{question.stem}</span>
        <button className="icon-btn small" title="删除此题" onClick={() => onDelete(question.id)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <QuestionPreview
        question={question}
        showAnswer={showAnswer}
        onToggle={() => setShowAnswer((value) => !value)}
      />
    </div>
  )
}

export default function Workspace({
  doc,
  repo,
  onBack,
  onOpenSettings,
  onTaskStart,
  onTaskUpdate,
  onTaskFinish,
  notify,
}: Props) {
  const [kind, setKind] = useState<DocKind>(doc.kind)
  const [points, setPoints] = useState<KnowledgePoint[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [drafts, setDrafts] = useState<Question[]>([])
  const [queue, setQueue] = useState<QueueItem[]>(() => loadQueue(doc.id))
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>(doc.kind === 'questions' ? 'drafts' : 'points')
  const [activeId, setActiveId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [panel, setPanel] = useState<null | 'single' | 'all'>(null)
  const [counts, setCounts] = useState<QuestionCounts>(DEFAULT_COUNTS)
  const [submitting, setSubmitting] = useState(false)
  const [quizOpen, setQuizOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [loadedPoints, loadedConfirmed, loadedDrafts] = await Promise.all([
          repo.listPoints(doc.id),
          repo.listQuestions(doc.id, 'confirmed'),
          repo.listQuestions(doc.id, 'draft'),
        ])
        if (cancelled) return
        setPoints(loadedPoints)
        setQuestions(loadedConfirmed)
        setDrafts(loadedDrafts)
        setActiveId(loadedPoints[0]?.id ?? null)

        // 知识点被删掉后，本地残留的队列项要一并清理
        if (loadedPoints.length) {
          setQueue((prev) => {
            const valid = prev.filter((item) =>
              loadedPoints.some((point) => point.id === item.pointId),
            )
            return valid.length === prev.length ? prev : valid
          })
        }
      } catch (err) {
        if (!cancelled) notify(describeError(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc.id, repo, notify])

  useEffect(() => {
    saveQueue(doc.id, queue)
  }, [doc.id, queue])

  const activePoint = useMemo(
    () => points.find((point) => point.id === activeId) || points[0] || null,
    [points, activeId],
  )

  const countsByPoint = useMemo(() => {
    const map = new Map<number, number>()
    for (const question of questions) {
      if (question.knowledge_point_id == null) continue
      map.set(question.knowledge_point_id, (map.get(question.knowledge_point_id) || 0) + 1)
    }
    return map
  }, [questions])

  const queuedIds = useMemo(() => new Set(queue.map((item) => item.pointId)), [queue])

  async function generatePoints() {
    if (points.length) {
      const confirmed = window.confirm('重新生成会删除现有知识点和与之关联的题目，确定继续吗？')
      if (!confirmed) return
    }
    if (remainingImports() <= 0) {
      notify(`今天的资料处理额度用完了（每日 ${LIMITS.dailyImports} 份），明天再来。`)
      return
    }

    setBusy(true)
    const taskId = onTaskStart(`拆解「${doc.title}」的知识点`)
    try {
      const routed = await routeDocument(doc.content)
      const knowledgeChunks = routed.chunks.filter(
        (_, index) => routed.kinds[index] !== 'questions',
      )
      const chunks = knowledgeChunks.length ? knowledgeChunks : routed.chunks
      const extracted = await extractKnowledgePoints(chunks, (done, total) =>
        onTaskUpdate(taskId, { label: '正在拆解知识点', done, total }),
      )
      const created = await repo.replacePoints(doc.id, extracted)
      setPoints(created)
      setQuestions([])
      setDrafts([])
      setQueue([])
      setActiveId(created[0]?.id ?? null)
      setTab('points')
      consumeImport()
      onTaskFinish(taskId, 'done')
      notify(
        routed.truncated
          ? `已生成 ${created.length} 个知识点。资料较长，本次只分析了前面部分。`
          : `已生成 ${created.length} 个知识点。`,
      )
    } catch (err) {
      onTaskFinish(taskId, 'error', describeError(err))
      notify(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function switchToKnowledge() {
    setKind('knowledge')
    await repo.setDocumentKind(doc.id, 'knowledge')
    notify('已切换为「知识内容」，开始拆解知识点…')
    await generatePoints()
  }

  /* --------------------------- 出题文档队列 --------------------------- */

  function enqueue(point: KnowledgePoint, pointCounts: QuestionCounts) {
    setQueue((prev) => {
      const index = prev.findIndex((item) => item.pointId === point.id)
      if (index >= 0) {
        const next = [...prev]
        next[index] = { pointId: point.id, counts: pointCounts }
        return next
      }
      return [...prev, { pointId: point.id, counts: pointCounts }]
    })
    setPanel(null)
    setTab('drafts')
    notify(`已加入出题文档：${point.title}`)
  }

  function enqueueAll() {
    setQueue(points.map((point) => ({ pointId: point.id, counts })))
    setPanel(null)
    setTab('drafts')
    notify(`已把 ${points.length} 个知识点加入出题文档。`)
  }

  function adjustQueue(pointId: number, key: keyof QuestionCounts, delta: number) {
    setQueue((prev) =>
      prev.map((item) =>
        item.pointId === pointId
          ? {
              ...item,
              counts: {
                ...item.counts,
                [key]: Math.max(0, Math.min(10, item.counts[key] + delta)),
              },
            }
          : item,
      ),
    )
  }

  function removeFromQueue(pointId: number) {
    setQueue((prev) => prev.filter((item) => item.pointId !== pointId))
  }

  /** 批量或单点出题共用一套逻辑；成功的从队列移除，失败的留在队列里 */
  async function runGeneration(queued: QueueItem[]) {
    if (!queued.length || submitting) return

    const affordable = Math.min(queued.length, remainingPoints())
    if (affordable <= 0) {
      notify(`今天的出题额度用完了（每日 ${LIMITS.dailyKnowledgePoints} 个知识点），明天再来。`)
      return
    }
    if (affordable < queued.length) {
      notify(`今天还能出 ${affordable} 个知识点，其余的先留在队列里。`)
    }
    const items = queued.slice(0, affordable)

    setSubmitting(true)
    const failedIds: number[] = []
    let added = 0
    let skipped = 0
    let rejected = 0
    let conflicts = 0
    let unsupported = 0
    let okCount = 0
    const single = items.length === 1 ? points.find((entry) => entry.id === items[0].pointId) : null
    const taskId = onTaskStart(
      single ? `为「${single.title}」出题` : `批量出题（${items.length} 个知识点）`,
    )

    try {
      for (const [index, item] of items.entries()) {
        const point = points.find((entry) => entry.id === item.pointId)
        if (!point) {
          failedIds.push(item.pointId)
          continue
        }

        onTaskUpdate(taskId, {
          label: '正在出题',
          done: index,
          total: items.length > 1 ? items.length : 0,
        })
        try {
          const existing = [...questions, ...drafts]
            .filter((entry) => entry.knowledge_point_id === point.id)
            .map((entry) => entry.stem)
          const result = await generateQuestionsForKP(point, item.counts, existing)
          skipped += result.skipped
          rejected += result.rejected
          conflicts += result.conflicts
          unsupported += result.unsupported
          if (!result.questions.length) {
            failedIds.push(item.pointId)
            continue
          }
          const rows: NewQuestion[] = result.questions.map((question) => ({
            document_id: doc.id,
            knowledge_point_id: point.id,
            type: question.type,
            stem: question.stem,
            options: question.options,
            answer: question.answer,
            explanation: question.explanation,
            evidence: question.evidence || '',
            status: 'draft',
          }))
          const created = await repo.addQuestions(rows)
          added += created.length
          okCount += 1
          setDrafts((prev) => [...prev, ...created])
        } catch {
          failedIds.push(item.pointId)
        }
      }

      setQueue((prev) => prev.filter((item) => failedIds.includes(item.pointId)))
      consumePoints(okCount)
      onTaskFinish(taskId, added ? 'done' : 'error', added ? undefined : '没有生成出新题目')

      const notes: string[] = []
      if (unsupported) notes.push(`${unsupported} 道找不到原文依据`)
      if (conflicts) notes.push(`${conflicts} 道复核答案与标注不符`)
      if (rejected) notes.push(`${rejected} 道自检不合格`)
      if (skipped) notes.push(`${skipped} 道与已有题重复`)
      const skipNote = notes.length ? `，剔除了${notes.join('、')}` : ''

      if (single) {
        notify(
          added
            ? `已为「${single.title}」生成 ${added} 道题${skipNote}。`
            : `这次没有可用的题目${skipNote}，可以稍后再试或调大题量。`,
        )
      } else {
        notify(
          added
            ? `生成 ${added} 道题${skipNote}。${
                failedIds.length ? ` 另有 ${failedIds.length} 个知识点没出成。` : ''
              }`
            : `这次没有可用的题目${skipNote}。`,
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  function generateFromQueue() {
    return runGeneration(queue)
  }

  function generateOne(item: QueueItem) {
    return runGeneration([item])
  }

  async function saveDraft(id: number, patch: QuestionPatch) {
    const updated = await repo.updateQuestion(id, patch)
    if (!updated) {
      notify('保存失败，请重试。')
      return
    }
    setDrafts((prev) => prev.map((item) => (item.id === id ? updated : item)))
    notify('已保存修改。')
  }

  async function deleteDraft(id: number) {
    const removed = await repo.deleteQuestion(id)
    if (!removed) {
      notify('删除失败，请重试。')
      return
    }
    setDrafts((prev) => prev.filter((item) => item.id !== id))
  }

  async function confirmAllDrafts() {
    if (!drafts.length) return
    setSubmitting(true)
    try {
      const ids = drafts.map((item) => item.id)
      const updated = await repo.confirmQuestions(ids)
      setQuestions((prev) => [...prev, ...updated])
      setDrafts((prev) => prev.filter((item) => !ids.includes(item.id)))
      notify(`已把 ${ids.length} 道题加入题库。`)
      setTab('questions')
    } catch (err) {
      notify(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function removeQuestion(id: number) {
    const removed = await repo.deleteQuestion(id)
    if (!removed) {
      notify('删除失败，请稍后重试。')
      return
    }
    setQuestions((prev) => prev.filter((question) => question.id !== id))
  }

  async function handleExport(exportKind: 'md' | 'docx' | 'pdf') {
    setExportOpen(false)
    if (!questions.length) {
      notify('题库里还没有题目可以导出。')
      return
    }
    const sections = buildSections(points, questions)
    const fileName = `${safeFileName(doc.title)}_知识自检题`
    try {
      if (exportKind === 'md') {
        downloadText(toMarkdown(doc.title, sections), `${fileName}.md`)
      } else if (exportKind === 'docx') {
        const blob = await exportDocx(doc.title, sections)
        downloadBlob(blob, `${fileName}.docx`)
      } else {
        printAsPdf(doc.title, sections)
      }
    } catch (err) {
      notify(`导出失败：${(err as Error).message}`)
    }
  }

  const grouped = useMemo(() => {
    const list: { point: KnowledgePoint | null; items: Question[] }[] = []
    for (const point of points) {
      const items = questions.filter((question) => question.knowledge_point_id === point.id)
      if (items.length) list.push({ point, items })
    }
    const orphans = questions.filter(
      (question) => !points.some((point) => point.id === question.knowledge_point_id),
    )
    if (orphans.length) list.push({ point: null, items: orphans })
    return list
  }, [points, questions])

  const pendingCount = queue.length + drafts.length

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand">
          <button className="icon-btn" onClick={onBack} title="返回资料库">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M14 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <Logo size={20} />
          <span className="doc-head-title">{doc.title}</span>
          {kind !== 'knowledge' && (
            <span className="kind-chip">{kind === 'mixed' ? '讲义+题库' : '题库'}</span>
          )}
        </div>
        <div className="topbar-right">
          <div className="menu-wrap">
            <button
              className="btn subtle"
              onClick={() => setExportOpen((open) => !open)}
              disabled={!questions.length}
            >
              导出
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {exportOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setExportOpen(false)} />
                <div className="menu">
                  <button onClick={() => handleExport('md')}>Markdown (.md)</button>
                  <button onClick={() => handleExport('docx')}>Word (.docx)</button>
                  <button onClick={() => handleExport('pdf')}>PDF（打印另存）</button>
                </div>
              </>
            )}
          </div>
          <button className="icon-btn" title="AI 接口设置" onClick={onOpenSettings}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            className="btn primary"
            disabled={!questions.length}
            onClick={() => setQuizOpen(true)}
          >
            开始做题
          </button>
        </div>
      </header>

      <div className="ws-body">
        <aside className="ws-side">
          <div className="side-head">
            <span className="side-title">知识点</span>
            <span className="side-count">{points.length}</span>
            {points.length > 0 && (
              <button
                className="icon-btn small"
                title="重新生成知识点"
                onClick={generatePoints}
                disabled={busy}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M20 11a8 8 0 1 0-2.3 5.6M20 5v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>

          {loading ? (
            <div className="side-loading">
              {[0, 1, 2, 3].map((key) => (
                <div className="skeleton-line" key={key} />
              ))}
            </div>
          ) : points.length === 0 ? (
            <div className="side-empty">
              <p>{kind === 'questions' ? '题库类资料不拆知识点。' : '还没有知识点。'}</p>
              {kind === 'questions' ? (
                <button className="btn subtle block" onClick={switchToKnowledge} disabled={busy}>
                  改为按知识点拆解
                </button>
              ) : (
                <button className="btn primary block" onClick={generatePoints} disabled={busy}>
                  生成知识点
                </button>
              )}
            </div>
          ) : (
            <nav className="point-list">
              {points.map((point, index) => (
                <button
                  key={point.id}
                  className={`point-item${point.id === activePoint?.id && tab === 'points' ? ' active' : ''}`}
                  onClick={() => {
                    setActiveId(point.id)
                    setTab('points')
                  }}
                >
                  <span className="point-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="point-title">{point.title}</span>
                  <span className="point-flags">
                    {queuedIds.has(point.id) && (
                      <span className="queue-dot" title="已在出题文档中" />
                    )}
                    {countsByPoint.get(point.id) ? (
                      <span className="point-badge">{countsByPoint.get(point.id)}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </nav>
          )}
        </aside>

        <section className="ws-main">
          <div className="tabbar">
            <button
              className={tab === 'points' ? 'tab active' : 'tab'}
              onClick={() => setTab('points')}
            >
              知识点详情
            </button>
            <button
              className={tab === 'drafts' ? 'tab active' : 'tab'}
              onClick={() => setTab('drafts')}
            >
              出题文档
              {pendingCount > 0 && <span className="tab-badge accent">{pendingCount}</span>}
            </button>
            <button
              className={tab === 'questions' ? 'tab active' : 'tab'}
              onClick={() => setTab('questions')}
            >
              题库 {questions.length > 0 && <span className="tab-badge">{questions.length}</span>}
            </button>
          </div>

          {tab === 'points' ? (
            activePoint ? (
              <article className="point-detail">
                <div className="point-detail-head">
                  <div>
                    <span className="eyebrow">
                      知识点 {String(points.indexOf(activePoint) + 1).padStart(2, '0')}
                    </span>
                    <h2 className="point-detail-title">{activePoint.title}</h2>
                  </div>
                  <div className="menu-wrap">
                    <button
                      className="btn primary"
                      onClick={() => {
                        setCounts(DEFAULT_COUNTS)
                        setPanel(panel === 'single' ? null : 'single')
                      }}
                      disabled={busy}
                    >
                      {queuedIds.has(activePoint.id) ? '调整出题量' : '加入出题文档'}
                    </button>
                    {panel === 'single' && (
                      <>
                        <div className="menu-backdrop" onClick={() => setPanel(null)} />
                        <CountsEditor
                          counts={counts}
                          onChange={setCounts}
                          onSubmit={() => enqueue(activePoint, counts)}
                          onCancel={() => setPanel(null)}
                          submitting={false}
                          submitLabel="加入"
                        />
                      </>
                    )}
                  </div>
                </div>

                {activePoint.summary && <p className="point-summary">{activePoint.summary}</p>}

                <div className="excerpt-head">
                  <h3>原文依据</h3>
                  <span className="excerpt-count">
                    {activePoint.excerpts.length} 段 · 均摘自导入文件
                  </span>
                </div>
                <div className="excerpts">
                  {activePoint.excerpts.map((excerpt, index) => (
                    <blockquote className="excerpt" key={index}>
                      <span className="excerpt-no">{index + 1}</span>
                      <p>{excerpt}</p>
                    </blockquote>
                  ))}
                </div>

                {countsByPoint.get(activePoint.id) ? (
                  <div className="point-footnote">
                    该知识点题库里已有 {countsByPoint.get(activePoint.id)} 道题。
                    <button className="link" onClick={() => setTab('questions')}>
                      查看题目
                    </button>
                  </div>
                ) : null}
              </article>
            ) : (
              <div className="empty tall">
                {loading ? (
                  <p className="empty-text">正在读取…</p>
                ) : kind === 'questions' ? (
                  <>
                    <p className="empty-title">这份资料被识别为「已有题库」</p>
                    <p className="empty-text">
                      题库类资料不拆知识点，抽出来的题目在「出题文档」里等你确认。如果你其实希望按知识点出题，可以改成知识内容重新拆解。
                    </p>
                    <button className="btn primary" onClick={switchToKnowledge} disabled={busy}>
                      改为按知识点拆解
                    </button>
                  </>
                ) : (
                  <>
                    <p className="empty-title">先拆出知识点</p>
                    <p className="empty-text">
                      系统会通读整份资料，把内容归纳成若干可考察的知识点，并把原文中相关的段落挂在每个知识点下。
                    </p>
                    <button className="btn primary" onClick={generatePoints} disabled={busy}>
                      开始生成
                    </button>
                  </>
                )}
              </div>
            )
          ) : tab === 'drafts' ? (
            <div className="draft-doc">
              {queue.length > 0 && (
                <section className="queue">
                  <div className="queue-head">
                    <h3>待出题的知识点</h3>
                    <span className="queue-meta">{queue.length} 个 · 可先调整题量或移除</span>
                  </div>
                  <div className="queue-list">
                    {queue.map((item) => {
                      const point = points.find((entry) => entry.id === item.pointId)
                      return (
                        <div className="queue-item" key={item.pointId}>
                          <span className="queue-title">{point?.title || '（知识点已不存在）'}</span>
                          <div className="queue-steppers">
                            {COUNT_KEYS.map((key) => (
                              <div className="mini-stepper" key={key}>
                                <span className="mini-label">{COUNT_LABEL[key]}</span>
                                <button onClick={() => adjustQueue(item.pointId, key, -1)}>−</button>
                                <span className="mini-value">{item.counts[key]}</span>
                                <button onClick={() => adjustQueue(item.pointId, key, 1)}>+</button>
                              </div>
                            ))}
                          </div>
                          <button
                            className="btn accent small"
                            onClick={() => generateOne(item)}
                            disabled={submitting || busy || !point}
                          >
                            出题
                          </button>
                          <button
                            className="icon-btn small"
                            title="从出题文档移除"
                            onClick={() => removeFromQueue(item.pointId)}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <div className="queue-actions">
                    <button className="btn subtle" onClick={() => setQueue([])}>
                      清空
                    </button>
                    <button
                      className="btn primary"
                      onClick={generateFromQueue}
                      disabled={submitting || busy}
                    >
                      {submitting ? '生成中…' : `开始出题（${queue.length} 个知识点）`}
                    </button>
                  </div>
                </section>
              )}

              <section className="draft-pool">
                <div className="queue-head">
                  <h3>待确认的题目</h3>
                  <span className="queue-meta">
                    {drafts.length ? `${drafts.length} 道 · 检查无误后加入题库` : '还没有待确认的题目'}
                  </span>
                </div>

                {drafts.length === 0 ? (
                  <div className="empty">
                    <p className="empty-title">{queue.length ? '还没开始出题' : '出题文档是空的'}</p>
                    <p className="empty-text">
                      {queue.length
                        ? '确认上面要出题的知识点和题量，点「开始出题」，题目会先落到这里，检查、删改之后再加入题库。'
                        : '在「知识点详情」里把要考察的知识点加入出题文档，这里会集中出现你要出的题。'}
                    </p>
                    {!queue.length && points.length > 0 && (
                      <button className="btn subtle" onClick={() => setTab('points')}>
                        去挑知识点
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {drafts.map((question, index) => (
                      <DraftCard
                        key={question.id}
                        question={question}
                        index={index}
                        onSave={saveDraft}
                        onDelete={deleteDraft}
                      />
                    ))}
                    <div className="draft-actions-bar">
                      <span className="queue-meta">确认后才会进入题库，可用于在线做题和导出。</span>
                      <button
                        className="btn primary"
                        onClick={confirmAllDrafts}
                        disabled={submitting}
                      >
                        全部加入题库（{drafts.length} 题）
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          ) : (
            <div className="question-bank">
              {questions.length === 0 ? (
                <div className="empty tall">
                  <p className="empty-title">题库里还没有题目</p>
                  <p className="empty-text">
                    在出题文档里确认的题目会进入这里；也可以直接为全部知识点批量出题。
                  </p>
                  <div className="empty-actions">
                    <div className="menu-wrap">
                      <button
                        className="btn primary"
                        onClick={() => {
                          setCounts(DEFAULT_COUNTS)
                          setPanel(panel === 'all' ? null : 'all')
                        }}
                        disabled={busy || !points.length}
                      >
                        为全部知识点出题
                      </button>
                      {panel === 'all' && (
                        <>
                          <div className="menu-backdrop" onClick={() => setPanel(null)} />
                          <div className="menu-pop">
                            <p className="menu-note">
                              每个知识点各出这么多题，共 {points.length} 个知识点。生成后先进入出题文档待确认。
                            </p>
                            <CountsEditor
                              counts={counts}
                              onChange={setCounts}
                              onSubmit={enqueueAll}
                              onCancel={() => setPanel(null)}
                              submitting={false}
                              submitLabel="加入"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="bank-head">
                    <h3>共 {questions.length} 题</h3>
                    <div className="menu-wrap">
                      <button
                        className="btn subtle"
                        onClick={() => {
                          setCounts(DEFAULT_COUNTS)
                          setPanel(panel === 'all' ? null : 'all')
                        }}
                        disabled={busy || !points.length}
                      >
                        继续为全部知识点出题
                      </button>
                      {panel === 'all' && (
                        <>
                          <div className="menu-backdrop" onClick={() => setPanel(null)} />
                          <div className="menu-pop">
                            <p className="menu-note">
                              每个知识点各出这么多题，共 {points.length} 个知识点。生成后先进入出题文档待确认。
                            </p>
                            <CountsEditor
                              counts={counts}
                              onChange={setCounts}
                              onSubmit={enqueueAll}
                              onCancel={() => setPanel(null)}
                              submitting={false}
                              submitLabel="加入"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {grouped.map((group) => (
                    <div className="bank-group" key={group.point?.id ?? 'orphan'}>
                      <h4 className="bank-group-title">{group.point?.title || '综合'}</h4>
                      {group.items.map((question) => (
                        <BankItem key={question.id} question={question} onDelete={removeQuestion} />
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {quizOpen && (
        <Quiz
          docTitle={doc.title}
          questions={questions}
          points={points}
          onExit={() => setQuizOpen(false)}
          notify={notify}
        />
      )}
    </div>
  )
}
