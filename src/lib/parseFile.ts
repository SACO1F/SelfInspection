import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let pdfjsPromise: Promise<any> | null = null

/** pdf.js 体积较大，只有真正导入 PDF 时才加载 */
function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((lib: any) => {
      lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      return lib
    })
  }
  return pdfjsPromise
}

export const ACCEPT = '.pdf,.docx,.md,.markdown,.txt'
const MAX_BYTES = 20 * 1024 * 1024

export interface ParsedDoc {
  text: string
  sourceType: string
}

function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readPdf(file: File): Promise<string> {
  const pdfjsLib = await getPdfjs()
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const pages: string[] = []

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    let lastY: number | null = null

    for (const item of content.items as any[]) {
      if (typeof item?.str !== 'string') continue
      const y = item.transform?.[5]
      if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 1) text += '\n'
      text += item.str
      if (typeof y === 'number') lastY = y
    }
    pages.push(text)
  }

  return pages.join('\n\n')
}

async function readDocx(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const mod: any = await import('mammoth')
  const mammoth = mod.default ?? mod
  const result = await mammoth.extractRawText({ arrayBuffer: buffer })
  return result.value
}

export async function parseFile(file: File): Promise<ParsedDoc> {
  if (file.size > MAX_BYTES) {
    throw new Error(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请控制在 20MB 以内。`)
  }

  const name = file.name.toLowerCase()
  let text = ''
  let sourceType = ''

  if (name.endsWith('.pdf')) {
    sourceType = 'pdf'
    text = await readPdf(file)
  } else if (name.endsWith('.docx')) {
    sourceType = 'docx'
    text = await readDocx(file)
  } else if (name.endsWith('.doc')) {
    throw new Error('暂不支持旧版 .doc 格式，请用 Word 另存为 .docx 后再导入。')
  } else if (name.endsWith('.md') || name.endsWith('.markdown')) {
    sourceType = 'markdown'
    text = await file.text()
  } else if (name.endsWith('.txt')) {
    sourceType = 'txt'
    text = await file.text()
  } else {
    throw new Error('支持的文件类型：PDF、Word(.docx)、Markdown、TXT。')
  }

  text = tidy(text)
  if (text.length < 80) {
    throw new Error(
      '几乎没有提取到文字。如果这是扫描版 PDF（图片型），需要先做 OCR 才能使用。',
    )
  }
  return { text, sourceType }
}
