import { describe, expect, it } from 'vitest'
import {
  createPronunciationReport,
  hashParagraphText,
  pronunciationIssueBody,
  pronunciationIssueTitle,
  pronunciationIssueUrl,
  reportsToJsonl,
} from '@/core/feedback/report'
import type { PronunciationReportInput } from '@/core/feedback/types'

function sampleInput(): PronunciationReportInput {
  return {
    id: 'report-1',
    createdAt: 1_760_000_000_000,
    appBuildId: 'build-abc',
    book: {
      id: 'book-1',
      title: '山间来信',
      format: 'epub',
      size: 2 * 1024 * 1024,
      fingerprint: 'sha256:1234567890',
      chapterIndex: 2,
      chapterHref: 'chapter-3.xhtml',
      chapterLabel: '第三章 山雨',
    },
    paragraph: {
      id: 'chapter-3.xhtml#p12',
      text: '他转身去还书，把灯关了。',
      speechText: '他转身去还书，把灯关了。',
      startSentenceIndex: 12,
      endSentenceIndex: 12,
      isCurrent: true,
    },
    marks: [
      {
        id: 'mark-1',
        char: '还',
        charIndex: 4,
        word: '还书',
        wordStart: 4,
        wordEnd: 6,
        expectedPinyin: 'huan2',
        expectedLabel: 'huán',
      },
    ],
    note: '这里应读 huán。',
    voice: {
      engine: 'sherpa',
      activeEngine: 'sherpa',
      activeLang: 'zh',
      voiceId: 'shanlan',
      voiceLabel: '山岚',
      packId: 'matcha-icefall-zh-baker',
      packVersion: '2026.10.26',
      modelType: 'matcha',
      overlaySupported: true,
      autoBookPolyphones: true,
      bookLexiconVersion: 3,
      curatedHash: 'abcd1234',
    },
    includeTitle: true,
  }
}

describe('pronunciation report', () => {
  it('builds a local report with a stable paragraph hash', () => {
    const report = createPronunciationReport(sampleInput())
    expect(report.schema).toBe(1)
    expect(report.status).toBe('local')
    expect(report.issueUrl).toBeNull()
    expect(report.paragraph.textHash).toBe(
      hashParagraphText('他转身去还书，把灯关了。'),
    )
    expect(report.marks).toHaveLength(1)
    expect(report.voice.overlaySupported).toBe(true)
  })

  it('renders a readable issue title and body', () => {
    const report = createPronunciationReport(sampleInput())
    expect(pronunciationIssueTitle(report)).toBe(
      '[读音反馈] 《山间来信》 还→huán',
    )
    const body = pronunciationIssueBody(report)
    expect(body).toContain('### 原文段落')
    expect(body).toContain('他转身去还书，把灯关了。')
    expect(body).toContain('| 还 | 第 5 字 | 还书 | huán (`huan2`) |')
    expect(body).toContain('支持（本书自动读音开启）')
    expect(body).toContain('shusheng-pronunciation-report')
  })

  it('omits the book title when the reader opts out', () => {
    const report = createPronunciationReport({
      ...sampleInput(),
      includeTitle: false,
    })
    expect(pronunciationIssueTitle(report)).toContain('未包含书名')
    expect(pronunciationIssueBody(report)).toContain('书籍：未包含书名')
  })

  it('builds an encoded GitHub new-issue URL', () => {
    const report = createPronunciationReport(sampleInput())
    const url = pronunciationIssueUrl(report)
    expect(url.startsWith('https://github.com/Peteliao/epub-listener/issues/new?')).toBe(
      true,
    )
    expect(url).toContain('title=%5B%E8%AF%BB%E9%9F%B3%E5%8F%8D%E9%A6%88%5D')
    expect(url).toContain('body=')
  })

  it('exports one JSON object per line', () => {
    const report = createPronunciationReport(sampleInput())
    const lines = reportsToJsonl([report, { ...report, id: 'report-2' }]).split(
      '\n',
    )
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).id).toBe('report-1')
    expect(JSON.parse(lines[1]!).id).toBe('report-2')
  })
})
