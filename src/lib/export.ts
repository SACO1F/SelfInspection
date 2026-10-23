import type { Question, QuestionType } from './types'
import { TYPE_LABEL, LETTERS } from './types'

export interface ExportQuestion {
  index: number
  type: QuestionType
  stem: string
  options: string[]
  answer: string
  explanation: string
}

export interface ExportSection {
  title: string
  questions: ExportQuestion[]
}

export function buildSections(
  points: { id: number; title: string }[],
  questions: Question[],
): ExportSection[] {
  const sections: ExportSection[] = []
  let index = 0

  const pushSection = (title: string, list: Question[]) => {
    if (!list.length) return
    sections.push({
      title,
      questions: list.map((q) => ({
        index: ++index,
        type: q.type,
        stem: q.stem,
        options: q.options || [],
        answer: q.answer,
        explanation: q.explanation || '',
      })),
    })
  }

  for (const point of points) {
    pushSection(point.title, questions.filter((q) => q.knowledge_point_id === point.id))
  }
  const orphans = questions.filter(
    (q) => !points.some((p) => p.id === q.knowledge_point_id),
  )
  pushSection('综合', orphans)

  return sections
}

function answerText(q: ExportQuestion): string {
  if (q.type === 'choice') {
    const position = LETTERS.indexOf(q.answer)
    const option = position >= 0 ? q.options[position] : ''
    return option ? `${q.answer}. ${option}` : q.answer
  }
  return q.answer
}

function counts(sections: ExportSection[]) {
  const all = sections.flatMap((s) => s.questions)
  const by = (type: QuestionType) => all.filter((q) => q.type === type).length
  return { total: all.length, choice: by('choice'), judge: by('judge'), short: by('short') }
}

export function safeFileName(name: string): string {
  return (name || '知识自检').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

/* ----------------------------- Markdown ----------------------------- */

export function toMarkdown(docTitle: string, sections: ExportSection[]): string {
  const stats = counts(sections)
  const lines: string[] = []
  lines.push(`# ${docTitle} · 知识自检题`, '')
  lines.push(
    `共 ${stats.total} 题（选择 ${stats.choice} · 判断 ${stats.judge} · 解答 ${stats.short}）`,
    '',
  )

  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  sections.forEach((section, si) => {
    lines.push(`## ${numerals[si] || si + 1}、${section.title}`, '')
    section.questions.forEach((q) => {
      lines.push(`**${q.index}.** （${TYPE_LABEL[q.type]}）${q.stem}`)
      if (q.type === 'choice') {
        q.options.forEach((option, oi) => lines.push(`- ${LETTERS[oi]}. ${option}`))
      } else if (q.type === 'judge') {
        lines.push('- （　）对　（　）错')
      }
      lines.push('')
    })
  })

  lines.push('---', '', '## 参考答案与解析', '')
  sections.forEach((section) => {
    section.questions.forEach((q) => {
      lines.push(`**${q.index}.** 答案：${answerText(q)}`)
      if (q.explanation) lines.push(`　解析：${q.explanation}`)
      lines.push('')
    })
  })

  return lines.join('\n')
}

/* ------------------------------- HTML ------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function toPrintableHtml(docTitle: string, sections: ExportSection[]): string {
  const stats = counts(sections)
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

  const body = sections
    .map((section, si) => {
      const items = section.questions
        .map((q) => {
          const options =
            q.type === 'choice'
              ? `<ol class="options">${q.options
                  .map((option) => `<li>${escapeHtml(option)}</li>`)
                  .join('')}</ol>`
              : q.type === 'judge'
                ? '<p class="judge-line">（　　）对　　　（　　）错</p>'
                : '<div class="blank"></div><div class="blank"></div>'
          return `<div class="q"><p class="stem"><span class="no">${q.index}.</span>
            <span class="tag">${TYPE_LABEL[q.type]}</span>${escapeHtml(q.stem)}</p>${options}</div>`
        })
        .join('')
      return `<section><h2>${numerals[si] || si + 1}、${escapeHtml(section.title)}</h2>${items}</section>`
    })
    .join('')

  const answers = sections
    .flatMap((section) => section.questions)
    .map(
      (q) => `<div class="a"><p><span class="no">${q.index}.</span>答案：${escapeHtml(
        answerText(q),
      )}</p>${q.explanation ? `<p class="exp">解析：${escapeHtml(q.explanation)}</p>` : ''}</div>`,
    )
    .join('')

  return `<header>
      <h1>${escapeHtml(docTitle)}</h1>
      <p class="meta">知识自检题 · 共 ${stats.total} 题（选择 ${stats.choice} · 判断 ${stats.judge} · 解答 ${stats.short}）</p>
    </header>
    ${body}
    <section class="answer-key"><h2>参考答案与解析</h2>${answers}</section>`
}

const PRINT_CSS = `
@page { size: A4; margin: 16mm 15mm; }
* { box-sizing: border-box; }
body { font-family: "Songti SC", "SimSun", Georgia, serif; color: #1f1e1b; font-size: 11pt; line-height: 1.85; margin: 0; }
header { border-bottom: 1.5pt solid #1f1e1b; padding-bottom: 10pt; margin-bottom: 18pt; }
h1 { font-size: 20pt; margin: 0 0 6pt; font-weight: 600; letter-spacing: .5pt; }
.meta { margin: 0; color: #6b675d; font-size: 9.5pt; }
h2 { font-size: 13pt; margin: 20pt 0 10pt; font-weight: 600; border-left: 3pt solid #c96442; padding-left: 8pt; }
.q { margin-bottom: 13pt; page-break-inside: avoid; }
.stem { margin: 0 0 4pt; text-align: justify; }
.no { font-weight: 700; margin-right: 6pt; }
.tag { font-size: 8.5pt; color: #8a5a3b; border: .6pt solid #d8b9a6; border-radius: 3pt; padding: 0 4pt; margin-right: 6pt; }
.options { list-style: none; padding: 0 0 0 18pt; margin: 0; }
.options li { margin: 2pt 0; }
.options { counter-reset: option; }
.options li::before { counter-increment: option; content: counter(option, upper-alpha) ". "; color: #6b675d; margin-right: 4pt; }
.judge-line { margin: 4pt 0 0 18pt; color: #4a4740; }
.blank { border-bottom: .6pt dashed #c9c4b6; height: 16pt; margin: 6pt 18pt 0; }
.answer-key { page-break-before: always; }
.answer-key h2 { border-left-color: #4f7a5b; }
.a { margin-bottom: 8pt; page-break-inside: avoid; }
.a p { margin: 0; }
.exp { color: #55524a; font-size: 9.5pt; padding-left: 18pt; }
`

export function printAsPdf(docTitle: string, sections: ExportSection[]) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  document.body.appendChild(iframe)

  const win = iframe.contentWindow
  if (!win) return
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(
    docTitle,
  )}</title><style>${PRINT_CSS}</style></head><body>${toPrintableHtml(
    docTitle,
    sections,
  )}</body></html>`

  win.document.open()
  win.document.write(html)
  win.document.close()

  window.setTimeout(() => {
    try {
      win.focus()
      win.print()
    } finally {
      window.setTimeout(() => iframe.remove(), 1500)
    }
  }, 400)
}

/* ------------------------------- DOCX ------------------------------- */

export async function exportDocx(docTitle: string, sections: ExportSection[]): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const stats = counts(sections)
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  const children: any[] = []

  children.push(
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: docTitle, bold: true, size: 40 })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `知识自检题 · 共 ${stats.total} 题（选择 ${stats.choice} · 判断 ${stats.judge} · 解答 ${stats.short}）`,
          size: 19,
          color: '6B675D',
        }),
      ],
    }),
  )

  for (const [si, section] of sections.entries()) {
    children.push(
      new Paragraph({
        spacing: { before: 280, after: 140 },
        children: [
          new TextRun({
            text: `${numerals[si] || si + 1}、${section.title}`,
            bold: true,
            size: 28,
          }),
        ],
      }),
    )

    for (const q of section.questions) {
      children.push(
        new Paragraph({
          spacing: { before: 140, after: 60 },
          children: [
            new TextRun({ text: `${q.index}. `, bold: true }),
            new TextRun({ text: `【${TYPE_LABEL[q.type]}】`, color: '8A5A3B' }),
            new TextRun({ text: q.stem }),
          ],
        }),
      )

      if (q.type === 'choice') {
        q.options.forEach((option, oi) => {
          children.push(
            new Paragraph({
              indent: { left: 420 },
              spacing: { after: 30 },
              children: [new TextRun({ text: `${LETTERS[oi]}. ${option}` })],
            }),
          )
        })
      } else if (q.type === 'judge') {
        children.push(
          new Paragraph({
            indent: { left: 420 },
            children: [new TextRun({ text: '（　　）对　　（　　）错', color: '4A4740' })],
          }),
        )
      } else {
        children.push(new Paragraph({ text: '' }), new Paragraph({ text: '' }))
      }
    }
  }

  children.push(new Paragraph({ pageBreakBefore: true, children: [] }))
  children.push(
    new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: '参考答案与解析', bold: true, size: 30 })],
    }),
  )

  for (const section of sections) {
    for (const q of section.questions) {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 20 },
          children: [
            new TextRun({ text: `${q.index}. `, bold: true }),
            new TextRun({ text: `答案：${answerText(q)}` }),
          ],
        }),
      )
      if (q.explanation) {
        children.push(
          new Paragraph({
            indent: { left: 300 },
            spacing: { after: 60 },
            children: [
              new TextRun({ text: `解析：${q.explanation}`, size: 20, color: '55524A' }),
            ],
          }),
        )
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Microsoft YaHei', size: 22 } },
      },
    },
    sections: [{ children }],
  })

  return Packer.toBlob(doc)
}

/* ------------------------------ 下载 ------------------------------ */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadText(text: string, filename: string, mime = 'text/markdown;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename)
}
