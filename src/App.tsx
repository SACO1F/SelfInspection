import { useCallback, useEffect, useRef, useState } from 'react'
import { cloud } from './cloud'
import type { Doc, DocKind } from './lib/types'
import { cloudRepo, memoryRepo, type Repo } from './lib/repo'
import {
  describeError,
  detectDocKind,
  extractExistingQuestions,
  extractKnowledgePoints,
} from './lib/llm'
import { hasCustomAI } from './lib/settings'
import { parseFile } from './lib/parseFile'
import Login from './components/Login'
import Library from './components/Library'
import Workspace from './components/Workspace'
import AISettings from './components/AISettings'
import TaskProgress, { type TaskState } from './components/TaskProgress'
import { Logo } from './components/Logo'

type ActiveDoc = Doc & { content: string }

function maskUser(session: any): string {
  const user = session?.user
  const phone: string = user?.phone || ''
  if (phone.length >= 11) return `${phone.slice(0, 3)}****${phone.slice(-4)}`
  if (user?.name) return user.name
  if (user?.email) {
    const [name, domain] = String(user.email).split('@')
    return domain ? `${name.slice(0, 3)}***@${domain}` : name
  }
  return '已登录'
}

async function restoreAuth(onError: (message: string) => void): Promise<any> {
  const url = new URL(location.href)

  if (url.searchParams.has('code') || url.searchParams.has('error')) {
    const provider = url.searchParams.get('provider')
    if (provider === 'wechat' || provider === 'workbuddy') {
      const handler =
        provider === 'workbuddy'
          ? cloud.auth.handleWorkBuddyCallback
          : cloud.auth.handleWechatWebCallback
      if (typeof handler === 'function') {
        const result: any = await handler.call(cloud.auth)
        if (result?.error) onError(result.error.message)
        if (result?.data) {
          for (const key of ['code', 'state', 'provider']) url.searchParams.delete(key)
          history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
        }
      }
    }
  }

  const { data } = await cloud.auth.getSession()
  return data || null
}

export default function App() {
  const [booting, setBooting] = useState(true)
  const [signedIn, setSignedIn] = useState(false)
  const [guest, setGuest] = useState(() => location.hash === '#guest')
  const [session, setSession] = useState<any>(null)
  const [authError, setAuthError] = useState('')
  const [docs, setDocs] = useState<Doc[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [activeDoc, setActiveDoc] = useState<ActiveDoc | null>(null)
  const [task, setTask] = useState<TaskState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [customAI, setCustomAI] = useState(() => hasCustomAI())
  const [toast, setToast] = useState<string>('')
  const toastTimer = useRef<number | null>(null)

  const repo: Repo = guest ? memoryRepo : cloudRepo

  const notify = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 6000)
  }, [])

  const loadDocs = useCallback(async () => {
    setLoadingDocs(true)
    try {
      setDocs(await repo.listDocuments())
    } catch (error) {
      notify(describeError(error))
    } finally {
      setLoadingDocs(false)
    }
  }, [repo, notify])

  useEffect(() => {
    if (location.hash === '#guest') {
      setBooting(false)
      return
    }

    let mounted = true
    ;(async () => {
      try {
        const sessionData = await restoreAuth((message) => mounted && setAuthError(message))
        if (!mounted) return
        if (sessionData) {
          setSession(sessionData)
          setSignedIn(true)
        }
      } catch (error) {
        if (mounted) setAuthError((error as Error).message)
      } finally {
        if (mounted) setBooting(false)
      }
    })()

    const unsubscribe = cloud.auth.onAuthStateChange((event: string) => {
      if (event === 'SIGNED_OUT' && mounted) {
        setSignedIn(false)
        setSession(null)
        setDocs([])
        setActiveDoc(null)
      }
    })

    return () => {
      mounted = false
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (signedIn || guest) loadDocs()
  }, [signedIn, guest, loadDocs])

  async function handleSignedIn() {
    setAuthError('')
    const { data } = await cloud.auth.getSession()
    setSession(data)
    setSignedIn(true)
  }

  function enterGuest() {
    setGuest(true)
    setSignedIn(false)
    setDocs([])
    setActiveDoc(null)
  }

  /**
   * 导入链路：解析 → 识别形态 → 落库 → 按形态直接产出（题库抽题 / 知识内容拆知识点）
   * 全程在右上角显示进度，用户不需要再手动点"生成知识点"。
   */
  async function handleUpload(file: File) {
    const title = file.name.replace(/\.[^.]+$/, '').slice(0, 120) || '未命名资料'
    try {
      setTask({ label: '正在解析文件', done: 0, total: 0 })
      const parsed = await parseFile(file)

      setTask({ label: '正在识别资料类型', done: 0, total: 0 })
      let kind: DocKind = 'knowledge'
      try {
        kind = await detectDocKind(parsed.text)
      } catch {
        kind = 'knowledge'
      }

      setTask({ label: '正在保存资料', done: 0, total: 0 })
      const created = await repo.createDocument({
        title,
        sourceType: parsed.sourceType,
        content: parsed.text,
        kind,
      })

      if (kind === 'questions') {
        try {
          const result = await extractExistingQuestions(parsed.text, (done, total) =>
            setTask({ label: '正在抽取已有题目', done, total }),
          )
          await repo.addQuestions(
            result.questions.map((question) => ({
              document_id: created.id,
              knowledge_point_id: null,
              type: question.type,
              stem: question.stem,
              options: question.options,
              answer: question.answer,
              explanation: question.explanation,
              status: 'draft' as const,
            })),
          )
          notify(
            `识别为「已有题库」，抽到 ${result.questions.length} 道题，检查确认后即可做题。${
              result.truncated ? ' 资料较长，只分析了前面部分。' : ''
            }`,
          )
        } catch (error) {
          kind = 'knowledge'
          await repo.setDocumentKind(created.id, 'knowledge')
          notify(`${describeError(error)} 已改为按知识内容处理。`)
        }
      }

      if (kind === 'knowledge') {
        try {
          const result = await extractKnowledgePoints(parsed.text, (done, total) =>
            setTask({ label: '正在拆解知识点', done, total }),
          )
          await repo.replacePoints(created.id, result.points)
          notify(
            `已自动拆出 ${result.points.length} 个知识点。${
              result.truncated ? ' 资料较长，只分析了前面部分。' : ''
            }`,
          )
        } catch (error) {
          notify(`${describeError(error)} 可以进入资料后手动重试。`)
        }
      }

      await loadDocs()
      setActiveDoc({ ...created, kind, content: parsed.text })
    } catch (error) {
      notify((error as Error).message)
    } finally {
      setTask(null)
    }
  }

  async function openDoc(id: number) {
    try {
      const detail = await repo.getDocument(id)
      if (!detail) {
        notify('打开失败，资料可能已被删除。')
        return
      }
      setActiveDoc(detail)
    } catch (error) {
      notify(describeError(error))
    }
  }

  async function deleteDoc(doc: Doc) {
    const confirmed = window.confirm(
      `删除「${doc.title}」以及它的全部知识点和题目？此操作不可撤销。`,
    )
    if (!confirmed) return
    const removed = await repo.deleteDocument(doc.id)
    if (!removed) {
      notify('删除失败，请稍后重试。')
      return
    }
    setDocs((prev) => prev.filter((item) => item.id !== doc.id))
    notify(guest ? '已删除（仅本次会话）。' : '已删除。')
  }

  async function signOut() {
    setDocs([])
    setActiveDoc(null)
    if (guest) {
      setGuest(false)
      return
    }
    await cloud.auth.signOut()
    setSignedIn(false)
    setSession(null)
  }

  if (booting) {
    return (
      <div className="splash">
        <Logo size={34} />
        <span className="splash-text">正在准备…</span>
      </div>
    )
  }

  const showApp = signedIn || guest
  const openSettings = () => setSettingsOpen(true)

  return (
    <>
      {!showApp ? (
        <Login onSignedIn={handleSignedIn} onGuest={enterGuest} initialError={authError} />
      ) : activeDoc ? (
        <Workspace
          doc={activeDoc}
          repo={repo}
          onBack={() => setActiveDoc(null)}
          onOpenSettings={openSettings}
          notify={notify}
        />
      ) : (
        <Library
          docs={docs}
          loading={loadingDocs}
          userLabel={guest ? '游客' : maskUser(session)}
          customAI={customAI}
          onOpen={openDoc}
          onUpload={handleUpload}
          onDelete={deleteDoc}
          onSignOut={signOut}
          onOpenSettings={openSettings}
        />
      )}
      <TaskProgress task={task} />
      {guest && (
        <div className="guest-badge">
          <span className="guest-dot" />
          游客模式 · 数据不保存
        </div>
      )}
      {settingsOpen && (
        <AISettings
          onClose={() => setSettingsOpen(false)}
          onSaved={(active) => {
            setCustomAI(active)
            notify(active ? '已切换到自定义模型。' : '已恢复平台内置模型。')
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
