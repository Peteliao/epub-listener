import ePub, { type Book } from 'epubjs'
import type { BookFormat } from '@/types'
import type { FoliateBookLike } from '@/core/reader/formats/types'

// Covers are stored per book, so skip pathological assets that would bloat
// IndexedDB without adding detail at shelf size.
const MAX_COVER_BYTES = 12 * 1024 * 1024

function acceptCover(value: Blob | null | undefined): Blob | null {
  if (!value || value.size === 0 || value.size > MAX_COVER_BYTES) return null
  if (value.type && !value.type.startsWith('image/')) return null
  return value
}

export async function readEpubCover(book: Book): Promise<Blob | null> {
  let url: string | null = null
  try {
    url = await book.coverUrl()
    if (!url) return null
    const response = await fetch(url)
    if (!response.ok) return null
    return acceptCover(await response.blob())
  } catch {
    return null
  } finally {
    if (url) URL.revokeObjectURL(url)
  }
}

export async function readFoliateCover(book: FoliateBookLike): Promise<Blob | null> {
  try {
    return acceptCover(await book.getCover?.())
  } catch {
    return null
  }
}

export async function extractBookCover(
  format: BookFormat,
  buffer: ArrayBuffer,
): Promise<Blob | null> {
  if (format === 'txt') return null
  try {
    if (format === 'epub') {
      const book = ePub(buffer)
      try {
        await book.opened
        return await readEpubCover(book)
      } finally {
        try {
          book.destroy()
        } catch {
          // Malformed archives can make cleanup throw.
        }
      }
    }
    const { buildFb2Book, buildMobiBook } = await import(
      '@/core/reader/formats/foliateBook'
    )
    const book =
      format === 'fb2' ? await buildFb2Book(buffer) : await buildMobiBook(buffer)
    try {
      return await readFoliateCover(book)
    } finally {
      try {
        book.destroy?.()
      } catch {
        // Malformed archives can make cleanup throw.
      }
    }
  } catch {
    return null
  }
}
