import { describe, expect, it } from 'vitest'
import {
  mergeLexiconOverlays,
  mergeOverlaySources,
} from '../src/core/tts/pinyinTones'

async function loadSources(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/readingSources.mjs')
}

async function loadReading(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/reading.mjs')
}

describe('2026-11-23 第十四轮：读音来源解释器', () => {
  it('按优先级展示每个来源并指出最终生效来源', async () => {
    const { explainReading } = await loadSources()
    const report = explainReading('长期', {
      base: '长期 zhang3 qi1\n',
      book: '长期 chang2 qi1\n',
      live: '长期 chang2 qi1\n',
      curated: '长期 chang2 qi1\n',
    })
    expect(report.final).toBe('chang2 qi1')
    expect(report.source).toBe('curated')
    expect(report.status).toContain('冲突')
    expect(report.rows.map((row: any) => row.key)).toEqual(['base', 'book', 'live', 'curated'])
  })

  it('后加入的整书/即时来源覆盖前面的来源', async () => {
    const { explainReading } = await loadSources()
    const book = explainReading('便宜', {
      base: '便宜 pian2 yi\n',
      book: '便宜 bian4 yi2\n',
    })
    expect(book.final).toBe('bian4 yi2')
    expect(book.source).toBe('book')

    const live = explainReading('便宜', {
      base: '便宜 pian2 yi\n',
      book: '便宜 bian4 yi2\n',
      live: '便宜 pian2 yi\n',
    })
    expect(live.final).toBe('pian2 yi')
    expect(live.source).toBe('live')
  })

  it('所有来源都未命中时明确报告', async () => {
    const { explainReading } = await loadSources()
    const report = explainReading('不存在', { base: '长期 chang2 qi1\n' })
    expect(report.final).toBe(null)
    expect(report.status).toBe('未命中任何来源')
  })

  it('人工表最后生效，且合并后每个词只有一行（运行时 last / 审计 first 一致）', async () => {
    const { parseOverlay, parseEntries } = await loadReading()
    const merged = mergeLexiconOverlays(
      '长期 chang2 qi1\n',
      '长期 zhang3 qi1\n',
    )
    expect(merged).toBe('长期 chang2 qi1')

    const bookSide = mergeOverlaySources(
      '便宜 pian2 yi\n',
      '便宜 bian4 yi2\n',
      '便宜 pian2 yi\n',
    )
    expect(bookSide).toBe('便宜 pian2 yi')
    expect(bookSide.trim().split(/\r?\n/)).toHaveLength(1)

    const first = parseOverlay(bookSide).entries
    const last = parseEntries(bookSide)
    expect([...first.entries()]).toEqual([...last.entries()])
  })
})
