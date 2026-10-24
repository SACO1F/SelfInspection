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
import TaskStack, { type TaskItem } from './components/TaskProgress'
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
  const [tasks, setTasks] = useState<TaskItem[]>([])
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

  const loadDocs = useCallback(
    async (silent = false) => {
      if (!silent) setLoadingDocs(true)
      try {
        setDocs(await repo.listDocuments())
      } catch (error) {
        notify(describeError(error))
      } finally {
        if (!silent) setLoadingDocs(false)
      }
    },
    [repo, notify],
  )

  const updateTask = useCallback((id: string, patch: Partial<TaskItem>) => {
    setTasks((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const dropTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((item) => item.id !== id))
  }, [])

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
   * 单个文件的导入链路：解析 → 识别形态 → 落库 → 按形态直接产出
   * 每个文件独立成一个任务卡片，多个文件可以同时进行。
   */
  async function importOne(file: File, taskId: string): Promise<ActiveDoc | null> {
    const title = file.name.replace(/\.[^.]+$/, '').slice(0, 120) || '未命名资料'
    try {
      updateTask(taskId, { label: '正在解析文件', done: 0, total: 0 })
      const parsed = await parseFile(file)

      updateTask(taskId, { label: '正在识别资料类型', done: 0, total: 0 })
      let kind: DocKind = 'knowledge'
      try {
        kind = await detectDocKind(parsed.text)
      } catch {
        kind = 'knowledge'
      }

      updateTask(taskId, { label: '正在保存资料', done: 0, total: 0 })
      const created = await repo.createDocument({
        title,
        sourceType: parsed.sourceType,
        content: parsed.text,
        kind,
      })
      updateTask(taskId, { docId: created.id })
      await loadDocs(true)

      if (kind === 'questions') {
        try {
          const result = await extractExistingQuestions(parsed.text, (done, total) =>
            updateTask(taskId, { label: '正在抽取已有题目', done, total }),
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
            updateTask(taskId, { label: '正在拆解知识点', done, total }),
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

      updateTask(taskId, { status: 'done', label: '已完成' })
      window.setTimeout(() => dropTask(taskId), 1600)
      return { ...created, kind, content: parsed.text }
    } catch (error) {
      const message = (error as Error).message
      updateTask(taskId, { status: 'error', label: '导入失败', error: message })
      window.setTimeout(() => dropTask(taskId), 6000)
      notify(message)
      return null
    }
  }

  async function handleUpload(files: File[]) {
    if (!files.length) return
    const stamp = Date.now()
    const items: TaskItem[] = files.map((file, index) => ({
      id: `${stamp}-${index}`,
      title: file.name,
      label: '正在准备',
      done: 0,
      total: 0,
      status: 'working',
    }))
    setTasks((prev) => [...items, ...prev])

    const results = await Promise.all(files.map((file, index) => importOne(file, items[index].id)))
    await loadDocs(true)

    const ready = results.filter((item): item is ActiveDoc => !!item)
    if (files.length === 1 && ready.length === 1) {
      setActiveDoc(ready[0])
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
          key={activeDoc.id}
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
          tasks={tasks}
          onOpen={openDoc}
          onUpload={handleUpload}
          onDelete={deleteDoc}
          onSignOut={signOut}
          onOpenSettings={openSettings}
        />
      )}
      <TaskStack tasks={tasks} />
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
