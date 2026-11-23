import { describe, expect, it } from 'vitest'

async function loadScore(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/blindScore.mjs')
}

const ITEMS = [
  { id: 'blind-poly-01', category: 'polyphone' },
  { id: 'blind-long-01', category: 'long-sentence' },
]

function fill(sheet: any, score: number) {
  for (const item of sheet.items) {
    for (const side of ['before', 'after']) {
      for (const key of ['pronunciation', 'clarity', 'naturalness', 'prosody', 'emotion']) {
        item[side][key] = score
      }
    }
  }
  return sheet
}

describe('2026-11-23 第十四轮：盲听评分模板', () => {
  it('权重总和为 1，空白模板未完成但合法', async () => {
    const { BLIND_WEIGHTS, createScoreSheet, validateScoreSheet } = await loadScore()
    const weights = Object.values(BLIND_WEIGHTS) as number[]
    const total = weights.reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 10)
    const result = validateScoreSheet(createScoreSheet({ before: 'a', after: 'b', items: ITEMS }))
    expect(result.ok).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.items).toHaveLength(2)
  })

  it('全部维度填 4 分时，总分 4.00', async () => {
    const { createScoreSheet, validateScoreSheet } = await loadScore()
    const sheet = fill(createScoreSheet({ before: 'a', after: 'b', items: ITEMS }), 4)
    const result = validateScoreSheet(sheet)
    expect(result.ok).toBe(true)
    expect(result.complete).toBe(true)
    expect(result.overall.before).toBe(4)
    expect(result.overall.after).toBe(4)
  })

  it('拒绝越界、非整数和重复 id', async () => {
    const { createScoreSheet, validateScoreSheet } = await loadScore()
    const sheet = createScoreSheet({ before: 'a', after: 'b', items: ITEMS })
    sheet.items[0].before.pronunciation = 6
    sheet.items[1].after.clarity = 1.5
    sheet.items[1].id = 'blind-poly-01'
    const result = validateScoreSheet(sheet)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})
