import { describe, expect, it } from 'vitest'

async function loadFamilies(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/iterationFamilies.mjs')
}

async function loadReading(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/reading.mjs')
}

async function loadEnvelope(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/envelope.mjs')
}

const A_WORDS = [
  '立刻', '外婆', '那天', '目光', '屋顶', '走到',
  '白果', '抽屉', '春天', '那棵', '胸口', '眼眶',
]
const B_WORDS = ['老人', '声音', '坐在', '老师', '县城', '银杏', '那是', '自己', '山里']

function corpus(): string {
  // Start each sentence with the target so a preceding dictionary word such as
  // 说白 cannot cover its first character; this test measures the detector's
  // OOV recall, not the separate prefix-steal family.
  return [...A_WORDS, ...B_WORDS].map((word) => `${word}很重要。`).join('\n')
}

describe('2026-11-23 第十五轮：OOV 风险分级与召回评估', () => {
  it('A 类 stop-second 与 B 类普通 OOV 分级正确', async () => {
    const { loadMatchaAssets, maxWordLength } = await loadReading()
    const { discoverOovAcousticLeads } = await loadFamilies()
    const assets = await loadMatchaAssets()
    const baseline = {
      ...assets,
      effective: new Map(assets.lexicon),
      maxLength: maxWordLength(assets.lexicon),
    }
    const leads = discoverOovAcousticLeads(corpus(), baseline, { limit: 50, minCount: 1 })
    const byWord = new Map<string, any>(
      leads.map((item: any) => [item.word, item] as [string, any]),
    )
    let found = 0
    let correct = 0
    for (const word of A_WORDS) {
      const lead = byWord.get(word)
      if (lead) found += 1
      if (lead?.grade === 'A') correct += 1
      expect(lead?.grade, word).toBe('A')
    }
    for (const word of B_WORDS) {
      const lead = byWord.get(word)
      if (lead) found += 1
      if (lead?.grade === 'B') correct += 1
      expect(lead?.grade, word).toBe('B')
    }
    // Shape-level recall/precision, not an acoustic ground truth.
    expect(found).toBe(A_WORDS.length + B_WORDS.length)
    expect(correct).toBe(found)
  })

  it('整句包络把吞并/弱爆破升级为 S，正常短 burst 为 A，正常为 B', async () => {
    const { severityFor } = await loadEnvelope()
    expect(severityFor({ verdict: 'weak-second', second: { ms: 140 } })).toBe('S')
    expect(severityFor({ verdict: 'merged', second: null })).toBe('S')
    expect(severityFor({ verdict: 'ok', second: { ms: 80 } })).toBe('A')
    expect(severityFor({ verdict: 'ok', second: { ms: 140 } })).toBe('B')
  })
})
