import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { overlayProtectedWords, preparePronunciationText, protectPronunciations, SEAMLESS_UTTERANCE_RESET, UTTERANCE_RESET, WORD_BOUNDARY } from '@/core/tts/pronunciationGuard'
// @ts-ignore -- dev-only ESM helper has no type declarations
import { loadMatchaAssets, parseOverlay, readingAt } from '../scripts/lib/reading.mjs'
// @ts-ignore -- dev-only ESM helper has no type declarations
import { sentenceTokens } from '../scripts/lib/fusionRisk.mjs'

const root = process.cwd()
const overlayText = readFileSync(resolve(root, 'src/core/tts/polyphones.v1.txt'), 'utf8')
const overlay = parseOverlay(overlayText).entries as Map<string, string>
const S3_FULL = '她涂上薄薄的酱汁，对折，再以咖啡色纸包起来，说声‘好了”，把饼递给笹垣。'
const S4_FULL = '“谢天谢地，得救了。”草薙直起身子，拍打了两下腰际。'

describe('2026-11-25 第十一轮朗读反馈', () => {
  it('钉住四词的读音和经过验证的静音边界', () => {
    expect(overlay.get('一倒')).toBe('yi4 dao3 "')
    expect(overlay.get('谢天谢地')).toBe('" xie4 tian1 xie4 di4')
    expect(overlay.get('递给')).toBe('di4 gei3')
    expect(overlay.get('谢地')).toBe('xie4 di4')
    expect(overlay.get('笹垣')).toBe('ti4 yuan2 "')
  })

  it('在完整反馈句里解析出正确读音', async () => {
    const assets = await loadMatchaAssets()
    expect(readingAt('富檉鸣地闷哼一声，往后一倒，双手拼命拉扯电线。', '一', 1, assets.effective).phone).toBe('yi4')
    expect(readingAt('富檉鸣地闷哼一声，往后一倒，双手拼命拉扯电线。', '倒', 1, assets.effective).phone).toBe('dao3')
    expect(readingAt('说声“好了”，把饼递给笹垣。', '递', 1, assets.effective).phone).toBe('di4')
    expect(readingAt('说声“好了”，把饼递给笹垣。', '笹', 1, assets.effective).phone).toBe('ti4')
    expect(readingAt('“谢天谢地，得救了。”', '地', 1, assets.effective).phone).toBe('di4')
    expect(readingAt(S3_FULL, '递', 1, assets.effective).phone).toBe('di4')
    expect(readingAt(S4_FULL, '地', 1, assets.effective).phone).toBe('di4')
    expect(readingAt('谢地', '地', 1, assets.effective).phone).toBe('di4')
  })

  it('四个多字词都进入动态整词保护且保持幂等', () => {
    const dynamic = overlayProtectedWords(overlayText)
    for (const word of ['一倒', '谢天谢地', '递给', '笹垣']) {
      expect(dynamic).toContain(word)
    }
    const once = preparePronunciationText('把饼递给笹垣。', dynamic)
    expect(once).toContain(`${WORD_BOUNDARY}递给`)
    expect(preparePronunciationText(once, dynamic)).toBe(once)
  })

  it('第3句在自然逗号处重置谓语，递给不加静音边界', () => {
    const prepared = preparePronunciationText(S3_FULL, ['递给', '笹垣'])
    expect(prepared).toBe(
      `她涂上薄薄的酱汁，对折，再以咖啡色纸包起来，说声‘好了”，${UTTERANCE_RESET}把饼${WORD_BOUNDARY}递给${WORD_BOUNDARY}笹垣。`,
    )
    expect(prepared).not.toContain(SEAMLESS_UTTERANCE_RESET)
    expect(preparePronunciationText(prepared, ['递给', '笹垣'])).toBe(prepared)
  })

  it('第4句只拆谢天与谢地并做无缝拼接，不插入词内停顿', () => {
    const prepared = preparePronunciationText(S4_FULL, ['谢天谢地', '谢地'])
    expect(prepared).toBe(
      `“谢天${SEAMLESS_UTTERANCE_RESET}谢地，得救了。”草薙直起身子，拍打了两下腰际。`,
    )
    expect(prepared).not.toContain(UTTERANCE_RESET)
    expect(preparePronunciationText(prepared, ['谢天谢地', '谢地'])).toBe(prepared)
  })

  it('不把万一倒闭误拆成万一 + 一倒 + 闭', async () => {
    const assets = await loadMatchaAssets()
    const dynamic = overlayProtectedWords(overlayText)
    const text = '万一倒闭。'
    expect(protectPronunciations(text, ['一倒'])).toBe(text)
    const prepared = preparePronunciationText(text, dynamic)
    expect(prepared).toBe(text)
    const { tokens, ranges } = sentenceTokens(prepared, assets.effective, assets.maxLength)
    expect(ranges.map((range: { word: string }) => range.word)).toEqual(['万一', '倒闭', '。'])
    expect(tokens).toEqual(['wan4', 'yi1', 'dao3', 'bi4', '.'])
  })

  it('谢天谢地保留三条完整语境和已确认的词首修复依据', () => {
    const source = readFileSync(resolve(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
    const cases = source.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line))
    const item = cases.find((entry) => entry.id === 'om-0008')
    expect(item).toMatchObject({
      status: 'confirmed',
      word: '谢天谢地',
      phone: 'di4',
      repair: { kind: 'lead', after: 0, reading: '" xie4 tian1 xie4 di4' },
      baselineMs: [267, 174, 70, 163],
      fixedMs: [128, 221, 174, 163],
    })
    expect(item.sentences).toHaveLength(3)
    expect(item.contexts).toEqual(item.sentences)
  })

  it('第十二轮两条完整反馈句登记为待复听，不冒充已确认', () => {
    const source = readFileSync(resolve(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
    const cases = source.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line))
    expect(cases.find((entry) => entry.id === 'om-0009')).toMatchObject({
      status: 'needs-listening', word: '递给', phone: 'di4', measureAppSegment: true,
      repair: { kind: 'none', reading: 'di4 gei3' },
    })
    expect(cases.find((entry) => entry.id === 'om-0010')).toMatchObject({
      status: 'needs-listening', word: '谢地', phone: 'di4', measureAppSegment: true,
      repair: { kind: 'none', reading: 'xie4 di4' },
    })
  })
})
