import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeLexiconOverlays } from '../src/core/tts/pinyinTones'
import {
  preparePronunciationText,
  protectPronunciations,
  PROTECTED_WORDS,
  UTTERANCE_RESET_WORDS,
} from '../src/core/tts/pronunciationGuard'

const root = process.cwd()

async function loadWordFamily() {
  return (await import('../scripts/lib/wordFamily.mjs')) as any
}

async function loadReading() {
  return (await import('../scripts/lib/reading.mjs')) as any
}

describe('人工覆盖表与整书自动生成 overlay 的合并顺序', () => {
  it('剔除整书表同名词，人工表排在最后，运行时与审计模型读到同一行', async () => {
    const { parseEntries, parseOverlay } = await loadReading()
    const curated = [
      '# 人工核过的表',
      '占便宜 " zhan4 pian2 yi',
      '小便宜 xiao3 pian2 yi',
    ].join('\n')
    const book = [
      '占便宜 zhan4 bian4 yi2',
      '小便宜 xiao3 pian2 yi0',
      '自定义词 zi4 ding4 yi4 ci2',
    ].join('\n')
    const merged = mergeLexiconOverlays(curated, book)
    expect(merged).not.toContain('bian4')
    expect(merged).not.toContain('yi0')
    expect(merged).toContain('自定义词 zi4 ding4 yi4 ci2')
    expect(merged.indexOf('自定义词')).toBeLessThan(merged.indexOf('占便宜'))
    // Runtime (Matcha map) keeps the LAST line; the audit helper keeps the FIRST.
    // With duplicates removed they must agree.
    const runtime = parseEntries(merged)
    const audit = parseOverlay(merged).entries
    for (const [word, reading] of [['占便宜', '" zhan4 pian2 yi'], ['小便宜', 'xiao3 pian2 yi']]) {
      expect(runtime.get(word), word).toBe(reading)
      expect(audit.get(word), word).toBe(reading)
    }
    expect(parseOverlay(merged).duplicates).toEqual([])
  })

  it('没有整书 overlay 时仍然只保留人工表行', () => {
    const merged = mergeLexiconOverlays('地盘 " di4 pan2\n', undefined)
    expect(merged).toBe('地盘 " di4 pan2')
    expect(mergeLexiconOverlays('地盘 " di4 pan2\n', '')).toBe('地盘 " di4 pan2')
  })

  it('AiModel.ts 真的用合并函数，不再直接拼接两份表', () => {
    const source = readFileSync(resolve(root, 'src/core/tts/AiModel.ts'), 'utf8')
    expect(source).toMatch(/mergeLexiconOverlays\s*\(/)
    expect(source).not.toMatch(/\[polyphoneOverlay,\s*bookOverlay/)
  })
})

describe('运行时文本镜像与真实 guard 逐字一致', () => {
  it('8 个词的全部语境 + 反馈原句 / 书中整块 / 地盘原句完全一致', async () => {
    const wf = await loadWordFamily()
    const lists = wf.loadWordLists()
    const sentences = [
      ...wf.WORD_FAMILY.flatMap((item: any) => item.contexts.map((c: any) => c.sentence)),
      wf.FEEDBACK_SENTENCE,
      wf.BOOK_BLOCK,
      wf.DIPAN_SENTENCE,
    ]
    for (const sentence of sentences) {
      expect(wf.protectPronunciations(sentence, lists.protectedWords), sentence)
        .toBe(protectPronunciations(sentence))
      expect(wf.prepareRuntimeText(sentence, lists), sentence)
        .toBe(preparePronunciationText(sentence))
    }
    expect(lists.protectedWords).toEqual([...PROTECTED_WORDS])
    expect(lists.resetWords).toEqual([...UTTERANCE_RESET_WORDS])
  })

  it('3 字「X地盘」同时登记保护与重置，否则 U+2060 会被跳过', async () => {
    const wf = await loadWordFamily()
    const lists = wf.loadWordLists()
    for (const word of ['抢地盘', '占地盘']) {
      expect(lists.protectedWords).toContain(word)
      expect(lists.resetWords).toContain(word)
      const sentence = wf.WORD_FAMILY.find((item: any) => item.word === word).contexts[1].sentence
      const prepared = preparePronunciationText(sentence)
      expect(prepared).toContain(wf.UTTERANCE_RESET)
      expect(wf.utteranceParts(prepared)).toHaveLength(2)
      expect(wf.appSegments(sentence, word, lists)[0].text).toContain(word)
    }
  })

  it('便宜族不进重置词表，反馈原句只插 U+200B', async () => {
    const wf = await loadWordFamily()
    const lists = wf.loadWordLists()
    for (const item of wf.WORD_FAMILY.filter((entry: any) => entry.family === '便宜')) {
      expect(lists.resetWords).not.toContain(item.word)
    }
    const prepared = preparePronunciationText(wf.FEEDBACK_SENTENCE)
    expect(prepared).toContain(wf.WORD_BOUNDARY)
    expect(prepared).not.toContain(wf.UTTERANCE_RESET)
  })
})

describe('8 个词条的最终词典与排除项', () => {
  it('每词有整词覆盖行，便=pian2 / 地=di4，音素数=字数', async () => {
    const { loadMatchaAssets, phoneticPhones } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    for (const item of wf.WORD_FAMILY) {
      const reading = assets.overlay.entries.get(item.word)
      expect(reading, item.word).toBeTruthy()
      const phones = phoneticPhones(reading)
      expect(phones, item.word).toHaveLength(Array.from(item.word).length)
      expect(phones[item.offset], item.word).toBe(item.phone)
      expect(phones, item.word).not.toContain('"')
      if (item.neutral) {
        expect(phones[item.offset + 1], item.word)
          .toBe(item.expectedNeutralPhone ?? 'yi')
      }
    }
  })

  it('便宜货是 A/B 确认的轻声例外，其余便宜族不再有 yi2', async () => {
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    expect(assets.overlay.entries.get('便宜货')).toBe('pian2 yi2 huo4')
    for (const word of ['小便宜', '捡便宜', '讨便宜', '贪便宜']) {
      expect(assets.overlay.entries.get(word), word).not.toContain('yi2')
    }
  })

  it('排除项不被词族扩散误伤', async () => {
    const { loadMatchaAssets, readingAt, parseOverlay } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    const overlay = parseOverlay(readFileSync(resolve(root, 'src/core/tts/polyphones.v1.txt'), 'utf8')).entries
    for (const [word, phone] of [
      ['便宜从事', 'bian4'], ['便宜施行', 'bian4'], ['便宜行事', 'bian4'], ['小便', 'bian4'],
    ] as const) {
      expect(assets.effective.get(word), word).toContain(phone)
    }
    expect(readingAt('长期地用盐不给钱。', '地', 1, assets.effective).phone).toBe('de')
    expect(assets.effective.get('地')).toBe('de')
    expect(overlay.has('地')).toBe(false)
    expect(assets.effective.get('便宜')).toBe('pian2 yi')
    expect(PROTECTED_WORDS).not.toContain('便宜')
    expect(wf.EXCLUSIONS.length).toBeGreaterThan(0)
  })
})

describe('逐词门禁接线', () => {
  it('audit-all 把词族逐词可听性列为必需门禁', () => {
    const source = readFileSync(resolve(root, 'scripts/audit-all.mjs'), 'utf8')
    expect(source).toContain('scripts/audit-word-family.mjs')
    const at = source.indexOf("name: '词族逐词可听性'")
    expect(at).toBeGreaterThan(-1)
    expect(source.slice(at, at + 800)).toMatch(/required:\s*true/)
  })

  it('门禁名不与任何已有的 --only= 过滤子串冲突', () => {
    const name = '词族逐词可听性'
    for (const filter of ['反馈原句可听性', '历史基线', 'P3', '反馈闭环']) {
      expect(name.includes(filter)).toBe(false)
    }
  })
})
