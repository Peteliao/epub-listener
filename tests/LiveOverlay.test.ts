import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reportsToLiveOverlay } from '@/core/feedback/liveOverlay'
import { mergeOverlaySources, mergeLexiconOverlays } from '@/core/tts/pinyinTones'
import type { PronunciationReport } from '@/core/feedback/types'

const root = process.cwd()
const curated = readFileSync(
  resolve(root, 'src/core/tts/polyphones.v1.txt'),
  'utf8',
)
const pinned = new Set(
  curated.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0]),
)

function report(overrides: Partial<PronunciationReport> = {}): PronunciationReport {
  const text = '他打开了会计账本。'
  const word = '会计'
  const start = text.indexOf(word)
  return {
    schema: 1,
    id: 'r-1',
    createdAt: 1,
    updatedAt: 1,
    appBuildId: 'test',
    book: {
      id: 'book-a', title: '测试', format: 'epub', size: 1,
      fingerprint: null, chapterIndex: 0, chapterHref: '', chapterLabel: '',
    },
    paragraph: {
      text, speechText: text, startSentenceIndex: 0, endSentenceIndex: 0, textHash: 'x',
    },
    marks: [{
      id: 'm-1', char: '会', charIndex: start, word,
      wordStart: start, wordEnd: start + word.length,
      expectedPinyin: 'kuai4', expectedLabel: 'kuài',
    }],
    note: '',
    voice: {} as PronunciationReport['voice'],
    includeTitle: false,
    status: 'local',
    issueUrl: null,
    ...overrides,
  } as PronunciationReport
}

describe('reportsToLiveOverlay（低档 ④）', () => {
  it('按 book.id 过滤，只处理本书反馈', () => {
    const other = report({ id: 'r-2', book: { ...report().book, id: 'book-b' } })
    const result = reportsToLiveOverlay([report(), other], 'book-a')
    expect(result.overlay).toContain('会计')
    expect(result.rows).toBe(1)
  })

  it('只替换目标字，其余音节保留', () => {
    const result = reportsToLiveOverlay([report()], 'book-a')
    expect(result.overlay).toContain('会计 kuai4 ji4')
    expect(result.hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('跳过单字语境（避免生成全局覆盖）', () => {
    const text = '他会来的。'
    const r = report({
      paragraph: { text, speechText: text, startSentenceIndex: 0, endSentenceIndex: 0, textHash: 'x' },
      marks: [{
        id: 'm', char: '会', charIndex: 1, word: '会',
        wordStart: 1, wordEnd: 2, expectedPinyin: 'kuai4', expectedLabel: 'kuài',
      }],
    })
    expect(reportsToLiveOverlay([r], 'book-a').rows).toBe(0)
  })

  it('同词同位置读音冲突时跳过', () => {
    const a = report()
    const b = report({
      id: 'r-2',
      marks: [{ ...a.marks[0], id: 'm-2', expectedPinyin: 'hui4', expectedLabel: 'huì' }],
    })
    expect(reportsToLiveOverlay([a, b], 'book-a').rows).toBe(0)
  })

  it('跳过人工表已钉住的词与含「一/不」的词', () => {
    const text = '这个占便宜的人不一定是坏人。'
    const mk = (word: string, char: string, phone: string) => {
      const start = text.indexOf(word)
      return report({
        paragraph: { text, speechText: text, startSentenceIndex: 0, endSentenceIndex: 0, textHash: 'x' },
        marks: [{
          id: 'm', char, charIndex: start, word,
          wordStart: start, wordEnd: start + word.length,
          expectedPinyin: phone, expectedLabel: phone,
        }],
      })
    }
    expect(reportsToLiveOverlay([mk('占便宜', '便', 'pian2')], 'book-a', pinned).rows).toBe(0)
    expect(reportsToLiveOverlay([mk('不一定', '不', 'bu4')], 'book-a').rows).toBe(0)
  })

  it('非法音素与未训练轻声被拒绝', () => {
    const bad = (phone: string) => report({
      marks: [{ ...report().marks[0], expectedPinyin: phone, expectedLabel: phone }],
    })
    expect(reportsToLiveOverlay([bad('kuai9')], 'book-a').rows).toBe(0)
    expect(reportsToLiveOverlay([bad('zz')], 'book-a').rows).toBe(0)
  })

  it('删除反馈即可撤销：无报告时 overlay 为空且 hash 稳定', () => {
    const empty = reportsToLiveOverlay([], 'book-a')
    expect(empty.overlay).toBe('')
    expect(empty.rows).toBe(0)
    expect(empty.hash).toBe(reportsToLiveOverlay([], 'book-a').hash)
  })

  it('输出与顺序无关（确定性）', () => {
    const a = reportsToLiveOverlay([report()], 'book-a')
    const b = reportsToLiveOverlay([report({ id: 'r-2' }), report()], 'book-a')
    const c = reportsToLiveOverlay([report(), report({ id: 'r-2' })], 'book-a')
    expect(b.overlay).toBe(a.overlay)
    expect(c.overlay).toBe(a.overlay)
  })
})

describe('mergeOverlaySources（优先级链）', () => {
  it('按传入顺序后者覆盖前者，每词恰好一行', () => {
    const base = '会计 hui4 ji4\n地盘 de pan2'
    const ruby = '会计 kuai4 ji4\n应声 ying4 sheng1'
    const live = '地盘 di4 pan2'
    const merged = mergeOverlaySources(base, ruby, live)
    expect(merged).toContain('会计 kuai4 ji4')
    expect(merged).toContain('地盘 di4 pan2')
    expect(merged).toContain('应声 ying4 sheng1')
    const words = merged.split('\n').map((line) => line.split(/\s+/)[0])
    expect(new Set(words).size).toBe(words.length)
  })

  it('忽略注释、空行与 undefined，输出按词排序且可复现', () => {
    expect(mergeOverlaySources('# 注释', '', undefined, '乙 yi3', '甲 jia3'))
      .toBe('乙 yi3\n甲 jia3'.split('\n').sort((a, b) => a.localeCompare(b, 'zh')).join('\n'))
  })

  it('人工表永远最后生效（mergeLexiconOverlays 原语义不变）', () => {
    const curatedText = '会计 hui4 ji4\n人工 ren2 gong1'
    const book = mergeOverlaySources('会计 kuai4 ji4', '地盘 di4 pan2')
    const merged = mergeLexiconOverlays(curatedText, book)
    const rows = merged.split('\n')
    expect(rows.at(-1)).toContain('人工')
    expect(merged).not.toContain('会计 kuai4 ji4')
    expect(merged).toContain('会计 hui4 ji4')
    expect(merged).toContain('地盘 di4 pan2')
  })
})
