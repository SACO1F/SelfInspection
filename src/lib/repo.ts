import { cloud } from '../cloud'
import type { Doc, DocKind, KnowledgePoint, Question, QuestionStatus } from './types'

export type DocWithContent = Doc & { content: string }

export interface NewPoint {
  title: string
  summary: string
  excerpts: string[]
}

export type NewQuestion = Omit<Question, 'id'>

export type QuestionPatch = Partial<
  Pick<Question, 'stem' | 'options' | 'answer' | 'explanation'>
>

export interface Repo {
  listDocuments(): Promise<Doc[]>
  getDocument(id: number): Promise<DocWithContent | null>
  createDocument(input: {
    title: string
    sourceType: string
    content: string
    kind: DocKind
  }): Promise<DocWithContent>
  setDocumentKind(id: number, kind: DocKind): Promise<void>
  deleteDocument(id: number): Promise<boolean>
  listPoints(documentId: number): Promise<KnowledgePoint[]>
  replacePoints(documentId: number, points: NewPoint[]): Promise<KnowledgePoint[]>
  listQuestions(documentId: number, status: QuestionStatus): Promise<Question[]>
  addQuestions(rows: NewQuestion[]): Promise<Question[]>
  updateQuestion(id: number, patch: QuestionPatch): Promise<Question | null>
  confirmQuestions(ids: number[]): Promise<Question[]>
  deleteQuestion(id: number): Promise<boolean>
}

export function normalizePoint(row: any): KnowledgePoint {
  return {
    id: row.id,
    document_id: row.document_id,
    title: row.title,
    summary: row.summary || '',
    excerpts: Array.isArray(row.excerpts) ? row.excerpts : [],
    order_index: row.order_index || 0,
  }
}

export function normalizeQuestion(row: any): Question {
  return {
    id: row.id,
    document_id: row.document_id,
    knowledge_point_id: row.knowledge_point_id ?? null,
    type: row.type,
    stem: row.stem,
    options: Array.isArray(row.options) ? row.options : [],
    answer: row.answer,
    explanation: row.explanation || '',
    status: row.status === 'draft' ? 'draft' : 'confirmed',
  }
}

function toPayload(row: NewQuestion) {
  return {
    document_id: row.document_id,
    knowledge_point_id: row.knowledge_point_id,
    type: row.type,
    stem: row.stem,
    options: row.options,
    answer: row.answer,
    explanation: row.explanation,
    status: row.status,
  }
}

/* ---------------------------- 云端实现 ---------------------------- */

export const cloudRepo: Repo = {
  async listDocuments() {
    const { data, error } = await cloud.database
      .from('documents')
      .select('id,title,source_type,char_count,created_at,kind')
      .order('created_at', { ascending: false })
    if (error) throw new Error('读取资料列表失败，请刷新重试。')
    return (data || []) as Doc[]
  },

  async getDocument(id) {
    const { data, error } = await cloud.database
      .from('documents')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error || !data) return null
    return data as DocWithContent
  },

  async createDocument({ title, sourceType, content, kind }) {
    const { data, error } = await cloud.database
      .from('documents')
      .insert({
        title,
        source_type: sourceType,
        content,
        char_count: content.length,
        kind,
      })
      .select()
    if (error) throw new Error(error.message)
    const created = (data || [])[0]
    if (!created) throw new Error('保存失败，请重试。')
    return created as DocWithContent
  },

  async setDocumentKind(id, kind) {
    await cloud.database.from('documents').update({ kind }).eq('id', id).select()
  },

  async deleteDocument(id) {
    const { data, error } = await cloud.database.from('documents').delete().eq('id', id).select()
    return !error && !!(data || []).length
  },

  async listPoints(documentId) {
    const { data, error } = await cloud.database
      .from('knowledge_points')
      .select('*')
      .eq('document_id', documentId)
      .order('order_index', { ascending: true })
    if (error) throw new Error('读取知识点失败。')
    return (data || []).map(normalizePoint)
  },

  async replacePoints(documentId, points) {
    await cloud.database.from('questions').delete().eq('document_id', documentId).select()
    await cloud.database.from('knowledge_points')
      .delete()
      .eq('document_id', documentId)
      .select()
    if (!points.length) return []

    const rows = points.map((point, index) => ({
      document_id: documentId,
      title: point.title,
      summary: point.summary,
      excerpts: point.excerpts,
      order_index: index,
    }))
    const { data, error } = await cloud.database.from('knowledge_points').insert(rows).select()
    if (error) throw new Error(error.message)
    return (data || []).map(normalizePoint).sort((a, b) => a.order_index - b.order_index)
  },

  async listQuestions(documentId, status) {
    const { data, error } = await cloud.database
      .from('questions')
      .select('*')
      .eq('document_id', documentId)
      .eq('status', status)
      .order('id', { ascending: true })
    if (error) throw new Error('读取题目失败。')
    return (data || []).map(normalizeQuestion)
  },

  async addQuestions(rows) {
    if (!rows.length) return []
    const { data, error } = await cloud.database.from('questions').insert(rows.map(toPayload)).select()
    if (error) throw new Error(error.message)
    return (data || []).map(normalizeQuestion)
  },

  async updateQuestion(id, patch) {
    const { data, error } = await cloud.database
      .from('questions')
      .update(patch)
      .eq('id', id)
      .select()
    if (error) return null
    const row = (data || [])[0]
    return row ? normalizeQuestion(row) : null
  },

  async confirmQuestions(ids) {
    if (!ids.length) return []
    const { data, error } = await cloud.database
      .from('questions')
      .update({ status: 'confirmed' })
      .in('id', ids)
      .select()
    if (error) throw new Error(error.message)
    return (data || []).map(normalizeQuestion)
  },

  async deleteQuestion(id) {
    const { data, error } = await cloud.database.from('questions').delete().eq('id', id).select()
    return !error && !!(data || []).length
  },
}

/* ---------------------------- 游客实现 ---------------------------- */

/**
 * 游客模式的数据全部留在本机 localStorage：
 * 刷新、关标签页、下次再打开都还在，但不会同步到其它设备。
 */
const STORAGE_KEY = 'zhiwei.guest.v1'

interface GuestSnapshot {
  documents: DocWithContent[]
  points: KnowledgePoint[]
  questions: Question[]
  seq: { doc: number; point: number; question: number }
}

function emptySnapshot(): GuestSnapshot {
  return { documents: [], points: [], questions: [], seq: { doc: 0, point: 0, question: 0 } }
}

function loadSnapshot(): GuestSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptySnapshot()
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.documents)) return emptySnapshot()
    return {
      documents: parsed.documents,
      points: Array.isArray(parsed.points) ? parsed.points : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      seq: {
        doc: Number(parsed?.seq?.doc) || 0,
        point: Number(parsed?.seq?.point) || 0,
        question: Number(parsed?.seq?.question) || 0,
      },
    }
  } catch {
    return emptySnapshot()
  }
}

const memory = loadSnapshot()

function flush() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory))
  } catch {
    throw new Error('浏览器本地存储已满，删掉几份资料后再试。')
  }
}

export const guestRepo: Repo = {
  async listDocuments() {
    return [...memory.documents]
      .sort((a, b) => b.id - a.id)
      .map(({ content, ...rest }) => rest)
  },

  async getDocument(id) {
    return memory.documents.find((doc) => doc.id === id) || null
  },

  async createDocument({ title, sourceType, content, kind }) {
    const created: DocWithContent = {
      id: ++memory.seq.doc,
      title,
      source_type: sourceType,
      char_count: content.length,
      created_at: new Date().toISOString(),
      kind,
      content,
    }
    memory.documents.push(created)
    flush()
    return created
  },

  async setDocumentKind(id, kind) {
    const target = memory.documents.find((doc) => doc.id === id)
    if (target) target.kind = kind
    flush()
  },

  async deleteDocument(id) {
    const existed = memory.documents.some((doc) => doc.id === id)
    memory.documents = memory.documents.filter((doc) => doc.id !== id)
    memory.points = memory.points.filter((point) => point.document_id !== id)
    memory.questions = memory.questions.filter((question) => question.document_id !== id)
    flush()
    return existed
  },

  async listPoints(documentId) {
    return memory.points
      .filter((point) => point.document_id === documentId)
      .sort((a, b) => a.order_index - b.order_index)
  },

  async replacePoints(documentId, points) {
    memory.questions = memory.questions.filter((question) => question.document_id !== documentId)
    memory.points = memory.points.filter((point) => point.document_id !== documentId)

    const created = points.map((point, index) => ({
      id: ++memory.seq.point,
      document_id: documentId,
      title: point.title,
      summary: point.summary,
      excerpts: point.excerpts,
      order_index: index,
    }))
    memory.points.push(...created)
    flush()
    return created
  },

  async listQuestions(documentId, status) {
    return memory.questions.filter(
      (question) => question.document_id === documentId && question.status === status,
    )
  },

  async addQuestions(rows) {
    const created = rows.map((row) => ({ ...toPayload(row), id: ++memory.seq.question }))
    memory.questions.push(...created)
    flush()
    return created
  },

  async updateQuestion(id, patch) {
    const target = memory.questions.find((question) => question.id === id)
    if (!target) return null
    Object.assign(target, patch)
    flush()
    return target
  },

  async confirmQuestions(ids) {
    const updated: Question[] = []
    for (const question of memory.questions) {
      if (ids.includes(question.id)) {
        question.status = 'confirmed'
        updated.push(question)
      }
    }
    flush()
    return updated
  },

  async deleteQuestion(id) {
    const existed = memory.questions.some((question) => question.id === id)
    memory.questions = memory.questions.filter((question) => question.id !== id)
    flush()
    return existed
  },
}
