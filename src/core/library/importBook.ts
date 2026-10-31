import ePub from 'epubjs'
import type { BookFormat, BookSummary, StoredBook } from '@/types'
import { detectBookFormat } from '@/core/reader/formats/bookFormat'
import { readEpubCover, readFoliateCover } from './bookCover'
import {
  findBookByFile,
  getBook,
  removeBookProgressAndLexicon,
  saveBook,
  saveBookCover,
} from '../db/LibraryDB'

const MAX_FILE_SIZE = 200 * 1024 * 1024
const SAMPLE_BOOK_ID = 'sample-shanjian'

interface BookInfo {
  title: string
  author: string
  chapterCount: number
  cover: Blob | null
}

export interface ImportResult {
  book: BookSummary
  reused: boolean
  updated?: boolean
}

function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function cleanText(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function titleFromFileName(fileName: string): string {
  const title = cleanText(fileName.replace(/\.[^.]+$/, ''))
  return title || '未命名'
}

function toSummary(book: StoredBook): BookSummary {
  const { file: _file, ...summary } = book
  return summary
}

function isZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false
  const bytes = new Uint8Array(buffer, 0, 4)
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function looksBinary(buffer: ArrayBuffer): boolean {
  const size = Math.min(buffer.byteLength, 2048)
  if (!size) return false
  const bytes = new Uint8Array(buffer, 0, size)
  let nul = 0
  for (const byte of bytes) if (byte === 0) nul += 1
  return nul > 8
}

async function inspectEpub(buffer: ArrayBuffer, fileName: string): Promise<BookInfo> {
  if (!isZip(buffer)) {
    throw new Error('这个文件不是有效的 EPUB，请重新选择。')
  }

  const book = ePub(buffer)
  try {
    await book.opened
    const metadata = await book.loaded.metadata

    let chapterCount = 0
    const spine = book.spine as unknown as {
      each: (callback: (section: { linear?: boolean }) => void) => void
    }
    spine.each((section) => {
      if (section.linear !== false) chapterCount += 1
    })

    return {
      title: cleanText(metadata.title) || titleFromFileName(fileName),
      author: cleanText(metadata.creator),
      chapterCount: Math.max(chapterCount, 1),
      cover: await readEpubCover(book),
    }
  } catch {
    throw new Error('无法解析这本书，文件可能损坏或受 DRM 保护。')
  } finally {
    try {
      book.destroy()
    } catch {
      // Best-effort cleanup for malformed archives.
    }
  }
}

async function inspectFb2(buffer: ArrayBuffer, fileName: string): Promise<BookInfo> {
  const { buildFb2Book, countFoliateSections, foliateAuthors, foliateTitle } =
    await import('@/core/reader/formats/foliateBook')
  const book = await buildFb2Book(buffer)
  try {
    return {
      title: foliateTitle(book) || titleFromFileName(fileName),
      author: foliateAuthors(book),
      chapterCount: Math.max(1, countFoliateSections(book)),
      cover: await readFoliateCover(book),
    }
  } finally {
    book.destroy?.()
  }
}

async function inspectMobi(buffer: ArrayBuffer, fileName: string): Promise<BookInfo> {
  const { buildMobiBook, countFoliateSections, foliateAuthors, foliateTitle } =
    await import('@/core/reader/formats/foliateBook')
  const book = await buildMobiBook(buffer)
  try {
    return {
      title: foliateTitle(book) || titleFromFileName(fileName),
      author: foliateAuthors(book),
      chapterCount: Math.max(1, countFoliateSections(book)),
      cover: await readFoliateCover(book),
    }
  } finally {
    book.destroy?.()
  }
}

async function inspectTxt(buffer: ArrayBuffer, fileName: string): Promise<BookInfo> {
  if (looksBinary(buffer)) {
    throw new Error('这个文件看起来不是纯文本，请重新选择。')
  }
  const { parseTextBook } = await import('@/core/reader/formats/textBook')
  const title = titleFromFileName(fileName)
  const { sections } = parseTextBook(buffer, title)
  return { title, author: '', chapterCount: Math.max(1, sections.length), cover: null }
}

function inspectFormat(
  format: BookFormat,
  buffer: ArrayBuffer,
  fileName: string,
): Promise<BookInfo> {
  switch (format) {
    case 'epub':
      return inspectEpub(buffer, fileName)
    case 'fb2':
      return inspectFb2(buffer, fileName)
    case 'mobi':
    case 'azw3':
      return inspectMobi(buffer, fileName)
    case 'txt':
      return inspectTxt(buffer, fileName)
  }
}

function unsupportedMessage(fileName: string): string {
  if (/\.azw$/i.test(fileName)) {
    return '暂不支持 .azw 格式（可能受 DRM 保护），请先转换为 EPUB 或 TXT。'
  }
  if (/\.pdf$/i.test(fileName)) {
    return '暂不支持 PDF，请先转换为 EPUB 或 TXT。'
  }
  if (/\.cbz$/i.test(fileName)) {
    return '暂不支持 CBZ 漫画，请先转换为 EPUB。'
  }
  return '暂不支持这种格式，可导入 EPUB、FB2、MOBI、AZW3 或 TXT。'
}

async function storeBook(book: StoredBook): Promise<void> {
  try {
    await saveBook(book)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('浏览器存储空间不足，无法保存这本书。')
    }
    throw new Error('无法写入本地书架，请检查浏览器的存储权限。')
  }
}

async function storeCover(bookId: string, cover: Blob | null): Promise<void> {
  try {
    await saveBookCover(bookId, cover)
  } catch {
    // A missing cover should never block reading the book.
  }
}

export async function importBookFile(file: File): Promise<ImportResult> {
  if (file.size === 0) throw new Error('这个文件是空的。')
  if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 200MB，暂时无法导入。')

  const existing = await findBookByFile(file.name, file.size)
  if (existing) return { book: existing, reused: true }

  const buffer = await file.arrayBuffer()
  const format = detectBookFormat(file.name, buffer)
  if (!format) throw new Error(unsupportedMessage(file.name))

  const info = await inspectFormat(format, buffer, file.name)

  const stored: StoredBook = {
    id: createId(),
    title: info.title,
    author: info.author,
    format,
    fileName: file.name,
    size: file.size,
    addedAt: Date.now(),
    lastOpenedAt: null,
    chapterCount: info.chapterCount,
    source: 'local',
    file: buffer,
  }

  await storeBook(stored)
  await storeCover(stored.id, info.cover)
  return { book: toSummary(stored), reused: false }
}

export async function importSampleBook(): Promise<ImportResult> {
  const existing = await getBook(SAMPLE_BOOK_ID)

  let response: Response
  try {
    response = await fetch(new URL('sample.epub', document.baseURI), {
      cache: 'no-store',
    })
  } catch {
    if (existing) return { book: toSummary(existing), reused: true }
    throw new Error('样书下载失败，请检查网络后重试。')
  }

  if (!response.ok) {
    if (existing) return { book: toSummary(existing), reused: true }
    throw new Error('样书暂时不可用。')
  }

  const buffer = await response.arrayBuffer()
  if (existing && sameBytes(existing.file, buffer)) {
    return { book: toSummary(existing), reused: true }
  }

  const info = await inspectEpub(buffer, '山间来信.epub')

  const stored: StoredBook = {
    id: SAMPLE_BOOK_ID,
    title: info.title,
    author: info.author,
    format: 'epub',
    fileName: '山间来信.epub',
    size: buffer.byteLength,
    addedAt: existing?.addedAt ?? Date.now(),
    lastOpenedAt: existing?.lastOpenedAt ?? null,
    chapterCount: info.chapterCount,
    source: 'sample',
    file: buffer,
  }

  await storeBook(stored)
  await storeCover(stored.id, info.cover)
  if (existing) {
    await removeBookProgressAndLexicon(stored.id).catch(() => undefined)
  }
  return { book: toSummary(stored), reused: false, updated: Boolean(existing) }
}
