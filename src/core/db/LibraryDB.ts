import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { BookSummary, StoredBook, StoredProgress } from '@/types'
import type { PronunciationReport } from '@/core/feedback/types'

export interface StoredBookLexicon {
  bookId: string
  overlay: string
  entries: number
  version: number
  packId: string
  packVersion: string
  lexiconName: string
  curatedHash: string
  createdAt: number
}

interface LibrarySchema extends DBSchema {
  books: {
    key: string
    value: StoredBook
  }
  progress: {
    key: string
    value: StoredProgress
  }
  bookLexicons: {
    key: string
    value: StoredBookLexicon
  }
  covers: {
    key: string
    value: Blob | null
  }
  pronunciationReports: {
    key: string
    value: PronunciationReport
    indexes: { 'by-createdAt': number }
  }
}

const DB_NAME = 'shusheng-library'
const DB_VERSION = 4

let database: Promise<IDBPDatabase<LibrarySchema>> | null = null

function getDatabase(): Promise<IDBPDatabase<LibrarySchema>> {
  if (!database) {
    database = openDB<LibrarySchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('books', { keyPath: 'id' })
          db.createObjectStore('progress', { keyPath: 'bookId' })
        }
        if (oldVersion < 2) {
          db.createObjectStore('bookLexicons', { keyPath: 'bookId' })
        }
        if (oldVersion < 3) {
          db.createObjectStore('covers')
        }
        if (oldVersion < 4) {
          const reports = db.createObjectStore('pronunciationReports', {
            keyPath: 'id',
          })
          reports.createIndex('by-createdAt', 'createdAt')
        }
      },
    })
  }
  return database
}

function toSummary(book: StoredBook): BookSummary {
  const { file: _file, ...summary } = book
  return summary
}

export async function listBooks(): Promise<BookSummary[]> {
  const db = await getDatabase()
  const books = await db.getAll('books')
  return books
    .map(toSummary)
    .sort(
      (a, b) =>
        (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt,
    )
}

export async function getBook(id: string): Promise<StoredBook | undefined> {
  const db = await getDatabase()
  return db.get('books', id)
}

export async function findBookByFile(
  fileName: string,
  size: number,
): Promise<BookSummary | undefined> {
  const books = await listBooks()
  return books.find((book) => book.fileName === fileName && book.size === size)
}

export async function saveBook(book: StoredBook): Promise<void> {
  const db = await getDatabase()
  await db.put('books', book)
}

export async function touchBook(id: string, timestamp = Date.now()): Promise<void> {
  const db = await getDatabase()
  const book = await db.get('books', id)
  if (!book) return
  await db.put('books', { ...book, lastOpenedAt: timestamp })
}

export async function removeBook(id: string): Promise<void> {
  const db = await getDatabase()
  const transaction = db.transaction(
    ['books', 'progress', 'bookLexicons', 'covers'],
    'readwrite',
  )
  await Promise.all([
    transaction.objectStore('books').delete(id),
    transaction.objectStore('progress').delete(id),
    transaction.objectStore('bookLexicons').delete(id),
    transaction.objectStore('covers').delete(id),
    transaction.done,
  ])
}

export async function getBookCover(id: string): Promise<Blob | null | undefined> {
  const db = await getDatabase()
  return db.get('covers', id)
}

export async function saveBookCover(id: string, cover: Blob | null): Promise<void> {
  const db = await getDatabase()
  await db.put('covers', cover, id)
}

export async function getProgress(bookId: string): Promise<StoredProgress | undefined> {
  const db = await getDatabase()
  return db.get('progress', bookId)
}

export async function removeBookProgressAndLexicon(bookId: string): Promise<void> {
  const db = await getDatabase()
  const transaction = db.transaction(['progress', 'bookLexicons'], 'readwrite')
  await Promise.all([
    transaction.objectStore('progress').delete(bookId),
    transaction.objectStore('bookLexicons').delete(bookId),
    transaction.done,
  ])
}

export async function saveProgress(progress: StoredProgress): Promise<void> {
  const db = await getDatabase()
  await db.put('progress', progress)
}

export async function getBookLexicon(
  bookId: string,
): Promise<StoredBookLexicon | undefined> {
  const db = await getDatabase()
  return db.get('bookLexicons', bookId)
}

export async function saveBookLexicon(entry: StoredBookLexicon): Promise<void> {
  const db = await getDatabase()
  await db.put('bookLexicons', entry)
}

export async function savePronunciationReport(
  report: PronunciationReport,
): Promise<void> {
  const db = await getDatabase()
  await db.put('pronunciationReports', report)
}

export async function listPronunciationReports(): Promise<PronunciationReport[]> {
  const db = await getDatabase()
  return db.getAllFromIndex('pronunciationReports', 'by-createdAt')
}

export async function countPronunciationReports(): Promise<number> {
  const db = await getDatabase()
  return db.count('pronunciationReports')
}

export async function removePronunciationReport(id: string): Promise<void> {
  const db = await getDatabase()
  await db.delete('pronunciationReports', id)
}
