import type { FoliateBookLike, FoliateSection } from './types'

const AUTO_SECTION_CHARS = 18000
const MAX_PARAGRAPH_CHARS = 3000

const HEADING_PATTERN =
  /^(?:第[零〇一二三四五六七八九十百千万两0-9０-９]+[章节卷回部篇集][^\n]{0,40}|(?:序章|楔子|引子|前言|序言|后记|尾声|终章)|番外(?:篇)?[^\n]{0,20}|(?:chapter|part|book|prologue|epilogue)\b[^\n]{0,40})$/i

export interface TextSectionData {
  label: string
  heading: string | null
  paragraphs: string[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function joinLines(previous: string, next: string): string {
  const last = previous.slice(-1)
  const first = next.slice(0, 1)
  const needsSpace = /[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first)
  return needsSpace ? `${previous} ${next}` : `${previous}${next}`
}

function isHeading(line: string): boolean {
  return line.length <= 60 && HEADING_PATTERN.test(line.trim())
}

/** Joins hard-wrapped lines and keeps blank lines / indentation as breaks. */
function toParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  let current = ''

  const flush = () => {
    const value = current.trim()
    if (value) paragraphs.push(value)
    current = ''
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/[ \t\u00a0]+$/g, '')
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    if (isHeading(trimmed)) {
      flush()
      paragraphs.push(trimmed)
      continue
    }
    if (!current) {
      current = trimmed
      continue
    }
    const indented = /^[\u3000\s]{2,}/.test(line)
    const endsSentence = /[。！？!?…；;：:」』”’)）》〉\]】]$/.test(current)
    if (indented || endsSentence) {
      flush()
      current = trimmed
      continue
    }
    current = joinLines(current, trimmed)
  }

  flush()
  return paragraphs
}

/** Splits a paragraph that has no line breaks at all (e.g. one-line TXT). */
function breakLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_PARAGRAPH_CHARS) return [paragraph]
  const sentences = paragraph.match(/[^。！？!?…\n]+[。！？!?…]*/g) ?? [paragraph]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_PARAGRAPH_CHARS) {
      chunks.push(current)
      current = ''
    }
    current += sentence
  }
  if (current) chunks.push(current)
  return chunks
}

function makeSection(
  label: string,
  heading: string | null,
  paragraphs: string[],
): TextSectionData {
  return { label, heading, paragraphs }
}

export function splitTextSections(text: string): TextSectionData[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const paragraphs = toParagraphs(normalized)
  if (!paragraphs.length) return []

  const headingIndexes: number[] = []
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (isHeading(paragraphs[index]!)) headingIndexes.push(index)
  }

  if (headingIndexes.length >= 1) {
    const sections: TextSectionData[] = []
    const first = headingIndexes[0]!
    if (first > 0) {
      sections.push(makeSection('开篇', null, paragraphs.slice(0, first)))
    }
    for (let index = 0; index < headingIndexes.length; index += 1) {
      const start = headingIndexes[index]!
      const end = headingIndexes[index + 1] ?? paragraphs.length
      const heading = paragraphs[start]!
      const body = paragraphs.slice(start + 1, end)
      sections.push(makeSection(heading.slice(0, 60), heading, body))
    }
    return sections
  }

  const sections: TextSectionData[] = []
  let current: string[] = []
  let size = 0
  let labelIndex = 0
  const flush = () => {
    if (!current.length) return
    labelIndex += 1
    sections.push(makeSection(`第 ${labelIndex} 节`, null, current))
    current = []
    size = 0
  }

  for (const paragraph of paragraphs) {
    for (const piece of breakLongParagraph(paragraph)) {
      if (size > 0 && size + piece.length > AUTO_SECTION_CHARS) flush()
      current.push(piece)
      size += piece.length
    }
  }
  flush()
  return sections
}

function sectionHtml(section: TextSectionData): string {
  const heading = section.heading
    ? `<h1>${escapeHtml(section.heading)}</h1>`
    : ''
  const body = section.paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('')
  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body>${heading}${body}</body>
</html>`
}

function replacementCount(value: string): number {
  let count = 0
  for (const char of value) if (char === '\uFFFD') count += 1
  return count
}

function decodeWith(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return null
  }
}

export function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length === 0) return ''

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith('utf-8', bytes.subarray(3)) ?? ''
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeWith('utf-16le', bytes.subarray(2)) ?? ''
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeWith('utf-16be', bytes.subarray(2)) ?? ''
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not valid UTF-8; fall through to legacy Chinese encodings.
  }

  const gb18030 = decodeWith('gb18030', bytes)
  const big5 = decodeWith('big5', bytes)
  if (!gb18030) return big5 ?? ''
  if (!big5) return gb18030
  return replacementCount(gb18030) <= replacementCount(big5) ? gb18030 : big5
}

export interface TextBookResult {
  title: string
  sections: TextSectionData[]
}

export function parseTextBook(buffer: ArrayBuffer, fallbackTitle: string): TextBookResult {
  const text = decodeTextBuffer(buffer)
  const sections = splitTextSections(text)
  if (!sections.length) throw new Error('这个文本文件里没有可阅读的内容。')
  return { title: fallbackTitle.trim() || '未命名文本', sections }
}

export function buildTextBook(buffer: ArrayBuffer, fallbackTitle: string): FoliateBookLike {
  const { title, sections } = parseTextBook(buffer, fallbackTitle)
  const urlCache = new Map<number, string>()
  const htmls = sections.map(sectionHtml)

  const bookSections: FoliateSection[] = sections.map((_section, index) => ({
    id: index,
    size: htmls[index]!.length,
    load: () => {
      const cached = urlCache.get(index)
      if (cached) return cached
      const url = URL.createObjectURL(
        new Blob([htmls[index]!], { type: 'application/xhtml+xml' }),
      )
      urlCache.set(index, url)
      return url
    },
    createDocument: () =>
      new DOMParser().parseFromString(htmls[index]!, 'application/xhtml+xml'),
  }))

  return {
    sections: bookSections,
    toc: sections.map((section, index) => ({
      label: section.label,
      href: String(index),
    })),
    metadata: { title, author: [] },
    resolveHref: (href) => {
      const [path, hash = ''] = href.split('#')
      const index = path.trim() ? Number(path) : 0
      if (!Number.isInteger(index) || index < 0 || index >= sections.length) {
        return undefined
      }
      const anchorId = hash ? decodeURIComponent(hash) : ''
      return {
        index,
        anchor: (doc) => (anchorId ? doc.getElementById(anchorId) : null),
      }
    },
    splitTOCHref: (href) => {
      const [path, hash = null] = href.split('#')
      return [Number(path), hash]
    },
    isExternal: (uri) => /^\w+:/i.test(uri),
    destroy: () => {
      for (const url of urlCache.values()) URL.revokeObjectURL(url)
      urlCache.clear()
    },
  }
}
