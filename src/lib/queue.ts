import type { QuestionCounts } from './types'

export interface QueueItem {
  pointId: number
  counts: QuestionCounts
}

const PREFIX = 'zhiwei.queue.'

/** 出题文档的待出题队列按资料存在本地，退出再进来仍是原来的样子 */
export function loadQueue(documentId: number): QueueItem[] {
  try {
    const raw = localStorage.getItem(PREFIX + documentId)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item: any) => ({
        pointId: Number(item?.pointId),
        counts: {
          choice: Number(item?.counts?.choice) || 0,
          judge: Number(item?.counts?.judge) || 0,
          short: Number(item?.counts?.short) || 0,
        },
      }))
      .filter((item) => Number.isFinite(item.pointId) && item.pointId > 0)
  } catch {
    return []
  }
}

export function saveQueue(documentId: number, queue: QueueItem[]) {
  try {
    if (!queue.length) localStorage.removeItem(PREFIX + documentId)
    else localStorage.setItem(PREFIX + documentId, JSON.stringify(queue))
  } catch {
    /* 隐私模式下可能写入失败，忽略 */
  }
}
