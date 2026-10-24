import { useState } from 'react'
import { loadAISettings, saveAISettings } from '../lib/settings'
import { testCustomEndpoint } from '../lib/llm'

interface Props {
  onClose: () => void
  onSaved: (active: boolean) => void
}

type Status = { kind: 'ok' | 'bad' | 'info'; text: string }

export default function AISettings({ onClose, onSaved }: Props) {
  const current = loadAISettings()
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl || '')
  const [apiKey, setApiKey] = useState(current?.apiKey || '')
  const [model, setModel] = useState(current?.model || '')
  const [status, setStatus] = useState<Status | null>(null)
  const [testing, setTesting] = useState(false)

  const filled = !!(baseUrl.trim() && apiKey.trim() && model.trim())

  function collect() {
    return { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }
  }

  async function test() {
    if (!filled) {
      setStatus({ kind: 'bad', text: '接口地址、模型名称、API Key 三项都要填。' })
      return
    }
    setTesting(true)
    setStatus({ kind: 'info', text: '正在请求模型…' })
    try {
      const reply = await testCustomEndpoint(collect())
      setStatus({ kind: 'ok', text: `连接成功，模型回复：${reply}` })
    } catch (error) {
      setStatus({ kind: 'bad', text: (error as Error).message })
    } finally {
      setTesting(false)
    }
  }

  function save() {
    if (!filled) {
      setStatus({ kind: 'bad', text: '接口地址、模型名称、API Key 三项都要填。' })
      return
    }
    saveAISettings(collect())
    onSaved(true)
    onClose()
  }

  function reset() {
    saveAISettings(null)
    onSaved(false)
    onClose()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>自定义 AI 接口</h2>
        <p className="modal-sub">
          填你自己的 OpenAI 兼容接口。留空则使用平台内置模型，不需要任何密钥。
        </p>

        <div className="ai-form">
          <label className="ai-field">
            <span>接口地址</span>
            <input
              className="input"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="ai-field">
            <span>模型名称</span>
            <input
              className="input"
              placeholder="gpt-4o-mini / deepseek-chat / qwen-plus"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="ai-field">
            <span>API Key</span>
            <input
              className="input"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              spellCheck={false}
            />
          </label>

          <p className="ai-note">
            密钥只保存在这台设备的浏览器里，不上传、不入库。部分服务商禁止浏览器直连（CORS），
            那种情况只能改用平台内置模型。
          </p>

          {status && (
            <div
              className={`alert ${status.kind === 'ok' ? 'ok' : status.kind === 'bad' ? 'error' : 'info'}`}
            >
              {status.text}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn subtle" onClick={reset}>
            恢复内置模型
          </button>
          <div className="modal-actions-right">
            <button className="btn subtle" onClick={onClose}>
              取消
            </button>
            <button className="btn ghost" onClick={test} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="btn primary" onClick={save}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
