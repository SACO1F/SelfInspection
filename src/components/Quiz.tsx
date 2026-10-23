import { useMemo, useRef, useState } from 'react'
import type { KnowledgePoint, Question } from '../lib/types'
import { TYPE_LABEL, LETTERS } from '../lib/types'
import { gradeShortAnswers, describeError } from '../lib/llm'

interface Props {
  docTitle: string
  questions: Question[]
  points: KnowledgePoint[]
  onExit: () => void
  notify: (message: string) => void
}

interface ResultRow {
  score: number
  comment: string
}

function verdict(score: number): { label: string; tone: string } {
  if (score >= 85) return { label: '掌握得不错', tone: 'good' }
  if (score >= 70) return { label: '大体掌握', tone: 'ok' }
  if (score >= 60) return { label: '刚好及格', tone: 'warn' }
  return { label: '需要回头再看', tone: 'bad' }
}

export default function Quiz({ docTitle, questions, points, onExit, notify }: Props) {
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [results, setResults] = useState<Record<number, ResultRow> | null>(null)
  const [grading, setGrading] = useState(false)
  const [startedAt] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  const scrollTop = () => bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' })

  const pointTitle = useMemo(() => {
    const map = new Map<number, string>()
    for (const point of points) map.set(point.id, point.title)
    return map
  }, [points])

  const answeredCount = questions.filter((question) => (answers[question.id] || '').trim()).length

  const summary = useMemo(() => {
    if (!results) return null
    const total = questions.reduce((sum, question) => sum + (results[question.id]?.score || 0), 0)
    const score = Math.round((total / questions.length) * 100)
    const correct = questions.filter((question) => (results[question.id]?.score || 0) >= 0.999).length
    return { score, correct, ...verdict(score) }
  }, [results, questions])

  function setAnswer(id: number, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }

  async function submit() {
    if (answeredCount < questions.length) {
      const confirmed = window.confirm(
        `还有 ${questions.length - answeredCount} 题未作答，未作答按 0 分计。确定提交吗？`,
      )
      if (!confirmed) return
    }

    setGrading(true)
    const next: Record<number, ResultRow> = {}

    for (const question of questions) {
      if (question.type === 'choice' || question.type === 'judge') {
        const correct = (answers[question.id] || '').trim() === question.answer
        next[question.id] = { score: correct ? 1 : 0, comment: '' }
      }
    }

    const shortOnes = questions.filter((question) => question.type === 'short')
    if (shortOnes.length) {
      try {
        const graded = await gradeShortAnswers(
          shortOnes.map((question) => ({
            id: question.id,
            stem: question.stem,
            reference: question.answer,
            student: answers[question.id] || '',
          })),
        )
        for (const question of shortOnes) {
          const row = graded.get(question.id)
          next[question.id] = {
            score: row ? Math.max(0, Math.min(1, row.score / 100)) : 0,
            comment: row?.comment || '',
          }
        }
      } catch (err) {
        for (const question of shortOnes) {
          next[question.id] = { score: 0, comment: '自动批改失败，请对照参考答案自行评估。' }
        }
        notify(describeError(err))
      }
    }

    setResults(next)
    setElapsed(Math.round((Date.now() - startedAt) / 1000))
    setGrading(false)
    scrollTop()
  }

  function retry() {
    setAnswers({})
    setResults(null)
    setElapsed(0)
    scrollTop()
  }

  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60

  return (
    <div className="quiz">
      <header className="quiz-head">
        <div className="quiz-head-left">
          <span className="quiz-eyebrow">{results ? '批改结果' : '在线自检'}</span>
          <span className="quiz-title">{docTitle}</span>
        </div>
        <button className="btn subtle" onClick={onExit}>
          {results ? '返回题目' : '退出'}
        </button>
      </header>

      <div className="quiz-body" ref={bodyRef}>
        {summary && (
          <section className={`score-card ${summary.tone}`}>
            <div className="score-main">
              <span className="score-value">{summary.score}</span>
              <span className="score-unit">分</span>
            </div>
            <div className="score-meta">
              <p className="score-verdict">{summary.label}</p>
              <p className="score-detail">
                完全答对 {summary.correct} / {questions.length} 题
                {elapsed > 0 && ` · 用时 ${minutes} 分 ${seconds} 秒`}
              </p>
            </div>
          </section>
        )}

        <div className="quiz-list">
          {questions.map((question, index) => {
            const row = results?.[question.id]
            const userAnswer = (answers[question.id] || '').trim()
            const state = !row ? '' : row.score >= 0.999 ? 'right' : row.score > 0 ? 'partial' : 'wrong'

            return (
              <article className={`quiz-item ${state}`} key={question.id}>
                <div className="quiz-item-head">
                  <span className="quiz-no">{String(index + 1).padStart(2, '0')}</span>
                  <div className="quiz-item-meta">
                    <span className="type-chip">{TYPE_LABEL[question.type]}</span>
                    {question.knowledge_point_id != null && pointTitle.get(question.knowledge_point_id) && (
                      <span className="quiz-point">{pointTitle.get(question.knowledge_point_id)}</span>
                    )}
                  </div>
                  {row && (
                    <span className={`quiz-flag ${state}`}>
                      {state === 'right' ? '正确' : state === 'partial' ? `得 ${Math.round(row.score * 100)}%` : '错误'}
                    </span>
                  )}
                </div>

                <p className="quiz-stem">{question.stem}</p>

                {question.type === 'choice' && (
                  <div className="quiz-options">
                    {question.options.map((option, oi) => {
                      const letter = LETTERS[oi]
                      const selected = userAnswer === letter
                      const isAnswer = question.answer === letter
                      const className = [
                        'quiz-option',
                        selected ? 'selected' : '',
                        results && isAnswer ? 'is-answer' : '',
                        results && selected && !isAnswer ? 'is-wrong' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                      return (
                        <label className={className} key={oi}>
                          <input
                            type="radio"
                            name={`q-${question.id}`}
                            checked={selected}
                            disabled={!!results}
                            onChange={() => setAnswer(question.id, letter)}
                          />
                          <span className="option-letter">{letter}</span>
                          <span className="option-text">{option}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                {question.type === 'judge' && (
                  <div className="quiz-options inline">
                    {['对', '错'].map((option) => {
                      const selected = userAnswer === option
                      const isAnswer = question.answer === option
                      const className = [
                        'quiz-option',
                        'judge',
                        selected ? 'selected' : '',
                        results && isAnswer ? 'is-answer' : '',
                        results && selected && !isAnswer ? 'is-wrong' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                      return (
                        <label className={className} key={option}>
                          <input
                            type="radio"
                            name={`q-${question.id}`}
                            checked={selected}
                            disabled={!!results}
                            onChange={() => setAnswer(question.id, option)}
                          />
                          <span className="option-text">{option}</span>
                        </label>
                      )
                    })}
                  </div>
                )}

                {question.type === 'short' && (
                  results ? (
                    <div className="short-review">
                      <div className="short-block">
                        <span className="short-label">你的作答</span>
                        <p>{userAnswer || '（未作答）'}</p>
                      </div>
                      <div className="short-block reference">
                        <span className="short-label">参考答案</span>
                        <p>{question.answer}</p>
                      </div>
                      {row?.comment && (
                        <div className="short-block comment">
                          <span className="short-label">AI 点评</span>
                          <p>{row.comment}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <textarea
                      className="short-input"
                      rows={4}
                      placeholder="用自己的话作答，评委按要点覆盖度给分…"
                      value={answers[question.id] || ''}
                      onChange={(event) => setAnswer(question.id, event.target.value)}
                    />
                  )
                )}

                {results && question.explanation && (
                  <div className="quiz-explain">
                    <span className="explain-label">解析</span>
                    <p>{question.explanation}</p>
                  </div>
                )}

                {results && question.type !== 'short' && (
                  <p className="quiz-answerline">
                    正确答案 <strong>{question.answer}</strong>
                    {question.type === 'choice' &&
                      question.options[LETTERS.indexOf(question.answer)] &&
                      ` · ${question.options[LETTERS.indexOf(question.answer)]}`}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      </div>

      <footer className="quiz-foot">
        {results ? (
          <>
            <div className="foot-summary">
              <span className="foot-score">{summary?.score}</span>
              <span className="foot-label">分 · {summary?.label}</span>
            </div>
            <div className="foot-actions">
              <button className="btn subtle" onClick={onExit}>
                返回题目
              </button>
              <button className="btn primary" onClick={retry}>
                再做一遍
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="foot-summary">
              <span className="foot-progress">
                已答 {answeredCount} / {questions.length}
              </span>
              <div className="foot-track">
                <div
                  className="foot-track-fill"
                  style={{ width: `${questions.length ? (answeredCount / questions.length) * 100 : 0}%` }}
                />
              </div>
            </div>
            <button className="btn primary" onClick={submit} disabled={grading}>
              {grading ? '正在批改…' : '提交并查看解析'}
            </button>
          </>
        )}
      </footer>
    </div>
  )
}
