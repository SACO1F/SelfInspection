import { useEffect, useMemo, useState } from 'react'
import type { Doc, DocKind, KnowledgePoint, Question, QuestionCounts } from '../lib/types'
import { TYPE_LABEL, LETTERS } from '../lib/types'
import type { Repo, NewQuestion, QuestionPatch } from '../lib/repo'
import { extractKnowledgePoints, generateQuestionsForKP, describeError } from '../lib/llm'
import {
  buildSections,
  toMarkdown,
  printAsPdf,
  exportDocx,
  downloadBlob,
  downloadText,
  safeFileName,
} from '../lib/export'
import { Logo } from './Logo'
import Quiz from './Quiz'

interface Props {
  doc: Doc & { content: string }
  repo: Repo
  onBack: () => void
  notify: (message: string) => void
}

type Tab = 'points' | 'drafts' | 'questions'

interface QueueItem {
  pointId: number
  counts: QuestionCounts
}

const DEFAULT_COUNTS: QuestionCounts = { choice: 3, judge: 2, short: 1 }
const COUNT_KEYS: (keyof QuestionCounts)[] = ['choice', 'judge', 'short']
const COUNT_LABEL: Record<keyof QuestionCounts, string> = {
  choice: '选择',
  judge: '判断',
  short: '解答',
}

function CountsEditor({
  counts,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
}: {
  counts: QuestionCounts
  onChange: (counts: QuestionCounts) => void
  onSubmit: () => void
  onCancel: () => void
  submitting: boolean
  submitLabel: string
}) {
  const total = counts.choice + counts.judge + counts.short

  return (
    <div className="counts-panel">
      {COUNT_KEYS.map((key) => (
        <div className="counts-row" key={key}>
          <span className="counts-label">{COUNT_LABEL[key]}题</span>
          <div className="stepper">
            <button
              type="button"
              onClick={() => onChange({ ...counts, [key]: Math.max(0, counts[key] - 1) })}
              disabled={counts[key] <= 0}
            >
              −
            </button>
            <span className="stepper-value">{counts[key]}</span>
            <button
              type="button"
              onClick={() => onChange({ ...counts, [key]: Math.min(10, counts[key] + 1) })}
              disabled={counts[key] >= 10}
            >
              +
            </button>
          </div>
        </div>
      ))}
      <div className="counts-actions">
        <button className="btn subtle" onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" disabled={submitting || total === 0} onClick={onSubmit}>
          {submitting ? '处理中…' : `${submitLabel}（${total} 题）`}
        </button>
      </div>
    </div>
  )
}

function DraftCard({
  question,
  index,
  onSave,
  onDelete,
}: {
  question: Question
  index: number
  onSave: (id: number, patch: QuestionPatch) => Promise<void>
  onDelete: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [stem, setStem] = useState(question.stem)
  const [options, setOptions] = useState<string[]>(question.options)
  const [answer, setAnswer] = useState(question.answer)
  const [explanation, setExplanation] = useState(question.explanation)
  const [saving, setSaving] = useState(false)

  function reset() {
    setStem(question.stem)
    setOptions(question.options)
    setAnswer(question.answer)
    setExplanation(question.explanation)
  }

  async function save() {
    if (!stem.trim()) return
    setSaving(true)
    await onSave(question.id, {
      stem: stem.trim(),
      options: question.type === 'choice' ? options.map((item) => item.trim()) : [],
      answer: answer.trim(),
      explanation: explanation.trim(),
    })
    setSaving(false)
    setEditing(false)
  }

  return (
    <article className="draft-card">
      <div className="draft-head">
        <span className="quiz-no">{String(index + 1).padStart(2, '0')}</span>
        <span className="type-chip">{TYPE_LABEL[question.type]}</span>
        <div className="draft-actions">
          {editing ? (
            <>
              <button
                className="text-btn"
                onClick={() => {
                  reset()
                  setEditing(false)
                }}
              >
                取消
              </button>
              <button className="btn primary small" onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <>
              <button className="text-btn" onClick={() => setEditing(true)}>
                编辑
              </button>
              <button className="text-btn danger" onClick={() => onDelete(question.id)}>
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="draft-edit">
          <label className="draft-field">
            <span>题干</span>
            <textarea rows={3} value={stem} onChange={(event) => setStem(event.target.value)} />
          </label>

          {question.type === 'choice' && (
            <div className="draft-field">
              <span>选项</span>
              <div className="draft-options">
                {options.map((option, oi) => (
                  <label className="draft-option" key={oi}>
                    <span className="option-letter">{LETTERS[oi]}</span>
                    <input
                      value={option}
                      onChange={(event) => {
                        const next = [...options]
                        next[oi] = event.target.value
                        setOptions(next)
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="draft-field">
            <span>{question.type === 'judge' ? '答案' : '参考答案 / 答案'}</span>
            {question.type === 'choice' ? (
              <div className="answer-picker">
                {options.map((_, oi) => (
                  <button
                    key={oi}
                    type="button"
                    className={answer === LETTERS[oi] ? 'answer-chip active' : 'answer-chip'}
                    onClick={() => setAnswer(LETTERS[oi])}
                  >
                    {LETTERS[oi]}
                  </button>
                ))}
              </div>
            ) : question.type === 'judge' ? (
              <div className="answer-picker">
                {['对', '错'].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={answer === option ? 'answer-chip active' : 'answer-chip'}
                    onClick={() => setAnswer(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <textarea rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} />
            )}
          </label>

          <label className="draft-field">
            <span>解析</span>
            <textarea
              rows={2}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <>
          <p className="draft-stem">{question.stem}</p>
          {question.type === 'choice' && (
            <ul className="bank-options">
              {question.options.map((option, oi) => (
                <li key={oi} className={LETTERS[oi] === question.answer ? 'right' : ''}>
                  <span>{LETTERS[oi]}</span>
                  {option}
                </li>
              ))}
            </ul>
          )}
          <div className="bank-answer">
            <span className="bank-answer-label">答案</span>
            {question.type === 'choice'
              ? `${question.answer}. ${question.options[LETTERS.indexOf(question.answer)] || ''}`
              : question.answer}
          </div>
          {question.explanation && <p className="bank-explain">{question.explanation}</p>}
        </>
      )}
    </article>
  )
}

export default function Workspace({ doc, repo, onBack, notify }: Props) {
  const [kind, setKind] = useState<DocKind>(doc.kind)
  const [points, setPoints] = useState<KnowledgePoint[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [drafts, setDrafts] = useState<Question[]>([])
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>(doc.kind === 'questions' ? 'drafts' : 'points')
  const [activeId, setActiveId] = useState<number | null>(null)
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(
    null,
  )
  const [exportOpen, setExportOpen] = useState(false)
  const [panel, setPanel] = useState<null | 'single' | 'all'>(null)
  const [counts, setCounts] = useState<QuestionCounts>(DEFAULT_COUNTS)
  const [submitting, setSubmitting] = useState(false)
  const [quizOpen, setQuizOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const [loadedPoints, loadedConfirmed, loadedDrafts] = await Promise.all([
          repo.listPoints(doc.id),
          repo.listQuestions(doc.id, 'confirmed'),
          repo.listQuestions(doc.id, 'draft'),
        ])
        if (cancelled) return
        setPoints(loadedPoints)
        setQuestions(loadedConfirmed)
        setDrafts(loadedDrafts)
        setActiveId(loadedPoints[0]?.id ?? null)
      } catch (err) {
        if (!cancelled) notify(describeError(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc.id, repo, notify])

  const activePoint = useMemo(
    () => points.find((point) => point.id === activeId) || points[0] || null,
    [points, activeId],
  )

  const countsByPoint = useMemo(() => {
    const map = new Map<number, number>()
    for (const question of questions) {
      if (question.knowledge_point_id == null) continue
      map.set(question.knowledge_point_id, (map.get(question.knowledge_point_id) || 0) + 1)
    }
    return map
  }, [questions])

  const queuedIds = useMemo(() => new Set(queue.map((item) => item.pointId)), [queue])

  async function generatePoints() {
    if (points.length) {
      const confirmed = window.confirm('重新生成会删除现有知识点和与之关联的题目，确定继续吗？')
      if (!confirmed) return
    }
    setProgress({ label: '正在通读资料并拆解知识点', done: 0, total: 0 })
    try {
      const result = await extractKnowledgePoints(doc.content, (done, total) =>
        setProgress({ label: '正在通读资料并拆解知识点', done, total }),
      )
      const created = await repo.replacePoints(doc.id, result.points)
      setPoints(created)
      setQuestions([])
      setDrafts([])
      setQueue([])
      setActiveId(created[0]?.id ?? null)
      setTab('points')
      notify(
        result.truncated
          ? `已生成 ${created.length} 个知识点。资料较长，本次只分析了前 ${Math.round(
              result.analyzedChars / 1000,
            )} 千字。`
          : `已生成 ${created.length} 个知识点。`,
      )
    } catch (err) {
      notify(describeError(err))
    } finally {
      setProgress(null)
    }
  }

  async function switchToKnowledge() {
    setKind('knowledge')
    await repo.setDocumentKind(doc.id, 'knowledge')
    notify('已切换为「知识内容」，开始拆解知识点…')
    await generatePoints()
  }

  /* --------------------------- 出题文档队列 --------------------------- */

  function enqueue(point: KnowledgePoint, pointCounts: QuestionCounts) {
    setQueue((prev) => {
      const index = prev.findIndex((item) => item.pointId === point.id)
      if (index >= 0) {
        const next = [...prev]
        next[index] = { pointId: point.id, counts: pointCounts }
        return next
      }
      return [...prev, { pointId: point.id, counts: pointCounts }]
    })
    setPanel(null)
    setTab('drafts')
    notify(`已加入出题文档：${point.title}`)
  }

  function enqueueAll() {
    setQueue(points.map((point) => ({ pointId: point.id, counts })))
    setPanel(null)
    setTab('drafts')
    notify(`已把 ${points.length} 个知识点加入出题文档。`)
  }

  function adjustQueue(pointId: number, key: keyof QuestionCounts, delta: number) {
    setQueue((prev) =>
      prev.map((item) =>
        item.pointId === pointId
          ? {
              ...item,
              counts: {
                ...item.counts,
                [key]: Math.max(0, Math.min(10, item.counts[key] + delta)),
              },
            }
          : item,
      ),
    )
  }

  function removeFromQueue(pointId: number) {
    setQueue((prev) => prev.filter((item) => item.pointId !== pointId))
  }

  async function generateFromQueue() {
    if (!queue.length) return
    setSubmitting(true)
    const failedIds: number[] = []
    let added = 0

    try {
      for (const [index, item] of queue.entries()) {
        const point = points.find((entry) => entry.id === item.pointId)
        if (!point) continue

        setProgress({ label: `正在为「${point.title}」出题`, done: index, total: queue.length })
        try {
          const generated = await generateQuestionsForKP(point, item.counts)
          if (!generated.length) {
            failedIds.push(item.pointId)
            continue
          }
          const rows: NewQuestion[] = generated.map((question) => ({
            document_id: doc.id,
            knowledge_point_id: point.id,
            type: question.type,
            stem: question.stem,
            options: question.options,
            answer: question.answer,
            explanation: question.explanation,
            status: 'draft',
          }))
          const created = await repo.addQuestions(rows)
          added += created.length
          setDrafts((prev) => [...prev, ...created])
        } catch {
          failedIds.push(item.pointId)
        }
      }

      setQueue((prev) => prev.filter((item) => failedIds.includes(item.pointId)))
      notify(
        added
          ? `生成 ${added} 道题，已放入出题文档，检查后再加入题库。${
              failedIds.length ? `另有 ${failedIds.length} 个知识点失败。` : ''
            }`
          : '这次没有生成出新题目，可以调整一下题量再试。',
      )
    } finally {
      setProgress(null)
      setSubmitting(false)
    }
  }

  async function saveDraft(id: number, patch: QuestionPatch) {
    const updated = await repo.updateQuestion(id, patch)
    if (!updated) {
      notify('保存失败，请重试。')
      return
    }
    setDrafts((prev) => prev.map((item) => (item.id === id ? updated : item)))
    notify('已保存修改。')
  }

  async function deleteDraft(id: number) {
    const removed = await repo.deleteQuestion(id)
    if (!removed) {
      notify('删除失败，请重试。')
      return
    }
    setDrafts((prev) => prev.filter((item) => item.id !== id))
  }

  async function confirmAllDrafts() {
    if (!drafts.length) return
    setSubmitting(true)
    try {
      const ids = drafts.map((item) => item.id)
      const updated = await repo.confirmQuestions(ids)
      setQuestions((prev) => [...prev, ...updated])
      setDrafts((prev) => prev.filter((item) => !ids.includes(item.id)))
      notify(`已把 ${ids.length} 道题加入题库。`)
      setTab('questions')
    } catch (err) {
      notify(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function removeQuestion(id: number) {
    const removed = await repo.deleteQuestion(id)
    if (!removed) {
      notify('删除失败，请稍后重试。')
      return
    }
    setQuestions((prev) => prev.filter((question) => question.id !== id))
  }

  async function handleExport(exportKind: 'md' | 'docx' | 'pdf') {
    setExportOpen(false)
    if (!questions.length) {
      notify('题库里还没有题目可以导出。')
      return
    }
    const sections = buildSections(points, questions)
    const fileName = `${safeFileName(doc.title)}_知识自检题`
    try {
      if (exportKind === 'md') {
        downloadText(toMarkdown(doc.title, sections), `${fileName}.md`)
      } else if (exportKind === 'docx') {
        const blob = await exportDocx(doc.title, sections)
        downloadBlob(blob, `${fileName}.docx`)
      } else {
        printAsPdf(doc.title, sections)
      }
    } catch (err) {
      notify(`导出失败：${(err as Error).message}`)
    }
  }

  const grouped = useMemo(() => {
    const list: { point: KnowledgePoint | null; items: Question[] }[] = []
    for (const point of points) {
      const items = questions.filter((question) => question.knowledge_point_id === point.id)
      if (items.length) list.push({ point, items })
    }
    const orphans = questions.filter(
      (question) => !points.some((point) => point.id === question.knowledge_point_id),
    )
    if (orphans.length) list.push({ point: null, items: orphans })
    return list
  }, [points, questions])

  const pendingCount = queue.length + drafts.length

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand">
          <button className="icon-btn" onClick={onBack} title="返回资料库">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M14 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <Logo size={20} />
          <span className="doc-head-title">{doc.title}</span>
          {kind === 'questions' && <span className="kind-chip">题库</span>}
        </div>
        <div className="topbar-right">
          <div className="menu-wrap">
            <button
              className="btn subtle"
              onClick={() => setExportOpen((open) => !open)}
              disabled={!questions.length}
            >
              导出
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {exportOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setExportOpen(false)} />
                <div className="menu">
                  <button onClick={() => handleExport('md')}>Markdown (.md)</button>
                  <button onClick={() => handleExport('docx')}>Word (.docx)</button>
                  <button onClick={() => handleExport('pdf')}>PDF（打印另存）</button>
                </div>
              </>
            )}
          </div>
          <button
            className="btn primary"
            disabled={!questions.length}
            onClick={() => setQuizOpen(true)}
          >
            开始做题
          </button>
        </div>
      </header>

      {progress && (
        <div className="progress-bar">
          <div className="progress-inner">
            <span className="spinner" />
            <span className="progress-label">{progress.label}</span>
            {progress.total > 0 && (
              <span className="progress-count">
                {progress.done}/{progress.total}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="ws-body">
        <aside className="ws-side">
          <div className="side-head">
            <span className="side-title">知识点</span>
            <span className="side-count">{points.length}</span>
            {points.length > 0 && (
              <button
                className="icon-btn small"
                title="重新生成知识点"
                onClick={generatePoints}
                disabled={!!progress}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M20 11a8 8 0 1 0-2.3 5.6M20 5v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>

          {loading ? (
            <div className="side-loading">
              {[0, 1, 2, 3].map((key) => (
                <div className="skeleton-line" key={key} />
              ))}
            </div>
          ) : points.length === 0 ? (
            <div className="side-empty">
              <p>{kind === 'questions' ? '题库类资料不拆知识点。' : '还没有知识点。'}</p>
              {kind === 'questions' ? (
                <button className="btn subtle block" onClick={switchToKnowledge} disabled={!!progress}>
                  改为按知识点拆解
                </button>
              ) : (
                <button className="btn primary block" onClick={generatePoints} disabled={!!progress}>
                  生成知识点
                </button>
              )}
            </div>
          ) : (
            <nav className="point-list">
              {points.map((point, index) => (
                <button
                  key={point.id}
                  className={`point-item${point.id === activePoint?.id && tab === 'points' ? ' active' : ''}`}
                  onClick={() => {
                    setActiveId(point.id)
                    setTab('points')
                  }}
                >
                  <span className="point-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="point-title">{point.title}</span>
                  <span className="point-flags">
                    {queuedIds.has(point.id) && (
                      <span className="queue-dot" title="已在出题文档中" />
                    )}
                    {countsByPoint.get(point.id) ? (
                      <span className="point-badge">{countsByPoint.get(point.id)}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </nav>
          )}
        </aside>

        <section className="ws-main">
          <div className="tabbar">
            <button
              className={tab === 'points' ? 'tab active' : 'tab'}
              onClick={() => setTab('points')}
            >
              知识点详情
            </button>
            <button
              className={tab === 'drafts' ? 'tab active' : 'tab'}
              onClick={() => setTab('drafts')}
            >
              出题文档
              {pendingCount > 0 && <span className="tab-badge accent">{pendingCount}</span>}
            </button>
            <button
              className={tab === 'questions' ? 'tab active' : 'tab'}
              onClick={() => setTab('questions')}
            >
              题库 {questions.length > 0 && <span className="tab-badge">{questions.length}</span>}
            </button>
          </div>

          {tab === 'points' ? (
            activePoint ? (
              <article className="point-detail">
                <div className="point-detail-head">
                  <div>
                    <span className="eyebrow">
                      知识点 {String(points.indexOf(activePoint) + 1).padStart(2, '0')}
                    </span>
                    <h2 className="point-detail-title">{activePoint.title}</h2>
                  </div>
                  <div className="menu-wrap">
                    <button
                      className="btn primary"
                      onClick={() => {
                        setCounts(DEFAULT_COUNTS)
                        setPanel(panel === 'single' ? null : 'single')
                      }}
                      disabled={!!progress}
                    >
                      {queuedIds.has(activePoint.id) ? '调整出题量' : '加入出题文档'}
                    </button>
                    {panel === 'single' && (
                      <>
                        <div className="menu-backdrop" onClick={() => setPanel(null)} />
                        <CountsEditor
                          counts={counts}
                          onChange={setCounts}
                          onSubmit={() => enqueue(activePoint, counts)}
                          onCancel={() => setPanel(null)}
                          submitting={false}
                          submitLabel="加入"
                        />
                      </>
                    )}
                  </div>
                </div>

                {activePoint.summary && <p className="point-summary">{activePoint.summary}</p>}

                <div className="excerpt-head">
                  <h3>原文依据</h3>
                  <span className="excerpt-count">
                    {activePoint.excerpts.length} 段 · 均摘自导入文件
                  </span>
                </div>
                <div className="excerpts">
                  {activePoint.excerpts.map((excerpt, index) => (
                    <blockquote className="excerpt" key={index}>
                      <span className="excerpt-no">{index + 1}</span>
                      <p>{excerpt}</p>
                    </blockquote>
                  ))}
                </div>

                {countsByPoint.get(activePoint.id) ? (
                  <div className="point-footnote">
                    该知识点题库里已有 {countsByPoint.get(activePoint.id)} 道题。
                    <button className="link" onClick={() => setTab('questions')}>
                      查看题目
                    </button>
                  </div>
                ) : null}
              </article>
            ) : (
              <div className="empty tall">
                {loading ? (
                  <p className="empty-text">正在读取…</p>
                ) : kind === 'questions' ? (
                  <>
                    <p className="empty-title">这份资料被识别为「已有题库」</p>
                    <p className="empty-text">
                      题库类资料不拆知识点，抽出来的题目在「出题文档」里等你确认。如果你其实希望按知识点出题，可以改成知识内容重新拆解。
                    </p>
                    <button className="btn primary" onClick={switchToKnowledge} disabled={!!progress}>
                      改为按知识点拆解
                    </button>
                  </>
                ) : (
                  <>
                    <p className="empty-title">先拆出知识点</p>
                    <p className="empty-text">
                      系统会通读整份资料，把内容归纳成若干可考察的知识点，并把原文中相关的段落挂在每个知识点下。
                    </p>
                    <button className="btn primary" onClick={generatePoints} disabled={!!progress}>
                      开始生成
                    </button>
                  </>
                )}
              </div>
            )
          ) : tab === 'drafts' ? (
            <div className="draft-doc">
              {queue.length > 0 && (
                <section className="queue">
                  <div className="queue-head">
                    <h3>待出题的知识点</h3>
                    <span className="queue-meta">{queue.length} 个 · 可先调整题量或移除</span>
                  </div>
                  <div className="queue-list">
                    {queue.map((item) => {
                      const point = points.find((entry) => entry.id === item.pointId)
                      return (
                        <div className="queue-item" key={item.pointId}>
                          <span className="queue-title">{point?.title || '（知识点已不存在）'}</span>
                          <div className="queue-steppers">
                            {COUNT_KEYS.map((key) => (
                              <div className="mini-stepper" key={key}>
                                <span className="mini-label">{COUNT_LABEL[key]}</span>
                                <button onClick={() => adjustQueue(item.pointId, key, -1)}>−</button>
                                <span className="mini-value">{item.counts[key]}</span>
                                <button onClick={() => adjustQueue(item.pointId, key, 1)}>+</button>
                              </div>
                            ))}
                          </div>
                          <button
                            className="icon-btn small"
                            title="从出题文档移除"
                            onClick={() => removeFromQueue(item.pointId)}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <div className="queue-actions">
                    <button className="btn subtle" onClick={() => setQueue([])}>
                      清空
                    </button>
                    <button
                      className="btn primary"
                      onClick={generateFromQueue}
                      disabled={submitting || !!progress}
                    >
                      {submitting ? '生成中…' : `开始出题（${queue.length} 个知识点）`}
                    </button>
                  </div>
                </section>
              )}

              <section className="draft-pool">
                <div className="queue-head">
                  <h3>待确认的题目</h3>
                  <span className="queue-meta">
                    {drafts.length ? `${drafts.length} 道 · 检查无误后加入题库` : '还没有待确认的题目'}
                  </span>
                </div>

                {drafts.length === 0 ? (
                  <div className="empty">
                    <p className="empty-title">{queue.length ? '还没开始出题' : '出题文档是空的'}</p>
                    <p className="empty-text">
                      {queue.length
                        ? '确认上面要出题的知识点和题量，点「开始出题」，题目会先落到这里，检查、删改之后再加入题库。'
                        : '在「知识点详情」里把要考察的知识点加入出题文档，这里会集中出现你要出的题。'}
                    </p>
                    {!queue.length && points.length > 0 && (
                      <button className="btn subtle" onClick={() => setTab('points')}>
                        去挑知识点
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {drafts.map((question, index) => (
                      <DraftCard
                        key={question.id}
                        question={question}
                        index={index}
                        onSave={saveDraft}
                        onDelete={deleteDraft}
                      />
                    ))}
                    <div className="draft-actions-bar">
                      <span className="queue-meta">确认后才会进入题库，可用于在线做题和导出。</span>
                      <button
                        className="btn primary"
                        onClick={confirmAllDrafts}
                        disabled={submitting}
                      >
                        全部加入题库（{drafts.length} 题）
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          ) : (
            <div className="question-bank">
              {questions.length === 0 ? (
                <div className="empty tall">
                  <p className="empty-title">题库里还没有题目</p>
                  <p className="empty-text">
                    在出题文档里确认的题目会进入这里；也可以直接为全部知识点批量出题。
                  </p>
                  <div className="empty-actions">
                    <div className="menu-wrap">
                      <button
                        className="btn primary"
                        onClick={() => {
                          setCounts(DEFAULT_COUNTS)
                          setPanel(panel === 'all' ? null : 'all')
                        }}
                        disabled={!!progress || !points.length}
                      >
                        为全部知识点出题
                      </button>
                      {panel === 'all' && (
                        <>
                          <div className="menu-backdrop" onClick={() => setPanel(null)} />
                          <div className="menu-pop">
                            <p className="menu-note">
                              每个知识点各出这么多题，共 {points.length} 个知识点。生成后先进入出题文档待确认。
                            </p>
                            <CountsEditor
                              counts={counts}
                              onChange={setCounts}
                              onSubmit={enqueueAll}
                              onCancel={() => setPanel(null)}
                              submitting={false}
                              submitLabel="加入"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="bank-head">
                    <h3>共 {questions.length} 题</h3>
                    <div className="menu-wrap">
                      <button
                        className="btn subtle"
                        onClick={() => {
                          setCounts(DEFAULT_COUNTS)
                          setPanel(panel === 'all' ? null : 'all')
                        }}
                        disabled={!!progress || !points.length}
                      >
                        继续为全部知识点出题
                      </button>
                      {panel === 'all' && (
                        <>
                          <div className="menu-backdrop" onClick={() => setPanel(null)} />
                          <div className="menu-pop">
                            <p className="menu-note">
                              每个知识点各出这么多题，共 {points.length} 个知识点。生成后先进入出题文档待确认。
                            </p>
                            <CountsEditor
                              counts={counts}
                              onChange={setCounts}
                              onSubmit={enqueueAll}
                              onCancel={() => setPanel(null)}
                              submitting={false}
                              submitLabel="加入"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {grouped.map((group) => (
                    <div className="bank-group" key={group.point?.id ?? 'orphan'}>
                      <h4 className="bank-group-title">{group.point?.title || '综合'}</h4>
                      {group.items.map((question) => (
                        <div className="bank-item" key={question.id}>
                          <div className="bank-item-head">
                            <span className="type-chip">{TYPE_LABEL[question.type]}</span>
                            <span className="bank-stem">{question.stem}</span>
                            <button
                              className="icon-btn small"
                              title="删除此题"
                              onClick={() => removeQuestion(question.id)}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                          {question.type === 'choice' && (
                            <ul className="bank-options">
                              {question.options.map((option, oi) => (
                                <li key={oi} className={LETTERS[oi] === question.answer ? 'right' : ''}>
                                  <span>{LETTERS[oi]}</span>
                                  {option}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="bank-answer">
                            <span className="bank-answer-label">答案</span>
                            {question.type === 'choice'
                              ? `${question.answer}. ${
                                  question.options[LETTERS.indexOf(question.answer)] || ''
                                }`
                              : question.answer}
                          </div>
                          {question.explanation && (
                            <p className="bank-explain">{question.explanation}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {quizOpen && (
        <Quiz
          docTitle={doc.title}
          questions={questions}
          points={points}
          onExit={() => setQuizOpen(false)}
          notify={notify}
        />
      )}
    </div>
  )
}
