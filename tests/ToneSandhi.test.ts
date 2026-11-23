import { describe, expect, it } from 'vitest'

async function loadReading(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/reading.mjs')
}

// 2026-11-23: common words that were absent from the base lexicon and therefore
// fell back to single-character citation tones.
const THIRD_THIRD: Record<string, string> = {
  很好: 'hen2 hao3',
  永远: 'yong2 yuan3',
  水果: 'shui2 guo3',
  领导: 'ling2 dao3',
  管理: 'guan2 li3',
  表演: 'biao2 yan3',
  展览: 'zhan2 lan3',
  舞蹈: 'wu2 dao3',
  小姐: 'xiao2 jie3',
  总统: 'zong2 tong3',
  想法: 'xiang2 fa3',
  手表: 'shou2 biao3',
  古老: 'gu2 lao3',
  勇敢: 'yong2 gan3',
  整理: 'zheng2 li3',
  选举: 'xuan2 ju3',
  辅导: 'fu2 dao3',
  指导: 'zhi2 dao3',
  彼此: 'bi2 ci3',
}

const YI_SANDHI: Record<string, string> = {
  一样: 'yi2 yang4',
  一天: 'yi4 tian1',
  一边: 'yi4 bian1',
}

describe('2026-11-23 第十三轮：三声连续与一/不变调', () => {
  it('3+3 常用词按 2+3 钉住，且覆盖基础单字兜底', async () => {
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    for (const [word, reading] of Object.entries(THIRD_THIRD)) {
      expect(assets.overlay.entries.get(word), word).toBe(reading)
      expect(assets.effective.get(word), word).toBe(reading)
    }
  })

  it('一/不 按后字调值钉住，避免 yi1/bu4 本调', async () => {
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    for (const [word, reading] of Object.entries(YI_SANDHI)) {
      expect(assets.overlay.entries.get(word), word).toBe(reading)
      expect(assets.effective.get(word), word).toBe(reading)
    }
    expect(assets.effective.get('不对')).toBe('bu2 dui4')
    expect(assets.effective.get('不好')).toBe('bu4 hao3')
    expect(assets.effective.get('不断')).toBe('bu2 duan4')
  })

  it('词族至少 20 条，且不引入单字覆盖', () => {
    expect(Object.keys(THIRD_THIRD).length + Object.keys(YI_SANDHI).length)
      .toBeGreaterThanOrEqual(20)
    for (const word of [...Object.keys(THIRD_THIRD), ...Object.keys(YI_SANDHI)]) {
      expect(Array.from(word).length, word).toBeGreaterThanOrEqual(2)
    }
  })
})
