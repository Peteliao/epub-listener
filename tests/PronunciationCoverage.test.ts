import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

interface UncoveredHan {
  char: string
  charOffset: number
  context: string
}

interface ReadingModule {
  parseEntries(text: string): Map<string, string>
  findUncoveredHan(text: string, entries: Map<string, string>): UncoveredHan[]
}

async function loadReading(): Promise<ReadingModule> {
  const module = await import('../scripts/lib/reading.mjs') as unknown as ReadingModule
  return module
}

const root = process.cwd()

describe('single-character coverage audit', () => {
  it('reports only Han characters left at single-character fallback', async () => {
    const { findUncoveredHan, parseEntries } = await loadReading()
    const entries = parseEntries(
      '一 yi1\n九 jiu3\n八 ba1\n年 nian2\n零 ling2\n重庆 zhong4 qing4\n',
    )
    expect(findUncoveredHan('一九八〇年，重庆。', entries).map((item) => item.char))
      .toEqual(['〇'])
    expect(findUncoveredHan('一九八零年，重庆。', entries)).toEqual([])
  })

  it('honors forced word boundaries before the single-character fallback', async () => {
    const { findUncoveredHan, parseEntries } = await loadReading()
    const entries = parseEntries('你好 ni3 hao3\n')
    expect(findUncoveredHan('你\u200b好', entries).map((item) => item.char))
      .toEqual(['你', '好'])
  })
})

describe('山岚 sample-book coverage', () => {
  it('keeps multi-character words and neutral tones covered', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/audit-coverage.mjs', 'public/sample.epub', '--top=5', '--strict'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

    const hit = /多字词命中 \d+\/\d+（(\d+\.\d+)%）/.exec(result.stdout)
    expect(hit, result.stdout).not.toBeNull()
    expect(Number(hit![1])).toBeGreaterThanOrEqual(80)
    expect(result.stdout).toContain(
      '单字缺条（原生前端会静默丢字）：0 个字 / 0 次',
    )

    // A new neutral gap means a common word lost its curated reading; the
    // audit output lists it so it can be reviewed and pinned to the golden set.
    expect(result.stdout).toContain(
      '词库标全调、参考为轻声（高可信候选）：0 个词 / 0 次',
    )
  }, 20_000)
})
