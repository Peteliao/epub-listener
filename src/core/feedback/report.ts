import { BOOK_FORMAT_LABELS } from '@/types'
import {
  PRONUNCIATION_REPORT_SCHEMA,
  type PronunciationReport,
  type PronunciationReportInput,
} from './types'

const ISSUE_BASE = 'https://github.com/Peteliao/epub-listener/issues/new'
const MAX_PARAGRAPH_CHARS = 1200
const MAX_TITLE_CHARS = 120

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function hashParagraphText(text: string): string {
  return `fnv1a:${fnv1a(text)}:${text.length}`
}

export function createReportId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return random
  return `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createPronunciationReport(
  input: PronunciationReportInput,
): PronunciationReport {
  return {
    schema: PRONUNCIATION_REPORT_SCHEMA,
    id: input.id,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    appBuildId: input.appBuildId,
    book: { ...input.book },
    paragraph: {
      text: input.paragraph.text,
      speechText: input.paragraph.speechText,
      startSentenceIndex: input.paragraph.startSentenceIndex,
      endSentenceIndex: input.paragraph.endSentenceIndex,
      textHash: hashParagraphText(input.paragraph.text),
    },
    marks: input.marks.map((mark) => ({ ...mark })),
    note: input.note.trim(),
    voice: { ...input.voice },
    includeTitle: input.includeTitle,
    status: 'local',
    issueUrl: null,
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function bookLabel(report: PronunciationReport): string {
  return report.includeTitle ? `《${report.book.title}》` : '未包含书名'
}

function markSummary(report: PronunciationReport): string {
  return report.marks
    .map((mark) => `${mark.char}→${mark.expectedLabel}`)
    .join('、')
}

export function pronunciationIssueTitle(report: PronunciationReport): string {
  const title = `[读音反馈] ${bookLabel(report)} ${markSummary(report)}`
  return truncate(title, MAX_TITLE_CHARS)
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function pronunciationIssueBody(report: PronunciationReport): string {
  const paragraph = report.paragraph.text
  const excerpt =
    paragraph.length > MAX_PARAGRAPH_CHARS
      ? `${paragraph.slice(0, MAX_PARAGRAPH_CHARS)}…（已截断，完整内容见本地导出）`
      : paragraph
  const quote = excerpt
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
  const format = BOOK_FORMAT_LABELS[report.book.format] ?? report.book.format
  const voice = report.voice
  const engine =
    voice.engine === 'sherpa'
      ? `离线 AI · ${voice.modelType ?? '未知模型'}`
      : '系统语音'
  const overlay = voice.overlaySupported
    ? `支持（${voice.autoBookPolyphones ? '本书自动读音开启' : '本书自动读音关闭'}）`
    : '不支持（当前音色不读取读音词典）'
  const marks = report.marks
    .map(
      (mark) =>
        `| ${mdCell(mark.char)} | 第 ${mark.charIndex + 1} 字 | ${mdCell(
          mark.word,
        )} | ${mark.expectedLabel} (\`${mark.expectedPinyin}\`) |`,
    )
    .join('\n')

  return [
    '### 读音反馈',
    '',
    `- 书籍：${report.includeTitle ? `《${report.book.title}》` : '未包含书名'}`,
    `- 文件：${format} · ${(report.book.size / 1024 / 1024).toFixed(1)} MB`,
    `- 书籍指纹：\`${report.book.fingerprint ?? '未生成'}\``,
    `- 位置：第 ${report.book.chapterIndex + 1} 章 · ${report.book.chapterLabel || '未命名章节'}`,
    `- 段落锚点：\`${report.paragraph.textHash}\` · 句 ${report.paragraph.startSentenceIndex + 1}–${report.paragraph.endSentenceIndex + 1}`,
    `- 音色：${voice.voiceLabel} · ${engine}${voice.packVersion ? ` · 包 ${voice.packVersion}` : ''}`,
    `- 读音词典：${overlay} · v${voice.bookLexiconVersion} · \`${voice.curatedHash}\``,
    `- 实际引擎：${voice.activeEngine ?? '尚未开始朗读'}${voice.activeLang ? ` · ${voice.activeLang}` : ''}`,
    `- 客户端：${report.appBuildId || '开发版'}`,
    `- 报告 ID：\`${report.id}\``,
    '',
    '### 原文段落',
    '',
    quote,
    '',
    '### 错误标记',
    '',
    '| 字 | 位置 | 词组 | 正确读音 |',
    '| --- | --- | --- | --- |',
    marks,
    '',
    '### 备注',
    '',
    report.note || '无',
    '',
    `<!-- shusheng-pronunciation-report v1 ${report.id} -->`,
  ].join('\n')
}

export function pronunciationIssueUrl(report: PronunciationReport): string {
  const title = encodeURIComponent(pronunciationIssueTitle(report))
  const body = encodeURIComponent(pronunciationIssueBody(report))
  return `${ISSUE_BASE}?title=${title}&body=${body}`
}

export function openPronunciationIssue(report: PronunciationReport): string {
  const url = pronunciationIssueUrl(report)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  return url
}

export function reportsToJsonl(reports: readonly PronunciationReport[]): string {
  return reports.map((report) => JSON.stringify(report)).join('\n')
}

export function downloadTextFile(
  text: string,
  fileName: string,
  mime = 'application/jsonl;charset=utf-8',
): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function reportFileName(): string {
  const date = new Date()
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}${String(date.getDate()).padStart(2, '0')}`
  return `pronunciation-reports-${stamp}.jsonl`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      return copied
    } catch {
      return false
    }
  }
}
