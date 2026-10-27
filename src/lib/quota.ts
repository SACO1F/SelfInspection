/**
 * 用量护栏。目的只有一个：别让陌生人的一次导入把额度烧穿。
 * 计数存在浏览器本地——清缓存能绕过，但对早期小范围试用够用。
 */
const KEY = 'zhiwei.usage.v1'

export const LIMITS = {
  /** 每日可导入的资料份数（每份最多 12 次抽取调用） */
  dailyImports: 3,
  /** 每日可出题的知识点数（每个最多 4 次调用） */
  dailyKnowledgePoints: 15,
  /** 单份资料字数上限，超过说明该拆分了 */
  maxChars: 150000,
}

interface Usage {
  date: string
  imports: number
  points: number
}

function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function readUsage(): Usage {
  const fresh: Usage = { date: todayKey(), imports: 0, points: 0 }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh
    const parsed = JSON.parse(raw)
    if (parsed?.date !== fresh.date) return fresh
    return {
      date: fresh.date,
      imports: Number(parsed?.imports) || 0,
      points: Number(parsed?.points) || 0,
    }
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

export function remainingImports(): number {
  return Math.max(0, LIMITS.dailyImports - readUsage().imports)
}

export function remainingPoints(): number {
  return Math.max(0, LIMITS.dailyKnowledgePoints - readUsage().points)
}

export function consumeImport(): void {
  const usage = readUsage()
  writeUsage({ ...usage, imports: usage.imports + 1 })
}

export function consumePoints(count: number): void {
  if (count <= 0) return
  const usage = readUsage()
  writeUsage({ ...usage, points: usage.points + count })
}
