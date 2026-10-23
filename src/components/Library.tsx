import { useRef, useState } from 'react'
import type { Doc } from '../lib/types'
import { Logo } from './Logo'

interface Props {
  docs: Doc[]
  loading: boolean
  userLabel: string
  onOpen: (id: number) => void
  onUpload: (file: File) => void
  onDelete: (doc: Doc) => void
  onSignOut: () => void
  busy: string
}

const SOURCE_LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word',
  markdown: 'Markdown',
  txt: 'TXT',
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

export default function Library({
  docs,
  loading,
  userLabel,
  onOpen,
  onUpload,
  onDelete,
  onSignOut,
  busy,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function pick(files: FileList | null) {
    const file = files?.[0]
    if (file) onUpload(file)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo size={22} />
          <span className="brand-name">知微</span>
          <span className="brand-divider" />
          <span className="brand-section">资料库</span>
        </div>
        <div className="topbar-right">
          <span className="user-chip">{userLabel}</span>
          <button className="btn subtle" onClick={onSignOut}>
            退出
          </button>
        </div>
      </header>

      <main className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">我的资料</h1>
            <p className="page-sub">
              每一份导入的资料都会拆成知识点，再按知识点出题——先看全貌，再针对薄弱处练习。
            </p>
          </div>
        </div>

        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            pick(event.dataTransfer.files)
          }}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.md,.markdown,.txt"
            hidden
            onChange={(event) => {
              pick(event.target.files)
              event.target.value = ''
            }}
          />
          <div className="dropzone-inner">
            <div className="dropzone-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
              </svg>
            </div>
            <p className="dropzone-title">
              {busy || '拖入文件，或点击选择'}
            </p>
            <p className="dropzone-hint">支持 PDF、Word(.docx)、Markdown、TXT，单份不超过 20MB</p>
          </div>
        </div>

        {loading ? (
          <div className="skeleton-list">
            {[0, 1, 2].map((key) => (
              <div className="skeleton-card" key={key} />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="empty">
            <p className="empty-title">还没有资料</p>
            <p className="empty-text">先把课件、笔记或讲义放进来，剩下的交给它。</p>
          </div>
        ) : (
          <div className="doc-grid">
            {docs.map((doc) => (
              <article className="doc-card" key={doc.id}>
                <button className="doc-card-main" onClick={() => onOpen(doc.id)}>
                  <div className="doc-tags">
                    <div className="doc-tag">{SOURCE_LABEL[doc.source_type] || doc.source_type}</div>
                    {doc.kind === 'questions' && <div className="doc-tag accent">题库</div>}
                  </div>
                  <h3 className="doc-title">{doc.title}</h3>
                  <p className="doc-meta">
                    {doc.char_count.toLocaleString()} 字 · {formatDate(doc.created_at)}
                  </p>
                </button>
                <button
                  className="doc-delete"
                  title="删除"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(doc)
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M5 7h14M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" />
                  </svg>
                </button>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
