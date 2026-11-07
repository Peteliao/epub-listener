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

// Matcha's space-format lexicon is stored with map assignment, so a later
// line replaces an earlier one for the same word (sherpa-onnx v2.0.0
// offline-tts-matcha-impl.h). The overlay is appended after duplicated lines
// are removed, which is why its entries always win.
function parseLexiconLastWins(): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of readModelFile(lexiconFile).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    entries.set(word, phones.join(' '))
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
const lexicon = parseLexiconLastWins()
const tokens = parseTokens()

const effective = new Map(lexicon)
for (const [word, reading] of overlay) effective.set(word, reading)
const maxPhraseLength = Math.max(
  ...Array.from(effective.keys(), (word) => Array.from(word).length),
)

interface TokenSpan {
  word: string
  start: number
  end: number
}

function tokenizeSpans(text: string): TokenSpan[] {
  const chars = Array.from(text)
  const result: TokenSpan[] = []
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
      const end = index + Array.from(matched).length
      result.push({ word: matched, start: index, end })
      index = end
    } else {
      result.push({ word: chars[index], start: index, end: index + 1 })
      index += 1
    }
  }
  return result
}

function tokenize(text: string): string[] {
  return tokenizeSpans(text).map((token) => token.word)
}

function readingAt(text: string, char: string, occurrence = 1): string {
  const chars = Array.from(text)
  let seen = 0
  let target = -1
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== char) continue
    seen += 1
    if (seen === occurrence) {
      target = index
      break
    }
  }
  if (target < 0) throw new Error(`“${char}”第 ${occurrence} 次未出现在 ${text}`)
  const token = tokenizeSpans(text).find(
    (span) => target >= span.start && target < span.end,
  )
  const reading = token ? effective.get(token.word) : undefined
  if (!token || !reading) {
    throw new Error(`无法确定“${text}”第 ${target + 1} 字的读音`)
  }
  return reading.split(' ')[target - token.start]
}



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

  it('keeps neutral readings inside the runtime token inventory', () => {
    // tokens.txt is the authoritative phone inventory: an untoned token is the
    // model's neutral-tone unit. The golden set pins the words that rely on it,
    // so a missing tone digit still surfaces as a reading regression.
    const offenders: string[] = []
    for (const [word, reading] of overlay) {
      for (const phone of reading.split(' ')) {
        if (/\d$/.test(phone)) continue
        if (!tokens.has(phone)) offenders.push(`${word}: ${phone}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('pins every base duplicate whose later line is stale', () => {
    // Matcha's map assignment lets the last line win. These words end with an
    // older reading in lexicon.v3.txt, so the overlay must carry the audited
    // one explicitly or the runtime silently uses the stale reading.
    const expected: Record<string, string> = {
      了解: 'liao2 jie3',
      可以: 'ke2 yi3',
      长者: 'zhang2 zhe3',
      姥姥: 'lao2 lao3',
      总得: 'zong2 dei3',
      地表水: 'di4 biao2 shui3',
      大夫: 'dai4 fu1',
      见得: 'jian4 de',
    }
    for (const [word, reading] of Object.entries(expected)) {
      expect(effective.get(word), word).toBe(reading)
    }
    // 地 defaults to the adverbial particle; noun compounds keep di4.
    expect(effective.get('地')).toBe('de')
    expect(effective.get('地图')).toBe('di4 tu2')
    expect(effective.get('得')).toBe('de')
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

  it('distinguishes the four readings of 着', () => {
    expect(effective.get('着重')).toBe('zhuo2 zhong4')
    expect(effective.get('着火')).toBe('zhao2 huo3')
    expect(overlay.get('看着')).toBe('kan4 zhe')
    expect(overlay.get('险着')).toBe('xian3 zhao1')
    expect(tokenize('他着重强调')).toContain('着重')
    expect(tokenize('他看着火堆')).toContain('看着')
    expect(tokenize('他看着火堆')).not.toContain('着火')
    expect(tokenize('他看着重物')).toContain('看着')
    expect(tokenize('他点着了火')).toContain('点着')
    expect(tokenize('这是一步险着')).toContain('险着')
    expect(tokenize('他借着火光')).toContain('借着')
    expect(tokenize('她含着眼泪')).toContain('含着')
    expect(tokenize('孩子们顺着小路走')).toContain('顺着')
  })

  it('keeps the particle 着 when the following syllable forms a 着-word', () => {
    expect(tokenize('素秋打着火把')).toContain('打着')
    expect(tokenize('素秋打着火把')).not.toContain('着火')
    expect(tokenize('他打着了火')).toContain('打着了')
    expect(tokenize('变着法子')).toContain('变着')
    expect(tokenize('戴着手表')).toContain('戴着')
    expect(tokenize('揉着眼窝')).toContain('揉着')
    expect(tokenize('咬着笔头')).toContain('咬着')
    expect(tokenize('凭借着手臂')).toContain('凭借着')
    expect(tokenize('翻找着什么')).toContain('找着什么')
    expect(tokenize('事情有着落了')).toContain('有着落')
    expect(tokenize('睁着眼睛')).toContain('睁着')
    expect(tokenize('迎着风')).toContain('迎着')
    expect(tokenize('压着嗓子')).toContain('压着')
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
      '看着',
      '险着',
    ]) {
      expect(overlay.has(word), word).toBe(true)
    }
  })

  it('reads the 19-sentence polyphone regression corpus correctly', () => {
    const cases: Array<{
      text: string
      readings: Array<[char: string, occurrence: number, phone: string]>
    }> = [
      {
        text: '小明是个好学生，最大的好奇心就是好读书',
        readings: [['好', 1, 'hao3'], ['好', 2, 'hao4'], ['好', 3, 'hao4']],
      },
      {
        text: '他着重强调，看着大火着起来却不走，是一步险着。',
        readings: [
          ['着', 1, 'zhuo2'],
          ['着', 2, 'zhe'],
          ['着', 3, 'zhao2'],
          ['着', 4, 'zhao1'],
        ],
      },
      {
        text: '调查显示，适当调整员工的声调培训和工作调动方案非常重要。',
        readings: [
          ['调', 1, 'diao4'],
          ['调', 2, 'tiao2'],
          ['调', 3, 'diao4'],
          ['调', 4, 'diao4'],
        ],
      },
      {
        text: '边塞的要塞交通闭塞，那个瓶塞也被软木塞塞得严实。',
        readings: [
          ['塞', 1, 'sai4'],
          ['塞', 2, 'sai4'],
          ['塞', 3, 'se4'],
          ['塞', 4, 'sai1'],
          ['塞', 5, 'sai1'],
          ['塞', 6, 'sai1'],
        ],
      },
      {
        text: '太阳落山时，他才发现自己落下了钥匙，落得个露宿街头的下场。',
        readings: [['落', 1, 'luo4'], ['落', 2, 'la4'], ['落', 3, 'luo4']],
      },
      {
        text: '澄清池里的水十分澄清，我们必须彻底澄清这个谣言。',
        readings: [['澄', 1, 'cheng2'], ['澄', 2, 'cheng2'], ['澄', 3, 'cheng2']],
      },
      {
        text: '猫咪伸出爪子挠人，鸡爪子和机械手爪却不是一个概念。',
        readings: [['爪', 1, 'zhua3'], ['爪', 2, 'zhua3'], ['爪', 3, 'zhao3']],
      },
      {
        text: '妈妈用熨斗熨平了衣服，心里感到十分熨帖。',
        readings: [['熨', 1, 'yun4'], ['熨', 2, 'yun4'], ['熨', 3, 'yu4']],
      },
      {
        text: '单老师在单县读史书，看到匈奴单于的故事，觉得单靠武力不行。',
        readings: [
          ['单', 1, 'shan4'],
          ['单', 2, 'shan4'],
          ['单', 3, 'chan2'],
          ['单', 4, 'dan1'],
        ],
      },
      {
        text: '安徽六安与南京六合之间，相距六十六公里。',
        readings: [
          ['六', 1, 'lu4'],
          ['六', 2, 'lu4'],
          ['六', 3, 'liu4'],
          ['六', 4, 'liu4'],
        ],
      },
      {
        text: '解巡捕向官府解释，自己从未参与押解犯人的行动。',
        readings: [['解', 1, 'xie4'], ['解', 2, 'jie3'], ['解', 3, 'jie4']],
      },
      {
        text: '区先生刚搬到这个开发区，对周围的居民区还不熟悉。',
        readings: [['区', 1, 'ou1'], ['区', 2, 'qu1'], ['区', 3, 'qu1']],
      },
      {
        text: '仇先生劝大家放下仇恨，不要继续结仇。',
        readings: [['仇', 1, 'qiu2'], ['仇', 2, 'chou2'], ['仇', 3, 'chou2']],
      },
      {
        text: '浙江丽水风景秀丽，是个美丽的城市。',
        readings: [['丽', 1, 'li2'], ['丽', 2, 'li4'], ['丽', 3, 'li4']],
      },
      {
        text: '山西繁峙县人口繁殖迅速，产业欣欣向荣。',
        readings: [['峙', 1, 'shi4']],
      },
      {
        text: '做人要有宽广的气度，遇事要审时度势，才能以己度人。',
        readings: [['度', 1, 'du4'], ['度', 2, 'duo2'], ['度', 3, 'duo2']],
      },
      {
        text: '这水沟散发着恶臭，但他俩却臭味相投，宛如铜臭熏心。',
        readings: [['臭', 1, 'chou4'], ['臭', 2, 'chou4'], ['臭', 3, 'xiu4']],
      },
      {
        text: '悬崖勒马的勒痕深深印在绳索上，勒紧了战马。',
        readings: [['勒', 1, 'le4'], ['勒', 2, 'lei1'], ['勒', 3, 'lei1']],
      },
      {
        text: '盛老师端着盛满热汤的盛器，动作十分盛大庄重。',
        readings: [
          ['盛', 1, 'sheng4'],
          ['盛', 2, 'cheng2'],
          ['盛', 3, 'cheng2'],
          ['盛', 4, 'sheng4'],
        ],
      },
    ]
    for (const { text, readings } of cases) {
      for (const [char, occurrence, phone] of readings) {
        expect(
          readingAt(text, char, occurrence),
          `${text} 第 ${occurrence} 个“${char}”`,
        ).toBe(phone)
      }
    }
  })

  it('covers the wider polyphone families beyond the regression corpus', () => {
    const expected: Record<string, string> = {
      骨头: 'gu3 tou',
      灰蒙蒙: 'hui1 meng2 meng2',
      指缝: 'zhi3 feng4',
      古朴: 'gu2 pu3',
      刨平: 'pao2 ping2',
      摩挲: 'mo2 suo1',
      未成行: 'wei4 cheng2 xing2',
      红白相间: 'hong2 bai2 xiang1 jian4',
      想过重逢: 'xiang3 guo4 chong2 feng2',
      结实累累: 'jie1 shi lei2 lei2',
      好学生: 'hao3 xue2 sheng1',
      好学校: 'hao3 xue2 xiao4',
      好问: 'hao4 wen4',
      好管闲事: 'hao4 guan3 xian2 shi4',
      好面子: 'hao4 mian4 zi',
      好赌: 'hao4 du3',
      着起来: 'zhao2 qi3 lai2',
      调经: 'tiao2 jing1',
      调休: 'tiao2 xiu1',
      调酒师: 'tiao2 jiu3 shi1',
      调薪: 'tiao2 xin1',
      调低: 'tiao2 di1',
      调高: 'tiao2 gao1',
      调校: 'tiao2 jiao4',
      调弦: 'tiao2 xian2',
      软木塞: 'ruan3 mu4 sai1',
      落下钥匙: 'la4 xia4 yao4 shi',
      落下了钥匙: 'la4 xia4 le yao4 shi',
      落下钱包: 'la4 xia4 qian2 bao1',
      落在家里: 'la4 zai4 jia1 li3',
      落埋怨: 'lao4 man2 yuan4',
      不落忍: 'bu4 lao4 ren3',
      黄澄澄: 'huang2 deng1 deng1',
      澄清石灰水: 'deng4 qing1 shi2 hui1 shui3',
      把水澄清: 'ba2 shui3 deng4 qing1',
      爪子: 'zhua3 zi',
      机械手爪: 'ji1 xie4 shou2 zhao3',
      熨平: 'yun4 ping2',
      单老师: 'shan4 lao3 shi1',
      单县: 'shan4 xian4',
      单氏: 'shan4 shi4',
      南京六合: 'nan2 jing1 lu4 he2',
      六合区: 'lu4 he2 qu1',
      六合县: 'lu4 he2 xian4',
      解巡捕: 'xie4 xun2 bu3',
      解老师: 'xie4 lao3 shi1',
      区先生: 'ou1 xian1 sheng1',
      区女士: 'ou1 nv3 shi4',
      仇先生: 'qiu2 xian1 sheng1',
      仇老师: 'qiu2 lao3 shi1',
      繁峙县: 'fan2 shi4 xian4',
      度势: 'duo2 shi4',
      臭味相投: 'chou4 wei4 xiang1 tou2',
      铜臭味: 'tong2 xiu4 wei4',
      勒痕: 'lei1 hen2',
      勒住马: 'le4 zhu4 ma3',
      盛满: 'cheng2 man3',
      盛汤: 'cheng2 tang1',
      盛水: 'cheng2 shui3',
      盛老师: 'sheng4 lao3 shi1',
    }
    for (const [word, reading] of Object.entries(expected)) {
      expect(overlay.get(word), word).toBe(reading)
    }
  })

  it('avoids cross-word splits found by the sample-book scan', () => {
    const cases: Array<[text: string, char: string, occurrence: number, phone: string]> = [
      ['一段风干了数十年的骨头', '骨', 1, 'gu3'],
      ['灰蒙蒙的天空', '蒙', 1, 'meng2'],
      ['灰蒙蒙的天空', '蒙', 2, 'meng2'],
      ['指缝里溢出绝望的呜咽', '缝', 1, 'feng4'],
      ['那块古朴的木匾', '朴', 1, 'pu3'],
      ['木匠刨平了', '刨', 1, 'pao2'],
      ['像在摩挲一块顽石', '摩', 1, 'mo2'],
      ['那张未成行的车票', '行', 1, 'xing2'],
      ['红白相间的旧车票', '相', 1, 'xiang1'],
      ['构想过重逢', '重', 1, 'chong2'],
      ['结实累累', '累', 1, 'lei2'],
      ['结实累累', '累', 2, 'lei2'],
    ]
    for (const [text, char, occurrence, phone] of cases) {
      expect(readingAt(text, char, occurrence), text).toBe(phone)
    }
  })

  it('fixes the reported 反差 and 长出气 families', () => {
    expect(overlay.get('反差')).toBe('fan3 cha1')
    expect(overlay.get('差分放大器')).toBe('cha1 fen1 fang4 da4 qi4')
    expect(overlay.get('差失')).toBe('cha1 shi1')
    expect(overlay.get('差误')).toBe('cha1 wu4')
    expect(overlay.get('差官')).toBe('chai1 guan1')
    expect(overlay.get('长出了一口气')).toBe('chang2 chu1 le yi4 kou3 qi4')
    expect(overlay.get('长出一口气')).toBe('chang2 chu1 yi4 kou3 qi4')
    expect(overlay.get('长出了口气')).toBe('chang2 chu1 le kou3 qi4')
    expect(overlay.get('长舒一口气')).toBe('chang2 shu1 yi4 kou3 qi4')
    expect(overlay.get('长舒了一口气')).toBe('chang2 shu1 le yi4 kou3 qi4')
    expect(overlay.get('长吐一口气')).toBe('chang2 tu3 yi4 kou3 qi4')
    expect(overlay.get('长吐了一口气')).toBe('chang2 tu3 le yi4 kou3 qi4')
    expect(overlay.get('长吁一口气')).toBe('chang2 xu1 yi4 kou3 qi4')
    expect(overlay.get('长吁了一口气')).toBe('chang2 xu1 le yi4 kou3 qi4')

    expect(readingAt('造就了惊人的历史反差', '差', 1)).toBe('cha1')
    expect(readingAt('这是一台差分放大器', '差', 1)).toBe('cha1')
    expect(readingAt('若有差失，乞斩全家', '差', 1)).toBe('cha1')
    expect(readingAt('这是他的差误', '差', 1)).toBe('cha1')
    expect(readingAt('差官赶来', '差', 1)).toBe('chai1')
    expect(readingAt('幽冥王长出了一口气', '长', 1)).toBe('chang2')
    expect(readingAt('怎奈，秦国始终未能拿到督亢地图', '地', 1)).toBe('di4')
    expect(tokenize('怎奈，秦国始终未能拿到督亢地图')).toContain('地图')
    expect(readingAt('他长出一口气', '长', 1)).toBe('chang2')
    expect(readingAt('他长出了口气', '长', 1)).toBe('chang2')
    expect(readingAt('她长舒了一口气', '长', 1)).toBe('chang2')
    expect(readingAt('他长吐一口气', '长', 1)).toBe('chang2')
    expect(readingAt('老人长吁了一口气', '长', 1)).toBe('chang2')

    for (const [text, word] of [
      ['幽冥王长出了一口气', '长出了一口气'],
      ['他长出一口气', '长出一口气'],
      ['他长出了口气', '长出了口气'],
      ['她长舒了一口气', '长舒了一口气'],
      ['他长吐一口气', '长吐一口气'],
      ['老人长吁了一口气', '长吁了一口气'],
    ] as const) {
      expect(tokenize(text)).toContain(word)
    }
  })

  it('fixes the readings reported on 2026-11-02', () => {
    const expected: Record<string, string> = {
      偷偷: 'tou1 tou1',
      偷偷摸摸: 'tou1 tou1 mo1 mo1',
      有借有还: 'you3 jie4 you3 huan2',
      借了不还: 'jie4 le bu4 huan2',
      欠债不还: 'qian4 zhai4 bu4 huan2',
      欠钱不还: 'qian4 qian2 bu4 huan2',
      借钱不还: 'jie4 qian2 bu4 huan2',
      久借不还: 'jiu3 jie4 bu4 huan2',
      久欠不还: 'jiu3 qian4 bu4 huan2',
      到期不还: 'dao4 qi1 bu4 huan2',
      逾期不还: 'yu2 qi1 bu4 huan2',
      迟迟不还: 'chi2 chi2 bu4 huan2',
      一去不还: 'yi2 qu4 bu4 huan2',
      背约不还: 'bei4 yue1 bu4 huan2',
      十载: 'shi2 zai3',
      数载: 'shu4 zai3',
      几载: 'ji2 zai3',
      两载: 'liang2 zai3',
      三载: 'san2 zai3',
      五载: 'wu2 zai3',
      千载: 'qian1 zai3',
      一年半载: 'yi4 nian2 ban4 zai3',
      三年五载: 'san1 nian2 wu2 zai3',
      十年八载: 'shi2 nian2 ba1 zai3',
      千秋万载: 'qian1 qiu1 wan4 zai3',
      万载千秋: 'wan4 zai3 qian1 qiu1',
      连载: 'lian2 zai3',
      卸载: 'xie4 zai4',
      荷载: 'he4 zai4',
      载入史册: 'zai3 ru4 shi3 ce4',
      则填着: 'ze2 tian2 zhe',
      灰尘: 'hui1 chen2',
      长信: 'chang2 xin4',
      地址: 'di4 zhi3',
      一溜烟: 'yi2 liu4 yan1',
      玄奘: 'xuan2 zang4',
    }
    for (const [word, reading] of Object.entries(expected)) {
      expect(overlay.get(word), word).toBe(reading)
    }

    expect(readingAt('俺老孙定是有借有还的', '还', 1)).toBe('huan2')
    expect(readingAt('你为何背约不还', '还', 1)).toBe('huan2')
    expect(readingAt('他欠债不还', '还', 1)).toBe('huan2')
    expect(readingAt('这钱他迟迟不还', '还', 1)).toBe('huan2')
    expect(readingAt('他竟一去不还', '还', 1)).toBe('huan2')
    expect(readingAt('将这封寄往省城的长信', '长', 1)).toBe('chang2')
    expect(readingAt('忽已过去整整十载', '载', 1)).toBe('zai3')
    expect(readingAt('分别已数载', '载', 1)).toBe('zai3')
    expect(readingAt('千载难逢', '载', 1)).toBe('zai3')
    expect(readingAt('一溜烟出城了', '溜', 1)).toBe('liu4')
    expect(readingAt('地址是槐树巷十七号', '址', 1)).toBe('zhi3')
    expect(readingAt('玄奘', '奘', 1)).toBe('zang4')
    expect(readingAt('下载完成后卸载', '载', 2)).toBe('zai4')

    // The adverb 还 and the carry sense of 载 must not be captured by the
    // new phrase pins.
    expect(readingAt('俺你还信不过吗', '还', 1)).toBe('hai2')
    expect(readingAt('他还有情有义', '还', 1)).toBe('hai2')
    expect(readingAt('这封信还有下文', '还', 1)).toBe('hai2')
    expect(tokenize('他还有情有义')).not.toContain('还情')

    expect(tokenize('小白龙偷偷潜入了宫殿')).toContain('偷偷')
    expect(tokenize('寄件人一栏，则填着半山老屋的门牌')).toContain('则填着')
    expect(tokenize('灰尘在穿透破瓦漏下的惨白天光里')).toContain('灰尘')
    expect(tokenize('将这封寄往省城的长信投进了')).toContain('长信')
    expect(tokenize('忽已过去整整十载')).toContain('十载')
    expect(tokenize('你为何背约不还')).toContain('背约不还')
    expect(tokenize('地址是槐树巷十七号')).toContain('地址')
    expect(tokenize('一溜烟出城了')).toContain('一溜烟')
    expect(tokenize('玄奘')).toContain('玄奘')
    expect(tokenize('俺老孙定是有借有还的')).toContain('有借有还')
    expect(tokenize('三年五载')).toContain('三年五载')
    expect(tokenize('万载千秋')).toContain('万载千秋')
    expect(tokenize('下载完成后卸载')).toContain('卸载')
  })
})
