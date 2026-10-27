/**
 * 用量护栏。只约束「走平台模型」这条路径：
 * 用户配了自己的模型时，成本由他自己承担，因此所有限制都不生效。
 */
import { hasCustomAI } from './settings'

const KEY = 'zhiwei.usage.v1'

export const LIMITS = {
  /** 每日可导入的资料份数（每份最多 12 次抽取调用） */
  dailyImports: 5,
  /** 单份资料字数上限，超过说明该拆分了 */
  maxChars: 150000,
  /** 单个知识点累计题目上限——知识点就那么点内容，出太多必然是凑数 */
  maxQuestionsPerPoint: 10,
}

interface Usage {
  date: string
  imports: number
}

/** 配了自己的模型就不算平台额度 */
export function quotaEnforced(): boolean {
  return !hasCustomAI()
}

function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function readUsage(): Usage {
  const fresh: Usage = { date: todayKey(), imports: 0 }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh
    const parsed = JSON.parse(raw)
    if (parsed?.date !== fresh.date) return fresh
    return { date: fresh.date, imports: Number(parsed?.imports) || 0 }
  } catch {
    return fresh
  }
}

function writeUsage(usage: Usage) {
  try {
    localStorage.setItem(KEY, JSON.stringify(usage))
  } catch {
    /* 写不进去就算了，不让它阻断主流程 */
  }
}

/** 剩余可导入份数；走自己的模型时返回 Infinity */
export function remainingImports(): number {
  if (!quotaEnforced()) return Number.POSITIVE_INFINITY
  return Math.max(0, LIMITS.dailyImports - readUsage().imports)
}

export function consumeImport(): void {
  if (!quotaEnforced()) return
  const usage = readUsage()
  writeUsage({ ...usage, imports: usage.imports + 1 })
}
