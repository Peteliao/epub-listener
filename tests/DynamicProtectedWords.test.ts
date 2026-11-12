import { describe, expect, it } from 'vitest'
import {
  PROTECTED_WORDS,
  UTTERANCE_RESET_WORDS,
  WORD_BOUNDARY,
  UTTERANCE_RESET,
  applyUtteranceResets,
  overlayProtectedWords,
  preparePronunciationText,
  protectPronunciations,
} from '@/core/tts/pronunciationGuard'

describe('overlayProtectedWords（低档 ③ 动态词表）', () => {
  it('空 overlay 时返回静态表本身（可一键回退）', () => {
    expect(overlayProtectedWords(undefined)).toEqual([...PROTECTED_WORDS])
    expect(overlayProtectedWords('')).toEqual([...PROTECTED_WORDS])
  })

  it('只提取 2–6 字纯汉字词，忽略单字、注释、英文式行与非法词', () => {
    const overlay = [
      '# 注释',
      '会计 kuai4 ji4',
      '地 di4',                       // 单字，跳过
      'ABC a b c',                    // 非汉字，跳过
      'some || ə',                    // 英文式行，跳过
      '一二三四五六七 yi1 er2 san3 si4 wu5 liu4 qi1', // 7 字，跳过
      '占便宜 zhan4 pian2 yi',
      '',
    ].join('\n')
    const words = overlayProtectedWords(overlay, [])
    expect(words).toContain('会计')
    expect(words).toContain('占便宜')
    expect(words).not.toContain('地')
    expect(words).not.toContain('ABC')
    expect(words).not.toContain('一二三四五六七')
  })

  it('排除会切断复合词的裸词「便宜」', () => {
    const words = overlayProtectedWords('便宜 pian2 yi', [])
    expect(words).not.toContain('便宜')
  })

  it('长词优先排序，静态表始终保留', () => {
    const words = overlayProtectedWords('会计师 kuai4 ji4 shi1\n会计 kuai4 ji4', ['占便宜'])
    expect(words).toContain('占便宜')
    expect(words.indexOf('会计师')).toBeLessThan(words.indexOf('会计'))
    expect(new Set(words).size).toBe(words.length)
  })

  it('同一 overlay 生成确定性的相同词表', () => {
    const overlay = '会计 kuai4 ji4\n地盘 di4 pan2\n占便宜 zhan4 pian2 yi'
    expect(overlayProtectedWords(overlay)).toEqual(overlayProtectedWords(overlay))
  })
})

describe('preparePronunciationText 的可选词表', () => {
  it('默认行为与静态表完全一致（既有回归不变）', () => {
    const sentence = '自己只是占了点地盘；'
    expect(preparePronunciationText(sentence)).toBe(
      applyUtteranceResets(protectPronunciations(sentence)),
    )
  })

  it('动态词表只增加 U+200B，不改变 U+2060 语句重置决策', () => {
    const sentence = '他学会计出身的。'
    const dynamic = overlayProtectedWords('会计 kuai4 ji4\n学会 xue2 hui4')
    const baseline = preparePronunciationText(sentence)
    const extended = preparePronunciationText(sentence, dynamic)
    expect(baseline).not.toContain(UTTERANCE_RESET)
    expect(extended).not.toContain(UTTERANCE_RESET)
    expect(extended.split(WORD_BOUNDARY).length)
      .toBeGreaterThanOrEqual(baseline.split(WORD_BOUNDARY).length)
  })

  it('动态词在汉字后被插入零宽边界且保持幂等', () => {
    const dynamic = overlayProtectedWords('会计 kuai4 ji4')
    const sentence = '他学会计出身的。'
    const once = preparePronunciationText(sentence, dynamic)
    expect(once).toContain(`${WORD_BOUNDARY}会计`)
    expect(preparePronunciationText(once, dynamic)).toBe(once)
  })

  it('句首的动态词不插边界（避免开头断句）', () => {
    const dynamic = overlayProtectedWords('会计 kuai4 ji4')
    expect(preparePronunciationText('会计很重要。', dynamic)).toBe('会计很重要。')
  })

  it('resetWords 显式传入时仍按静态规则工作', () => {
    const sentence = '自己只是占了点地盘；'
    expect(preparePronunciationText(sentence, ['占便宜'], UTTERANCE_RESET_WORDS))
      .toBe(applyUtteranceResets(protectPronunciations(sentence, ['占便宜'])))
  })
})
