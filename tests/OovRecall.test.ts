import { describe, expect, it } from 'vitest'

async function loadRecall(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/oovRecall.mjs')
}

async function loadReading(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/reading.mjs')
}

describe('2026-11-23 第十六轮：OOV 未召回词抽样', () => {
  it('把被前词遮住的 OOV 词列入人工复听样本', async () => {
    const { collectRecallSample } = await loadRecall()
    const { loadMatchaAssets, maxWordLength } = await loadReading()
    const assets = await loadMatchaAssets()
    const baseline = {
      ...assets,
      effective: new Map(assets.lexicon),
      maxLength: maxWordLength(assets.lexicon),
    }
    // 说白 is a real dictionary span covering 白, so 白果 is an OOV word that
    // discoverOovAcousticLeads deliberately skips. It must show up as a missed
    // recall item instead of silently disappearing.
    const result = collectRecallSample(
      '他说白果很重要。\n老人坐在门口。\n他说立刻就会明白。',
      baseline,
      { sample: 10 },
    )
    const words = result.sample.map((item: any) => item.word)
    expect(words).toContain('白果')
    expect(words).not.toContain('老人')
    expect(words).not.toContain('坐在')
    expect(result.dictionary).toBeGreaterThan(0)
    expect(result.found).toBeGreaterThan(0)
    expect(result.missed).toBeGreaterThan(0)
    expect(result.sample.length).toBeLessThanOrEqual(10)
  })
})
