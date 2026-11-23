import { describe, expect, it } from 'vitest'
import { reportIdsForBook } from '@/core/db/LibraryDB'

function report(id: string, bookId: string): any {
  return { id, book: { id: bookId } }
}

describe('2026-11-23 第十六轮：删书时清理即时纠错', () => {
  it('只挑出属于该书的反馈报告 id', () => {
    const reports = [
      report('r-a1', 'book-a'),
      report('r-b1', 'book-b'),
      report('r-a2', 'book-a'),
    ]
    expect(reportIdsForBook(reports, 'book-a')).toEqual(['r-a1', 'r-a2'])
    expect(reportIdsForBook(reports, 'missing')).toEqual([])
  })
})
