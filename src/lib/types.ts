export type QuestionType = 'choice' | 'judge' | 'short'

/** knowledge = 纯知识内容；questions = 纯题库；mixed = 既有讲义又有题目 */
export type DocKind = 'knowledge' | 'questions' | 'mixed'

export type QuestionStatus = 'draft' | 'confirmed'

export interface Doc {
  id: number
  title: string
  source_type: string
  char_count: number
  created_at: string
  kind: DocKind
}

export interface KnowledgePoint {
  id: number
  document_id: number
  title: string
  summary: string
  excerpts: string[]
  order_index: number
}

export interface Question {  id: number
  document_id: number
  knowledge_point_id: number | null
  type: QuestionType
  stem: string
  options: string[]
  answer: string
  explanation: string
  status: QuestionStatus
  /** 支撑该题的原文片段，用于溯源 */
  evidence: string
}

export interface QuestionCounts {
  choice: number
  judge: number
  short: number
}

/** 一次作答记录，用于统计掌握度 */
export interface Attempt {
  id: number
  document_id: number
  question_id: number
  knowledge_point_id: number | null
  type: QuestionType
  is_correct: boolean
  score: number
  chosen: string
  created_at: string
}

export type NewAttempt = Omit<Attempt, 'id' | 'created_at'>

export const TYPE_LABEL: Record<QuestionType, string> = {
  choice: '选择题',
  judge: '判断题',
  short: '解答题',
}

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']
