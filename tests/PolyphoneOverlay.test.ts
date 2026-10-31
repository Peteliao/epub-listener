import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ManifestFile {
  name: string
  url: string
}

interface ManifestPack {
  id: string
  files: ManifestFile[]
  model: { config: Record<string, string> }
}

const root = process.cwd()

const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/manifest.json'), 'utf8'),
) as { packs: ManifestPack[] }

const pack = manifest.packs.find((item) => item.id === 'matcha-icefall-zh-baker')!
const lexiconFile = pack.files.find(
  (file) => file.name === pack.model.config.lexicon,
)!
const tokensFile = pack.files.find((file) => file.name === 'tokens.txt')!

function readModelFile(file: ManifestFile): string {
  return readFileSync(resolve(root, 'public', file.url), 'utf8')
}

function parseOverlay(): Map<string, string> {
  const entries = new Map<string, string>()
  const source = readFileSync(
    resolve(root, 'src/core/tts/polyphones.v1.txt'),
    'utf8',
  )
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (entries.has(word)) throw new Error(`duplicate overlay word: ${word}`)
    entries.set(word, phones.join(' '))
  }
  return entries
}

function parseLexiconFirstWins(): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of readModelFile(lexiconFile).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    // sherpa-onnx ignores duplicated words, so the first entry is effective.
    if (!entries.has(word)) entries.set(word, phones.join(' '))
  }
  return entries
}

function parseTokens(): Set<string> {
  const tokens = new Set<string>()
  for (const line of readModelFile(tokensFile).split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0]
    if (token) tokens.add(token)
  }
  return tokens
}

const overlay = parseOverlay()
const lexicon = parseLexiconFirstWins()
const tokens = parseTokens()

const effective = new Map(lexicon)
for (const [word, reading] of overlay) effective.set(word, reading)
const maxPhraseLength = Math.max(
  ...Array.from(effective.keys(), (word) => Array.from(word).length),
)

function tokenize(text: string): string[] {
  const chars = Array.from(text)
  const result: string[] = []
  let index = 0
  while (index < chars.length) {
    let matched = ''
    for (let length = Math.min(maxPhraseLength, chars.length - index); length >= 1; length -= 1) {
      const candidate = chars.slice(index, index + length).join('')
      if (effective.has(candidate)) {
        matched = candidate
        break
      }
    }
    if (matched) {
      result.push(matched)
      index += Array.from(matched).length
    } else {
      result.push(chars[index])
      index += 1
    }
  }
  return result
}

const ATTESTED_NEUTRALS = new Set([
  'de', 'le', 'zhe', 'me', 'zi', 'men', 'ba', 'shi', 'yi', 'tou', 'jia', 'li',
])

describe('polyphone overlay', () => {
  it('uses the word-plus-phones format with one phone per character', () => {
    expect(overlay.size).toBeGreaterThan(150)
    const singleCharAllowed = new Map([['得', 'de']])
    const offenders: string[] = []
    for (const [word, reading] of overlay) {
      const chars = Array.from(word)
      if (chars.length !== reading.split(' ').length) {
        offenders.push(`${word}: ${reading}`)
      }
      if (chars.length < 2 && singleCharAllowed.get(word) !== reading) {
        offenders.push(`${word}: single char`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('only uses phones present in tokens.txt', () => {
    const missing = new Set<string>()
    for (const reading of overlay.values()) {
      for (const phone of reading.split(' ')) {
        if (!tokens.has(phone)) missing.add(phone)
      }
    }
    expect([...missing]).toEqual([])
  })

  it('only uses neutral phones attested in the base lexicon', () => {
    const offenders: string[] = []
    for (const [word, reading] of overlay) {
      for (const phone of reading.split(' ')) {
        if (!/\d$/.test(phone) && !ATTESTED_NEUTRALS.has(phone)) {
          offenders.push(`${word}: ${phone}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('never repeats an existing correct reading', () => {
    const redundant: string[] = []
    for (const [word, reading] of overlay) {
      if (lexicon.get(word) === reading) redundant.push(word)
    }
    expect(redundant).toEqual([])
  })

  it('encodes the intended readings for high-frequency polyphones', () => {
    expect(overlay.get('很长')).toBe('hen3 chang2')
    expect(overlay.get('长得')).toBe('zhang3 de')
    expect(overlay.get('长知识')).toBe('zhang3 zhi1 shi2')
    expect(overlay.get('长满')).toBe('zhang2 man3')
    expect(overlay.get('长不大')).toBe('zhang3 bu2 da4')
    expect(overlay.get('应了一声')).toBe('ying4 le yi4 sheng1')
    expect(overlay.get('应声')).toBe('ying4 sheng1')
    expect(overlay.get('背着')).toBe('bei1 zhe')
    expect(overlay.get('得问')).toBe('dei3 wen4')
    expect(overlay.get('教了')).toBe('jiao1 le')
    expect(overlay.get('照片')).toBe('zhao4 pian4')
    expect(overlay.get('时差')).toBe('shi2 cha1')
    expect(overlay.get('牛圈')).toBe('niu2 juan4')
    expect(overlay.get('圈养')).toBe('juan4 yang3')
    expect(overlay.get('蒙骗')).toBe('meng1 pian4')
    expect(overlay.get('铺开')).toBe('pu1 kai1')
    expect(overlay.get('一辈子')).toBe('yi2 bei4 zi')
    expect(overlay.get('晃了一下')).toBe('huang4 le yi2 xia4')
    expect(overlay.has('地')).toBe(false)
    expect(overlay.get('得')).toBe('de')
    expect(overlay.get('舍得')).toBe('she3 de')
    expect(overlay.get('过得去')).toBe('guo4 de qu4')
    expect(overlay.get('忽地')).toBe('hu1 de')
    expect(overlay.get('难得')).toBe('nan2 de2')
    expect(overlay.get('赢得')).toBe('ying2 de2')
    expect(overlay.get('少不得')).toBe('shao3 bu4 de')
    expect(overlay.get('不记得')).toBe('bu2 ji4 de')
    expect(overlay.get('地里')).toBe('di4 li3')
    expect(overlay.get('变得')).toBe('bian4 de')
    expect(overlay.get('得趁早')).toBe('dei3 chen4 zao3')
    expect(overlay.get('小心地')).toBe('xiao3 xin1 de')
    expect(overlay.get('慢慢地')).toBe('man4 man4 de')
    expect(overlay.get('高兴地')).toBe('gao1 xing4 de')
    expect(overlay.get('零零散散地')).toBe('ling2 ling2 san2 san3 de')
  })

  it('keeps particle 地 and 得 standalone under greedy phrase matching', () => {
    expect(tokenize('拖得很长')).toEqual(['拖', '得', '很长'])
    const particleCases: Array<[string, string]> = [
      ['零零散散地敲', '零零散散地'],
      ['小心地展开', '小心地'],
      ['远远地看', '远远地'],
      ['高兴地笑', '高兴地'],
      ['认真地点了点头', '认真地'],
      ['慢慢地点了点头', '慢慢地'],
      ['美美地睡了一觉', '美美地'],
    ]
    for (const [text, particleWord] of particleCases) {
      const words = tokenize(text)
      expect(words.filter((word) => word.includes('地')), text).toEqual([
        particleWord,
      ])
      expect(effective.get(particleWord)?.endsWith(' de'), text).toBe(true)
    }
    expect(tokenize('这个地点很好')).toContain('地点')
    for (const text of [
      '拖得很长',
      '磨得发白',
      '吹得轻轻晃了一下',
      '看得清楚',
    ]) {
      const withDe = tokenize(text).filter((word) => word.includes('得'))
      expect(withDe.length, text).toBe(1)
      // 看得清 is a real lexicon word that already carries a neutral de.
      expect(effective.get(withDe[0])?.split(' '), text).toContain('de')
    }
  })

  it('encodes the context readings for 落, 水准, 上去 and the line-measure 行', () => {
    expect(overlay.get('落了')).toBe('luo4 le')
    expect(overlay.get('落下')).toBe('luo4 xia4')
    expect(overlay.get('水准')).toBe('shui2 zhun3')
    expect(overlay.get('上去')).toBe('shang4 qu4')
    expect(overlay.get('第一行')).toBe('di4 yi1 hang2')
    expect(overlay.get('一行字')).toBe('yi4 hang2 zi4')
    expect(overlay.get('一行小字')).toBe('yi4 hang2 xiao3 zi4')
    expect(overlay.get('一行很小的字')).toBe('yi4 hang2 hen2 xiao3 de zi4')
    expect(overlay.get('那一行')).toBe('na4 yi4 hang2')
    // The group sense (“一行三人”) must keep its existing reading.
    expect(effective.get('一行')).toBe('yi4 xing2')

    expect(tokenize('山雨落了下来')).toContain('落了')
    expect(tokenize('送上去')).toEqual(['送', '上去'])
    expect(tokenize('写下第一行字')).toEqual(['写', '下', '第一行', '字'])
    expect(tokenize('纸上的一行小字')).toEqual(['纸', '上', '的', '一行小字'])
    expect(tokenize('一行三人')).toContain('一行')
  })

  it('uses the audited readings for 应允/长约 and keeps 3+3 sandhi', () => {
    expect(effective.get('应允')).toBe('ying1 yun3')
    expect(overlay.get('长约')).toBe('chang2 yue1')
    expect(overlay.get('老虎屁股摸不得')).toBe('lao2 hu3 pi4 gu3 mo1 bu4 de')
    expect(overlay.get('此地无银三百两')).toBe('ci3 di4 wu2 yin2 san1 bai2 liang3')
    expect(overlay.get('清清楚楚地')).toBe('qing1 qing1 chu2 chu3 de')
    expect(overlay.get('仔仔细细地')).toBe('zi2 zi3 xi4 xi4 de')
    expect(overlay.get('一行很小的字')).toBe('yi4 hang2 hen2 xiao3 de zi4')
  })

  it('corrects the 行星 and 悟空传 readings', () => {
    expect(overlay.get('九大行星')).toBe('jiu3 da4 xing2 xing1')
    expect(overlay.get('大行星')).toBe('da4 xing2 xing1')
    expect(overlay.get('悟空传')).toBe('wu4 kong1 zhuan4')
    expect(overlay.get('啪地')).toBe('pa1 de')
    expect(tokenize('九大行星中')).toEqual(['九大行星', '中'])
    expect(tokenize('悟空传')).toEqual(['悟空传'])
    expect(effective.get('行唐')).toBe('hang2 tang2')
  })

  it('reads the verse-final 还 in 照我还 as huán', () => {
    expect(overlay.get('照我还')).toBe('zhao4 wo3 huan2')
    expect(tokenize('明月何时照我还')).toContain('照我还')
    // The adverb 还 keeps its default reading everywhere else.
    expect(effective.get('还')).toBe('hai2')
  })

  it('reads 隐没 as mò, not méi', () => {
    expect(overlay.get('隐没')).toBe('yin3 mo4')
    expect(tokenize('月光隐没在云层里')).toContain('隐没')
  })

  it('keeps the audit-approved 3+3 sandhi readings', () => {
    const expected: Record<string, string> = {
      可以: 'ke2 yi3',
      了解: 'liao2 jie3',
      长者: 'zhang2 zhe3',
      地表水: 'di4 biao2 shui3',
      姥姥: 'lao2 lao3',
      总得: 'zong2 dei3',
    }
    for (const [word, reading] of Object.entries(expected)) {
      expect(effective.get(word), word).toBe(reading)
    }
  })

  it('covers the gaps found in the 多音字试读 audit', () => {
    const expected: Record<string, string> = {
      悠长: 'you1 chang2',
      绵长: 'mian2 chang2',
      长骨: 'chang2 gu3',
      加长: 'jia1 chang2',
      相当长: 'xiang1 dang1 chang2',
      略长: 'lve4 chang2',
      长胡子: 'chang2 hu2 zi',
      长头发: 'chang2 tou2 fa4',
      长尾巴: 'chang2 wei3 ba',
      变得长: 'bian4 de chang2',
      显得长: 'xian3 de chang2',
      得长: 'de chang2',
      长长地: 'chang2 chang2 de',
      好长: 'hao3 chang2',
      米长: 'mi3 chang2',
      厘米长: 'li2 mi3 chang2',
      公里长: 'gong1 li3 chang2',
      长葛: 'chang2 ge3',
      长垣: 'chang2 yuan2',
      子长: 'zi3 chang2',
      长沮: 'chang2 ju3',
      长年三老: 'chang2 nian2 san1 lao3',
      行唐: 'hang2 tang2',
      乐陵: 'lao4 ling2',
      仇英: 'qiu2 ying1',
      单田芳: 'shan4 tian2 fang1',
      解缙: 'xie4 jin4',
      区寄: 'ou1 ji4',
      查良镛: 'zha1 liang2 yong1',
      为人民: 'wei4 ren2 min2',
      量一下: 'liang2 yi2 xia4',
      好喝酒: 'hao4 he1 jiu3',
    }
    for (const [word, reading] of Object.entries(expected)) {
      expect(overlay.get(word), word).toBe(reading)
    }

    expect(tokenize('变得长')).toContain('变得长')
    expect(tokenize('拉得长')).toContain('得长')
    expect(tokenize('想象得长')).toContain('得长')
    expect(tokenize('三厘米长')).toContain('厘米长')
    expect(tokenize('一米长')).toContain('米长')
    expect(tokenize('为人民服务')).toContain('为人民')
    expect(tokenize('他为人正直')).toContain('为人')
    expect(tokenize('行唐县')).toContain('行唐')
    expect(tokenize('乐陵市')).toContain('乐陵')
    // The source document lists 长幼有序 under cháng, but 长幼 is zhǎng.
    expect(effective.get('长幼有序')).toBe('zhang3 you4 you3 xu4')
    expect(overlay.has('长幼有序')).toBe(false)
  })

  it('covers every polyphone failure found in the sample book', () => {
    for (const word of [
      '很长',
      '应了一声',
      '背着',
      '背一小袋',
      '得问',
      '教了',
      '教过',
      '教语文',
      '教低年级',
      '晃了一下',
      '落了',
      '落下',
      '水准',
      '上去',
      '第一行',
      '一行小字',
      '铺开',
    ]) {
      expect(overlay.has(word), word).toBe(true)
    }
  })
})
