import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  extractRubyAnnotations,
  mergeRubyOverlays,
} from '@/core/reader/rubyAnnotations'
import { extractDocumentText } from '@/core/reader/plainText'

function doc(html: string): Document {
  return new DOMParser().parseFromString(
    `<html><body>${html}</body></html>`,
    'application/xhtml+xml',
  )
}

describe('ruby 注音抽取（中档 ①，仅拼音类）', () => {
  it('单字 ruby 转成覆盖行但不生成单字全局覆盖', () => {
    const d = doc('<p><ruby>汉<rt>hàn</rt></ruby>字句子</p>')
    const result = extractRubyAnnotations(d)
    expect(result.count).toBe(0)
    expect(result.skipped.singleChar).toBe(1)
    expect(result.overlay).toBe('')
  })

  it('多字 ruby + 单个 rt（按空格切分）', () => {
    const d = doc('<p><ruby>会计<rt>kuài jì</rt></ruby>正在核算</p>')
    const result = extractRubyAnnotations(d)
    expect(result.overlay).toBe('会计 kuai4 ji4')
    expect(result.count).toBe(1)
  })

  it('带调拼音、数字调与已训练轻声', () => {
    expect(extractRubyAnnotations(doc('<p><ruby>会计<rt>kuai4 ji4</rt></ruby>来了</p>')).overlay)
      .toBe('会计 kuai4 ji4')
    expect(extractRubyAnnotations(doc('<p><ruby>石头<rt>shí tou</rt></ruby>很重</p>')).overlay)
      .toBe('石头 shi2 tou')
  })

  it('多个 rt 逐字注音', () => {
    const d = doc('<p><ruby>重庆<rt>chóng</rt><rt>qìng</rt></ruby>很美</p>')
    expect(extractRubyAnnotations(d).overlay).toBe('重庆 chong2 qing4')
  })

  it('rp 回退括号被忽略', () => {
    const d = doc('<p><ruby>会计<rp>(</rp><rt>kuài jì</rt><rp>)</rp></ruby>来了</p>')
    expect(extractRubyAnnotations(d).overlay).toBe('会计 kuai4 ji4')
  })

  it('rt 数量与字数不匹配时跳过', () => {
    const d = doc('<p><ruby>会计<rt>kuài</rt></ruby>来了</p>')
    const result = extractRubyAnnotations(d)
    expect(result.count).toBe(0)
    expect(result.skipped.splitMismatch).toBeGreaterThan(0)
  })

  it('注音符号与假名被拒绝（用户选择：仅拼音类）', () => {
    const bopomofo = doc('<p><ruby>会计<rt>ㄎㄨㄞˋ ㄐㄧˋ</rt></ruby>来了</p>')
    const kana = doc('<p><ruby>会計<rt>かいけい</rt></ruby>です</p>')
    expect(extractRubyAnnotations(bopomofo).count).toBe(0)
    expect(extractRubyAnnotations(kana).count).toBe(0)
  })

  it('未训练轻声被拒绝', () => {
    const d = doc('<p><ruby>知道<rt>zhī dao</rt></ruby>了</p>')
    const result = extractRubyAnnotations(d)
    expect(result.count).toBe(0)
    expect(result.skipped.untrainedNeutral).toBeGreaterThan(0)
  })

  it('非汉字词与超长词被跳过', () => {
    const latin = doc('<p><ruby>ABC<rt>ei bi si</rt></ruby></p>')
    const long = doc('<p><ruby>一二三四五六七<rt>yī èr sān sì wǔ liù qī</rt></ruby></p>')
    expect(extractRubyAnnotations(latin).count).toBe(0)
    expect(extractRubyAnnotations(long).count).toBe(0)
  })

  it('同一词重复时保留一行、输出按词排序', () => {
    const d = doc('<p><ruby>会计<rt>kuài jì</rt></ruby>和<ruby>会计<rt>kuài jì</rt></ruby>与<ruby>地盘<rt>dì pán</rt></ruby></p>')
    const result = extractRubyAnnotations(d)
    expect(result.count).toBe(2)
    expect(result.skipped.duplicate).toBe(1)
    expect(result.overlay.split('\n')).toHaveLength(2)
  })

  it('绝不改变纯文本抽取（分句与高亮偏移不变）', () => {
    const html = '<p>汉<ruby>字<rt>zì</rt></ruby><br/>下一行</p>'
    expect(extractDocumentText(doc(html))).toBe('汉字\n下一行')
  })

  it('无 ruby 的文档返回空且不报错', () => {
    const result = extractRubyAnnotations(doc('<p>普通文本</p>'))
    expect(result.overlay).toBe('')
    expect(result.count).toBe(0)
    expect(extractRubyAnnotations(null).overlay).toBe('')
  })
})

describe('mergeRubyOverlays', () => {
  it('跨章节去重、后者覆盖、确定性排序', () => {
    const merged = mergeRubyOverlays([
      '会计 hui4 ji4\n地盘 di4 pan2',
      '# 注释',
      '会计 kuai4 ji4',
      '',
    ])
    expect(merged).toContain('会计 kuai4 ji4')
    expect(merged).toContain('地盘 di4 pan2')
    const words = merged.split('\n').map((line) => line.split(/\s+/)[0])
    expect(new Set(words).size).toBe(words.length)
    expect(mergeRubyOverlays(['', '会计 kuai4 ji4'])).toBe('会计 kuai4 ji4')
  })
})

describe('外部词组读音静态资产（中档 ②）', () => {
  const asset = readFileSync(
    resolve(process.cwd(), 'src/core/tts/phraseReadings.v1.txt'),
    'utf8',
  )
  const tokens = new Set(
    readFileSync(
      resolve(process.cwd(), 'public/models/matcha-icefall-zh-baker/tokens.txt'),
      'utf8',
    ).split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean),
  )
  const neutrals = new Set(
    readFileSync(resolve(process.cwd(), 'src/core/tts/trainedNeutrals.v1.txt'), 'utf8')
      .split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
  const curatedWords = new Set(
    readFileSync(resolve(process.cwd(), 'src/core/tts/polyphones.v1.txt'), 'utf8')
      .split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0]),
  )

  it('带 MIT 署名与来源记录', () => {
    expect(asset).toContain('mozillazg/phrase-pinyin-data')
    expect(asset).toContain('MIT License')
    expect(asset).toContain('Copyright (c) 2017 mozillazg')
    expect(asset).toContain('v0.20.0')
    expect(asset).toContain('SHA-256')
  })

  it('每一行都是纯汉字词 + 合法音素，且每词唯一', () => {
    const rows = asset.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    expect(rows.length).toBeGreaterThan(200)
    const words = new Set<string>()
    for (const row of rows) {
      const [word, ...phones] = row.split(/\s+/)
      expect(/^\p{Script=Han}{2,6}$/u.test(word)).toBe(true)
      expect(phones.length).toBe(Array.from(word).length)
      expect(phones.some((p) => p === '"')).toBe(false)
      for (const phone of phones) {
        expect(phone).toMatch(/^[a-z]+[1-4]?$/)
        expect(tokens.has(phone)).toBe(true)
        if (!/[1-4]$/.test(phone)) expect(neutrals.has(phone)).toBe(true)
      }
      expect(words.has(word)).toBe(false)
      words.add(word)
      expect(curatedWords.has(word)).toBe(false)
    }
  })

  it('不含「一/不」变调词与纯声调差异条目', () => {
    const rows = asset.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0])
    expect(rows.some((word) => /[一不]/.test(word))).toBe(false)
    expect(rows).not.toContain('那些')
  })

  it('确定性：按词排序', () => {
    const rows = asset.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0])
    expect(rows).toEqual([...rows].sort((a, b) => a.localeCompare(b, 'zh')))
  })
})
