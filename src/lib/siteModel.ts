/**
 * 站点默认模型：由站主在 server.config.json 里配置，经同源代理调用。
 *
 * 为什么不直连服务商：国内主流模型服务商的接口不放行浏览器跨域，
 * 而且把密钥放在前端等于公开。代理放在服务器上，两个问题一起解决。
 */
export interface SiteModelInfo {
  model: string
}

let cached: SiteModelInfo | null | undefined

/**
 * 分享链接的访问校验会拦截不带 sharecode 的请求，
 * 所以接口地址要从当前地址里把 sharecode 带上。
 */
function apiUrl(): string {
  const code = new URLSearchParams(location.search).get('sharecode')
  return code ? `/api/chat?sharecode=${encodeURIComponent(code)}` : '/api/chat'
}

export async function loadSiteModel(): Promise<SiteModelInfo | null> {
  if (cached !== undefined) return cached

  try {
    const response = await fetch(apiUrl(), { method: 'GET' })
    if (!response.ok) {
      cached = null
      return null
    }
    const data = await response.json()
    cached = data?.configured && data?.model ? { model: String(data.model) } : null
  } catch {
    cached = null
  }

  return cached
}

export async function chatViaSite(payload: {
  system: string
  user: string
  temperature?: number
}): Promise<string> {
  let response: Response
  try {
    response = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('连不上站点模型服务，请稍后重试。')
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(String(data?.error || `站点模型返回 ${response.status}`))
  }

  const content = String(data?.content || '')
  if (!content.trim()) throw new Error('站点模型没有返回内容，稍后重试。')
  return content
}
