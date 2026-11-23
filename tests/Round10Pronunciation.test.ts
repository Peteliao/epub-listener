import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROTECTED_WORDS,
  WORD_BOUNDARY,
  overlayProtectedWords,
  preparePronunciationText,
} from '../src/core/tts/pronunciationGuard'

const root = process.cwd()

async function loadReading() {
  return (await import('../scripts/lib/reading.mjs')) as any
}

async function loadWordFamily() {
  return (await import('../scripts/lib/wordFamily.mjs')) as any
}

async function loadOmission() {
  return (await import('../scripts/lib/omission.mjs')) as any
}

async function loadIterationFamilies() {
  return (await import('../scripts/lib/iterationFamilies.mjs')) as any
}

function overlayText(): string {
  return readFileSync(resolve(root, 'src/core/tts/polyphones.v1.txt'), 'utf8')
}

describe('2026-11-23 第十轮：四条反馈的最终词典', () => {
  it('立刻 / 长期 / 陪酒那行 的覆盖行、读音与边界', async () => {
    const { loadMatchaAssets, phoneticPhones } = await loadReading()
    const wf = await loadWordFamily()
    const { currentBoundary } = await loadOmission()
    const assets = await loadMatchaAssets()
    for (const item of wf.ROUND10_CASES) {
      const reading = assets.overlay.entries.get(item.word)
      expect(reading, item.word).toBeTruthy()
      const phones = phoneticPhones(reading)
      expect(phones, item.word).toHaveLength(Array.from(item.word).length)
      expect(phones[item.offset], item.word).toBe(item.phone)
      expect(currentBoundary(reading).kind, item.word).toBe(item.boundary)
    }
    expect(assets.overlay.entries.get('立刻')).toBe('" li4 ke4 "')
    expect(assets.overlay.entries.get('长期')).toBe('chang2 qi1')
    expect(assets.overlay.entries.get('陪酒那行')).toBe('pei2 jiu3 na4 hang2 "')
  })

  it('发 = fà 头发义词族全部整词钉住，fā 语境一条不动', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    expect(wf.HAIR_FA_CASES.length).toBeGreaterThanOrEqual(18)
    for (const item of wf.HAIR_FA_CASES) {
      expect(assets.effective.get(item.word), item.word).toBe(item.reading)
    }
    for (const item of wf.HAIR_FA_EXCLUSIONS) {
      const result = readingAt(`${item.word}。`, '发', 1, assets.effective)
      expect(result.phone, item.word).toBe(item.phone)
    }
  })

  it('行业义「行」按搭配钉住，裸词「那行」的 xíng 歧义保留', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    expect(wf.HANG_INDUSTRY_CASES.length).toBeGreaterThanOrEqual(20)
    for (const item of wf.HANG_INDUSTRY_CASES) {
      const result = readingAt(
        `${item.word}。`, item.char, 1, assets.effective,
      )
      expect(result.phone, item.word).toBe(item.phone)
    }
    for (const item of wf.HANG_INDUSTRY_EXCLUSIONS) {
      const result = readingAt(item.phrase, item.char, item.occurrence, assets.effective)
      expect(result.phone, item.phrase).toBe(item.phone)
    }
    expect(readingAt('那行不行。', '行', 1, assets.effective).phone).toBe('xing2')
    expect(readingAt('生长期大约三个月。', '长', 1, assets.effective).phone).toBe('zhang3')
  })
})

describe('2026-11-23 第十轮：运行时保护与审计镜像一致', () => {
  it('长期 / 立刻 进入静态保护词表；覆盖表多字词进入动态保护词表', async () => {
    expect(PROTECTED_WORDS).toContain('长期')
    expect(PROTECTED_WORDS).toContain('立刻')
    const dynamic = overlayProtectedWords(overlayText())
    for (const word of ['长期', '立刻', '染发', '陪酒那行', '秀发']) {
      expect(dynamic, word).toContain(word)
    }
    // Bare 便宜 must never become a protected word: it would split 占便宜.
    expect(dynamic).not.toContain('便宜')
  })

  it('「店里长期」在静态/动态两条路径都能避免被「里长」抢走，镜像逐字一致', async () => {
    const { loadMatchaAssets, maxWordLength } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    const lists = wf.loadWordLists()
    const sentence = '有几家公司在店里长期订餐。'
    const staticPrepared = preparePronunciationText(sentence)
    expect(staticPrepared).toContain(`${WORD_BOUNDARY}长期`)
    const dynamicWords = overlayProtectedWords(overlayText())
    const dynamicPrepared = preparePronunciationText(sentence, dynamicWords)
    expect(dynamicPrepared).toContain(`${WORD_BOUNDARY}店里长期`)
    expect(wf.prepareRuntimeTextWithOverlay(sentence, assets, lists)).toBe(dynamicPrepared)
    // The mirror must still resolve 长 = chang2 after the boundary.
    const { readingAt } = await loadReading()
    expect(readingAt(dynamicPrepared, '长', 1, assets.effective).phone).toBe('chang2')
    // Pre-fix shape: without the curated rows, 里长 wins and 长 is zhǎng.
    const before = new Map(assets.lexicon)
    expect(readingAt(sentence, '长', 1, before).word).toBe('里长')
    expect(readingAt(sentence, '长', 1, before).phone).toBe('zhang3')
    expect(maxWordLength(assets.effective)).toBeGreaterThan(0)
  })

  it('立刻 / 陪酒那行 在动态保护路径插入 U+200B', async () => {
    const { loadMatchaAssets } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    const lists = wf.loadWordLists()
    const dynamic = overlayProtectedWords(overlayText())
    for (const [sentence, word] of [
      ['他立刻站了起来。', '立刻'],
      ['她说陪酒那行太辛苦。', '陪酒那行'],
    ] as const) {
      expect(preparePronunciationText(sentence, dynamic)).toContain(`${WORD_BOUNDARY}${word}`)
      expect(wf.prepareRuntimeTextWithOverlay(sentence, assets, lists))
        .toBe(preparePronunciationText(sentence, dynamic))
    }
  })
})

describe('2026-11-23 第十轮：两个新探测器在修复前基线仍能发现同类问题', () => {
  it('prefix-steal 能发现「里长 / 长期」与「学会 / 会计」', async () => {
    const { loadMatchaAssets, maxWordLength } = await loadReading()
    const wf = await loadIterationFamilies()
    const assets = await loadMatchaAssets()
    const baseline = {
      ...assets,
      effective: new Map(assets.lexicon),
      maxLength: maxWordLength(assets.lexicon),
    }
    const long = wf.discoverPrefixStealLeads(
      '有几家公司在店里长期订餐，必须在十二点之前送到。',
      baseline,
      { limit: 10 },
    )
    expect(long.some((item: any) =>
      item.word === '长期' && item.actual === '里长'
      && item.intendedPhone === 'chang2' && item.stolenPhone === 'zhang3')).toBe(true)
    const accounting = wf.discoverPrefixStealLeads(
      '可能是学会计出身的。', baseline, { limit: 10 },
    )
    expect(accounting.some((item: any) =>
      item.word === '会计' && item.actual === '学会'
      && item.intendedPhone === 'kuai4' && item.stolenPhone === 'hui4')).toBe(true)
  })

  it('OOV 声学盲区能发现音素看起来完全正确的「立刻」', async () => {
    const { loadMatchaAssets, maxWordLength } = await loadReading()
    const wf = await loadIterationFamilies()
    const assets = await loadMatchaAssets()
    const baseline = {
      ...assets,
      effective: new Map(assets.lexicon),
      maxLength: maxWordLength(assets.lexicon),
    }
    const leads = wf.discoverOovAcousticLeads(
      '来到此处，你立刻就会明白原因何在。\n他立刻站了起来。',
      baseline,
      { limit: 20, minCount: 1 },
    )
    const like = leads.find((item: any) => item.word === '立刻')
    expect(like).toBeTruthy()
    expect(like.phones.join(' ')).toBe('li4 ke4')
  })
})
