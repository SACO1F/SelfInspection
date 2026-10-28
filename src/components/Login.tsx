import { useEffect, useRef, useState } from 'react'
import { cloud } from '../cloud'

interface Props {
  onSignedIn: () => void
  onGuest: () => void
  initialError?: string
}

export default function Login({ onSignedIn, onGuest, initialError }: Props) {
  const [tab, setTab] = useState<'phone' | 'wechat'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState(initialError || '')
  const [pending, setPending] = useState<{
    phone: string
    verificationId: string
    isExistingUser: boolean
  } | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [])

  function startCountdown() {
    setCountdown(60)
    if (timer.current) window.clearInterval(timer.current)
    timer.current = window.setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          if (timer.current) window.clearInterval(timer.current)
          return 0
        }
        return value - 1
      })
    }, 1000)
  }

  async function sendCode() {
    if (!/^1\d{10}$/.test(phone)) {
      setPhoneError('请输入正确的 11 位手机号')
      return
    }
    setPhoneError('')
    setError('')
    setSending(true)
    try {
      const sent = await cloud.auth.sendOtp({ phone })
      if (sent.error) {
        setError(sent.error.message)
        return
      }
      setPending({
        phone,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      })
      startCountdown()
    } finally {
      setSending(false)
    }
  }

  async function submit() {
    if (!pending || pending.phone !== phone) {
      setError('请先获取当前手机号的验证码')
      return
    }
    if (!/^\d{4,8}$/.test(code.trim())) {
      setError('请输入收到的验证码')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const completed = await cloud.auth.verifyOtp({
        phone: pending.phone,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: code.trim(),
      })
      if (completed.error) {
        setError(completed.error.message)
        return
      }
      setPending(null)
      onSignedIn()
    } finally {
      setSubmitting(false)
    }
  }

  async function wechatLogin() {
    setError('')
    const { data, error: oauthError } = await cloud.auth.signInWithOAuth({
      provider: 'wechat',
      redirectTo: location.origin,
    })
    if (oauthError) {
      setError(oauthError.message)
      return
    }
    location.assign(data.url)
  }

  return (
    <div className="auth-page">
      <div className="auth-ornament" aria-hidden="true" />
      <div className="auth-card">
        <div className="brand">
          <span className="brand-name">知微</span>
        </div>
        <h1 className="auth-title">把一份资料，变成一场自检</h1>
        <p className="auth-sub">
          导入 PDF、Word 或 Markdown，自动梳理知识点，按知识点出题，做完立刻知道哪儿没掌握。
        </p>

        <div className="auth-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'phone'}
            className={tab === 'phone' ? 'tab active' : 'tab'}
            onClick={() => setTab('phone')}
          >
            手机号
          </button>
          <button
            role="tab"
            aria-selected={tab === 'wechat'}
            className={tab === 'wechat' ? 'tab active' : 'tab'}
            onClick={() => setTab('wechat')}
          >
            微信扫码
          </button>
        </div>

        {tab === 'phone' ? (
          <div className="auth-form">
            <label className="field">
              <span className="field-label">手机号</span>
              <div className="field-row">
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="11 位手机号"
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value.replace(/\D/g, '').slice(0, 11))
                    setPhoneError('')
                    setError('')
                  }}
                />
                <button
                  type="button"
                  className="btn ghost"
                  disabled={countdown > 0 || sending}
                  onClick={sendCode}
                >
                  {countdown > 0 ? `${countdown}s` : sending ? '发送中' : '获取验证码'}
                </button>
              </div>
              {phoneError && <span className="field-error">{phoneError}</span>}
            </label>

            <label className="field">
              <span className="field-label">验证码</span>
              <input
                className="input"
                inputMode="numeric"
                placeholder="短信验证码"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 8))
                  setError('')
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                }}
              />
            </label>

            <button className="btn primary block" disabled={submitting} onClick={submit}>
              {submitting ? '登录中…' : '登录 / 注册'}
            </button>
            <p className="auth-hint">未注册的手机号验证后将自动创建账号，无需设置密码。</p>
          </div>
        ) : (
          <div className="auth-form">
            <button className="btn primary block" onClick={wechatLogin}>
              使用微信扫码登录
            </button>
            <p className="auth-hint">
              微信登录需要在已发布的域名下使用；本地预览环境无法完成授权回调。
            </p>
          </div>
        )}

        {error && <div className="alert error">{error}</div>}

        <button type="button" className="guest-entry" onClick={onGuest}>
          游客体验
        </button>
      </div>
    </div>
  )
}
