import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./dist', import.meta.url))
const port = Number(process.env.PORT) || 3000

let config = null
try {
  config = JSON.parse(await readFile(new URL('./server.config.json', import.meta.url), 'utf8'))
} catch {
  config = null
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/* ---------------------------- 按 IP 限流 ---------------------------- */

const LIMITS = {
  perMinute: Number(config?.rateLimit?.perMinute) || 30,
  perDay: Number(config?.rateLimit?.perDay) || 500,
}

/** ip → { minuteWindow, minuteCount, dayWindow, dayCount } */
const hits = new Map()

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return forwarded || req.socket?.remoteAddress || 'unknown'
}

function takeQuota(ip) {
  const now = Date.now()
  const minuteWindow = Math.floor(now / 60000)
  const dayWindow = Math.floor(now / 86400000)

  const row = hits.get(ip) || { minuteWindow, minuteCount: 0, dayWindow, dayCount: 0 }
  if (row.minuteWindow !== minuteWindow) {
    row.minuteWindow = minuteWindow
    row.minuteCount = 0
  }
  if (row.dayWindow !== dayWindow) {
    row.dayWindow = dayWindow
    row.dayCount = 0
  }

  const overMinute = row.minuteCount >= LIMITS.perMinute
  const overDay = row.dayCount >= LIMITS.perDay
  if (!overMinute && !overDay) {
    row.minuteCount += 1
    row.dayCount += 1
  }
  hits.set(ip, row)

  // 防止 Map 无限增长
  if (hits.size > 2000) {
    for (const [key, value] of hits) {
      if (value.dayWindow !== dayWindow) hits.delete(key)
    }
  }

  return {
    allowed: !overMinute && !overDay,
    minuteLeft: Math.max(0, LIMITS.perMinute - row.minuteCount),
    dayLeft: Math.max(0, LIMITS.perDay - row.dayCount),
    overDay,
  }
}

function peekQuota(ip) {
  const now = Date.now()
  const minuteWindow = Math.floor(now / 60000)
  const dayWindow = Math.floor(now / 86400000)
  const row = hits.get(ip)
  if (!row) return { minuteLeft: LIMITS.perMinute, dayLeft: LIMITS.perDay }
  return {
    minuteLeft:
      row.minuteWindow === minuteWindow
        ? Math.max(0, LIMITS.perMinute - row.minuteCount)
        : LIMITS.perMinute,
    dayLeft:
      row.dayWindow === dayWindow ? Math.max(0, LIMITS.perDay - row.dayCount) : LIMITS.perDay,
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 同源代理：浏览器只和本站打交道，第三方模型的密钥留在服务器上。
 * 这既绕开了服务商的 CORS 限制，也不会把密钥发到访客的浏览器。
 */
async function proxyChat(req, res) {
  if (!config?.upstream || !config?.apiKey || !config?.model) {
    sendJson(res, 503, { error: '站点没有配置模型。' })
    return
  }

  try {
    const payload = JSON.parse(await readBody(req))
    const system = [config.systemPrefix, payload.system].filter(Boolean).join('\n\n')

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: String(payload.user || '') },
      ],
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.4,
    }
    // GLM-4.5 系列支持关闭思考，能显著降低延迟与 token
    if (config.disableThinking) body.thinking = { type: 'disabled' }

    const upstream = await fetch(`${String(config.upstream).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    const data = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      const detail =
        data?.error?.message || data?.message || `上游返回 ${upstream.status}`
      sendJson(res, upstream.status, { error: String(detail).slice(0, 300) })
      return
    }

    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      sendJson(res, 502, { error: '模型没有返回文本内容，换个模型或稍后重试。' })
      return
    }
    sendJson(res, 200, { content })
  } catch (error) {
    sendJson(res, 502, { error: error?.message || '代理请求失败。' })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/api/chat') {
    const ip = clientIp(req)

    if (req.method === 'GET') {
      sendJson(res, 200, {
        configured: Boolean(config?.model),
        model: config?.model || '',
        limit: LIMITS,
        remaining: peekQuota(ip),
      })
      return
    }

    if (req.method === 'POST') {
      const quota = takeQuota(ip)
      if (!quota.allowed) {
        sendJson(res, 429, {
          error: quota.overDay
            ? '这个网络今天的额度用完了，明天再来。'
            : '请求太频繁了，等几秒再试。',
          remaining: { minute: quota.minuteLeft, day: quota.dayLeft },
        })
        return
      }
      await proxyChat(req, res)
      return
    }

    res.writeHead(405).end()
    return
  }

  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  const filePath = normalize(join(root, pathname))
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const info = await stat(filePath)
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath
    const content = await readFile(target)
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' })
    res.end(content)
  } catch {
    // 单页应用：未知路径回落到首页
    try {
      const content = await readFile(join(root, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(content)
    } catch {
      res.writeHead(404).end('Not Found')
    }
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`serving on ${port}${config?.model ? ` · model ${config.model}` : ' · no model configured'}`)
})
