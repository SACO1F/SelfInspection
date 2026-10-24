/**
 * 用户自带的 OpenAI 兼容接口配置。
 * 只存在本机 localStorage，不上传、不入库——API Key 属于用户私有凭据。
 */
export interface AISettings {
  baseUrl: string
  apiKey: string
  model: string
}

const STORAGE_KEY = 'zhiwei.ai.endpoint'

export function loadAISettings(): AISettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const baseUrl = String(parsed?.baseUrl || '').trim()
    const apiKey = String(parsed?.apiKey || '').trim()
    const model = String(parsed?.model || '').trim()
    if (!baseUrl || !apiKey || !model) return null
    return { baseUrl, apiKey, model }
  } catch {
    return null
  }
}

export function saveAISettings(settings: AISettings | null) {
  try {
    if (settings) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 隐私模式下写入可能失败，忽略即可 */
  }
}

export function hasCustomAI(): boolean {
  return !!loadAISettings()
}
