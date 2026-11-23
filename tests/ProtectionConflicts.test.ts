import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  UTTERANCE_RESET,
  WORD_BOUNDARY,
  overlayProtectedWords,
  preparePronunciationText,
  protectPronunciations,
} from '../src/core/tts/pronunciationGuard'

function dynamicWords(): readonly string[] {
  const overlay = readFileSync(
    resolve(process.cwd(), 'src/core/tts/polyphones.v1.txt'),
    'utf8',
  )
  return overlayProtectedWords(overlay)
}

describe('2026-11-23 第十四轮：保护词重叠冲突矩阵', () => {
  const words = dynamicWords()
  const prepare = (text: string) => preparePronunciationText(text, words)

  it('学会计在句首不被短词会计切开', () => {
    expect(prepare('学会计的人')).toBe('学会计的人')
    expect(prepare('学会计的人')).not.toContain(`学${WORD_BOUNDARY}会计`)
  })

  it('长词前只插入一个边界，内部短词不重复插入', () => {
    const prepared = prepare('他学会计的人')
    expect(prepared).toContain(`${WORD_BOUNDARY}学会计`)
    expect(prepared).not.toContain(`学${WORD_BOUNDARY}会计`)
    expect(prepared.split(WORD_BOUNDARY).length - 1).toBe(1)
  })

  it('长期 + 发展组合不被拆成多个边界', () => {
    const prepared = prepare('公司里长期发展')
    expect(prepared).toContain(`里${WORD_BOUNDARY}长期`)
    expect(prepared.split(WORD_BOUNDARY).length - 1).toBe(1)
    expect(prepare(prepared)).toBe(prepared)
  })

  it('占便宜整体保留，边界只落在后面的独立保护词前', () => {
    const prepared = prepare('占便宜的地方')
    expect(prepared).toContain('占便宜')
    expect(prepared).not.toContain(`占${WORD_BOUNDARY}便宜`)
    expect(prepared).toContain(`${WORD_BOUNDARY}地方`)
  })

  it('地盘之争不触发地盘的重置，避免拆开复合词', () => {
    const prepared = prepare('地盘之争')
    expect(prepared).not.toContain(UTTERANCE_RESET)
    expect(prepared).toBe('地盘之争')
  })

  it('经历与长期相邻时只在长期前加边界，不拆经历', () => {
    const prepared = prepare('经历过长期发展')
    expect(prepared).toContain(`过${WORD_BOUNDARY}长期`)
    expect(prepared).not.toContain(`经${WORD_BOUNDARY}历`)
    expect(prepared).not.toContain(`${WORD_BOUNDARY}${WORD_BOUNDARY}`)
  })

  it('立刻与明白各自完整，不清空句首保护', () => {
    const prepared = prepare('立刻就会明白')
    expect(prepared.startsWith('立刻')).toBe(true)
    expect(prepared).not.toContain(`立${WORD_BOUNDARY}刻`)
    expect(prepared).toContain(`${WORD_BOUNDARY}明白`)
  })

  it('重复、嵌套与重叠词都只加必要边界，且按 Unicode 码点扫描', () => {
    expect(protectPronunciations('哈哈哈哈哈哈', ['哈哈']))
      .toBe(`哈哈${WORD_BOUNDARY}哈哈${WORD_BOUNDARY}哈哈`)
    expect(protectPronunciations('他学会计的人', ['会计', '学会计']))
      .toBe(`他${WORD_BOUNDARY}学会计的人`)
    // 𠀀 is an astral Han character; UTF-16 unit indexing would miss it.
    expect(protectPronunciations('𠀀立刻', ['立刻'])).toBe(`𠀀${WORD_BOUNDARY}立刻`)
    for (const text of ['哈哈哈哈哈', '他学会计的人', `𠀀${WORD_BOUNDARY}立刻`]) {
      const once = protectPronunciations(text, ['会计', '学会计', '立刻', '哈哈'])
      expect(protectPronunciations(once, ['会计', '学会计', '立刻', '哈哈']), text).toBe(once)
    }
  })

  it('重复调用是幂等的，不会累积零宽字符', () => {
    for (const text of [
      '学会计的人',
      '他学会计的人',
      '公司里长期发展',
      '占便宜的地方',
      '地盘之争',
      '经历过长期发展',
      '立刻就会明白',
    ]) {
      const once = prepare(text)
      expect(prepare(once), text).toBe(once)
    }
  })
})
