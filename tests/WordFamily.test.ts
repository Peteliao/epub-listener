import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeLexiconOverlays } from '../src/core/tts/pinyinTones'
import {
  preparePronunciationText,
  protectPronunciations,
  PROTECTED_WORDS,
  UTTERANCE_RESET,
  UTTERANCE_RESET_WORDS,
  WORD_BOUNDARY,
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

describe('X便 + 宜 的抢词语境（第七轮）', () => {
  it('五个真实前端确认会抢词的组合，现在都回到 pian2', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    expect(wf.STEAL_CASES.length).toBe(5)
    for (const item of wf.STEAL_CASES) {
      const result = readingAt(item.phrase, '便', 1, assets.effective)
      expect(result.word, item.phrase).toBe(item.word)
      expect(result.phone, item.phrase).toBe('pian2')
      expect(assets.overlay.entries.get(item.word), item.phrase).toContain('pian2')
    }
  })

  it('真正的 X便 + 宜 不被扩散误伤，仍读 bian4', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    for (const item of wf.STEAL_EXCLUSIONS) {
      const result = readingAt(item.phrase, '便', 1, assets.effective)
      expect(result.word, item.phrase).toBe(item.word)
      expect(result.phone, item.phrase).toBe(item.phone)
    }
  })

  it('底层 X便 词条本身不被改动', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const assets = await loadMatchaAssets()
    expect(readingAt('甚为不便。', '便', 1, assets.effective).phone).toBe('bian4')
    expect(readingAt('请顺便带回来。', '便', 1, assets.effective).phone).toBe('bian4')
  })
})

describe('2026-11-11 第八轮：经历漏读（语句重置 + 双端边界）', () => {
  it('经历同时登记整词保护与语句重置', () => {
    expect(PROTECTED_WORDS).toContain('经历')
    expect(UTTERANCE_RESET_WORDS).toContain('经历')
    const prepared = preparePronunciationText('这是一段经历。')
    expect(prepared).toContain(`${UTTERANCE_RESET}${WORD_BOUNDARY}经历`)
  })

  it('覆盖表行是双端边界，且 appSegments 取到含经历的尾段', async () => {
    const { loadMatchaAssets } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    expect(assets.overlay.entries.get('经历')).toBe('" jing1 li4 "')
    const sentence = '饱经风霜的张学良曾经用他一生的经历对日本的年轻人说：不要相信暴力。'
    const segments = wf.appSegments(sentence, '经历', wf.loadWordLists())
    expect(segments).toHaveLength(1)
    expect(segments[0].split).toBe(true)
    expect(segments[0].text).toContain('经历')
    expect(segments[0].text.startsWith(wf.WORD_BOUNDARY)).toBe(true)
  })

  it('om-0004 在漏读案例表里并声明按 App 分段测量', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const lines = readFileSync(resolve(process.cwd(), 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
      .split(/\r?\n/).filter((line) => line.startsWith('{'))
    const item = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === 'om-0004')
    expect(item?.word).toBe('经历')
    expect(item?.measureAppSegment).toBe(true)
    expect(item?.repair?.kind).toBe('both')
  })
})

describe('2026-11-11 第八轮：单字「长」', () => {
  it('反馈句的「长」解析为 chang2', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const assets = await loadMatchaAssets()
    expect(assets.overlay.entries.get('比他长')).toBe('bi3 ta1 chang2')
    const result = readingAt('修身养性，活得比他长就是了。', '长', 1, assets.effective)
    expect(result.word).toBe('比他长')
    expect(result.phone).toBe('chang2')
  })

  it('LONG_CASES 全部 cháng', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    for (const item of wf.LONG_CASES) {
      const result = readingAt(item.phrase, '长', item.occurrence ?? 1, assets.effective)
      expect(result.phone, item.phrase).toBe(item.phone)
    }
  })

  it('LONG_EXCLUSIONS 全部保持 zhǎng', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const assets = await loadMatchaAssets()
    for (const item of wf.LONG_EXCLUSIONS) {
      const result = readingAt(item.phrase, '长', 1, assets.effective)
      expect(result.phone, item.phrase).toMatch(new RegExp(item.pattern))
    }
  })
})

describe('2026-11-11 第九轮：单字「地」', () => {
  it('DI_CASES 全部 di4，边界与逐词 A/B 记录一致', async () => {
    const { loadMatchaAssets, readingAt } = await loadReading()
    const wf = await loadWordFamily()
    const { currentBoundary } = await import('../scripts/lib/omission.mjs') as any
    const assets = await loadMatchaAssets()
    for (const item of wf.DI_CASES) {
      const result = readingAt(item.contexts[0], '地', 1, assets.effective)
      expect(result.word, item.word).toBe(item.word)
      expect(result.phone, item.word).toBe('di4')
      const boundary = currentBoundary(assets.overlay.entries.get(item.word) ?? '')
      expect(boundary.kind, item.word).toBe(item.boundary)
    }
  })

  it('词首/双端边界的词都有已确认漏读案例', async () => {
    const wf = await loadWordFamily()
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const cases = readFileSync(
      resolve(process.cwd(), 'src/core/tts/omissionCases.v1.jsonl'), 'utf8',
    ).split(/\r?\n/).filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
    for (const item of wf.DI_CASES) {
      if (!['lead', 'both'].includes(item.boundary)) continue
      const found = cases.find((entry) => entry.word === item.word && entry.status === 'confirmed')
      expect(found, item.word).toBeTruthy()
      expect(['lead', 'both']).toContain(found?.repair?.kind)
    }
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
