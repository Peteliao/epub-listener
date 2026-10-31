import { OutputFormat, pinyin, segment } from 'pinyin-pro'

// Bump when the rules change so cached per-book overlays are regenerated.
export const BOOK_LEXICON_VERSION = 2
export const MAX_BOOK_OVERLAY_ENTRIES = 2000

const HAN = /\p{Script=Han}/u
const PINYIN_OPTIONS = { toneType: 'num', v: true } as const
const MAX_WORD_LENGTH = 4
const MAX_SENTENCE_LENGTH = 400
// Only neutral phones that the bundled lexicon/tokens actually attest.
const NEUTRAL_PHONES = new Set([
  'de', 'le', 'zhe', 'me', 'zi', 'men', 'ba', 'shi', 'yi', 'tou', 'jia', 'li',
])
const SANDHI_EXEMPT = new Set(['一', '不'])
// Single-character stems that only occur before particle 地.
const DE_SINGLE_CHAR_STEMS = new Set([
  '猛', '啪', '忽', '倏', '霍', '蓦', '突', '怎', '恁',
])
// 4-char stems starting with these read as fixed adverbial frames.
const DE_PATTERN_STARTS = new Set(['一', '不', '无', '有', '大', '小', '自'])
// After these characters 地 is far more likely to start a noun than to be a particle.
const DE_NON_PARTICLE_FOLLOWERS = new Set(Array.from('面之的'))
// Curated multi-character stems that are safe (and productive) before 地.
const DE_COMMON_STEMS = new Set([
  // 2-char adverbs and adjectives.
  '剧烈', '拼命', '小心', '平静', '详细', '耐心', '本能', '艰难', '吃力', '认真',
  '突兀', '缓慢', '清脆', '痛苦', '呆滞', '局促', '迟钝', '狰狞', '默契', '整齐',
  '无力', '残破', '笨拙', '坚定', '犹豫', '兴奋', '疲惫', '温柔', '愤怒', '惊讶',
  '疑惑', '尴尬', '无奈', '轻松', '沉重', '迅速', '果断', '从容', '熟练', '仔细',
  '马虎', '随意', '刻意', '故意', '连忙', '赶忙', '立即', '马上', '立刻', '徐徐',
  '冉冉', '翩翩', '风霜',
  // 3-char adjectives.
  '奇迹般', '孤零零', '硬邦邦', '颤巍巍', '扑簌簌', '慢吞吞', '湿漉漉', '黑压压',
  '亮晶晶', '绿油油', '红彤彤', '白茫茫', '金灿灿', '沉甸甸', '轻飘飘', '热腾腾',
  '冷冰冰', '急匆匆', '懒洋洋', '气冲冲', '兴冲冲', '笑眯眯', '醉醺醺', '毛茸茸',
  '雾蒙蒙', '水汪汪', '光秃秃', '脏兮兮', '香喷喷',
  // 4-char idioms.
  '小心翼翼', '生机勃勃', '气喘吁吁', '严丝合缝', '不厌其烦', '无精打采',
  '声嘶力竭', '紧锣密鼓', '欢天喜地', '乱七八糟', '不知所措', '毫不犹豫',
  '情不自禁', '不由自主', '专心致志', '聚精会神', '全神贯注', '漫不经心',
  '若无其事', '若有所思', '意味深长', '语重心长', '兴高采烈', '心平气和',
  '目不转睛', '屏息凝神', '蹑手蹑脚', '慢条斯理', '有条不紊', '从容不迫',
  '镇定自若', '手忙脚乱', '惊慌失措', '狼狈不堪', '筋疲力尽', '精疲力竭',
  '汗流浃背', '泪流满面', '热泪盈眶', '咬牙切齿', '勃然大怒', '暴跳如雷',
  '心满意足', '如释重负', '恍然大悟', '茅塞顿开', '目瞪口呆', '面面相觑',
  '异口同声', '不约而同', '煞有介事', '旁若无人', '目中无人', '自得其乐',
  '悠然自得', '怡然自得', '心安理得', '理直气壮', '义正词严', '苦口婆心',
  '循循善诱', '孜孜不倦', '锲而不舍', '持之以恒', '坚持不懈', '全心全意',
  '竭尽全力', '不遗余力', '费尽心机', '绞尽脑汁', '冥思苦想', '左思右想',
  '胡思乱想', '异想天开', '想入非非', '心不在焉', '三心二意', '一心一意',
  '半信半疑', '深信不疑', '毫无疑问', '不可否认', '不言而喻', '显而易见',
  '理所当然', '顺理成章', '水到渠成', '瓜熟蒂落', '一气呵成', '一鼓作气',
  '一蹴而就', '一劳永逸', '一举两得', '一箭双雕', '一石二鸟', '事半功倍',
  '事倍功半', '适得其反', '弄巧成拙', '画蛇添足', '多此一举', '锦上添花',
  '雪中送炭', '雨后春笋', '层出不穷', '络绎不绝', '川流不息', '人山人海',
  '门庭若市', '车水马龙', '鸦雀无声', '万籁俱寂', '寂静无声', '悄无声息',
  '轻手轻脚', '大步流星', '健步如飞', '风驰电掣', '电光石火', '瞬息万变',
  '变化多端', '五花八门', '各式各样', '各种各样', '形形色色', '林林总总',
])

interface Phone {
  base: string
  tone: number | null
}

interface PinyinItem {
  origin: string
  pinyin: string
  isZh: boolean
}

interface Token {
  word: string
  start: number
  end: number
}

interface Candidate {
  word: string
  reading: string
  count: number
}

export interface BookLexiconInput {
  /** Plain text per chapter, in reading order. */
  chunks: string[]
  lexiconText: string
  tokensText: string
  curatedOverlay: string
  maxEntries?: number
}

export interface BookLexiconStats {
  chars: number
  sentences: number
  oov: number
  entries: number
  discarded: number
  truncated: number
}

export interface BookLexiconResult {
  overlay: string
  entries: Candidate[]
  stats: BookLexiconStats
}

export interface BookLexiconRequest {
  type: 'generate'
  jobId: number
  chunks: string[]
  cacheName: string
  lexiconUrl: string
  tokensUrl: string
  curatedOverlay: string
}

export interface BookLexiconDone {
  type: 'done'
  jobId: number
  overlay: string
  entries: number
  stats: BookLexiconStats
}

export interface BookLexiconFailure {
  type: 'error'
  jobId: number
  message: string
}

export type BookLexiconResponse = BookLexiconDone | BookLexiconFailure

function splitPhone(phone: string): Phone {
  const lower = String(phone).toLowerCase().replace(/ü/g, 'v')
  const match = /^([a-z]+)([0-5])?$/.exec(lower)
  if (!match) return { base: lower, tone: null }
  const tone = match[2] === undefined ? null : Number(match[2])
  return { base: match[1], tone: tone === 0 || tone === 5 ? null : tone }
}

function phonesOf(reading: string): Phone[] {
  return reading.split(/\s+/).filter(Boolean).map(splitPhone)
}

function phoneText(phone: Phone): string {
  return phone.tone === null ? phone.base : `${phone.base}${phone.tone}`
}

function pinyinReading(text: string): Phone[] {
  return pinyin(text, { ...PINYIN_OPTIONS, type: 'array' }).map((item) =>
    splitPhone(String(item)),
  )
}

function isHanWord(word: string): boolean {
  const chars = Array.from(word)
  return chars.length >= 2 && chars.every((char) => HAN.test(char))
}

function parseLexicon(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    // sherpa-onnx keeps the first duplicate line, so the generator must too.
    if (!entries.has(word)) entries.set(word, phones.join(' '))
  }
  return entries
}

function parseTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0]
    if (token) tokens.add(token)
  }
  return tokens
}

function parseOverlay(source: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (!word || phones.length === 0 || entries.has(word)) continue
    entries.set(word, phones.join(' '))
  }
  return entries
}

/**
 * Characters whose reading in the curated overlay deviates from the lexicon's
 * single-character default. Their pinyin-pro reading cannot beat a human
 * choice, so generated entries must avoid touching them.
 */
function deriveReservedChars(
  curated: Map<string, string>,
  lexicon: Map<string, string>,
): Set<string> {
  const reserved = new Set<string>()
  for (const [word, reading] of curated) {
    const chars = Array.from(word)
    const phones = phonesOf(reading)
    if (phones.length !== chars.length) continue
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]
      if (SANDHI_EXEMPT.has(char)) continue
      const single = lexicon.get(char)
      if (!single) continue
      const base = phonesOf(single)[0]
      if (!base) continue
      const current = phones[index]
      if (current.base !== base.base) {
        reserved.add(char)
        continue
      }
      if (current.tone === base.tone) continue
      if (current.tone === null || base.tone === null) continue
      const next = phones[index + 1]
      if (current.tone === 2 && base.tone === 3 && next?.tone === 3) continue
      reserved.add(char)
    }
  }
  return reserved
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .split(/(?<=[。！？!?；;…\n])/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((sentence) => chunkSentence(sentence, MAX_SENTENCE_LENGTH))
}

function chunkSentence(sentence: string, max: number): string[] {
  const chars = Array.from(sentence)
  if (chars.length <= max) return [sentence]
  const chunks: string[] = []
  for (let index = 0; index < chars.length; index += max) {
    chunks.push(chars.slice(index, index + max).join(''))
  }
  return chunks
}

function tokenize(
  sentence: string,
  lexicon: Map<string, string>,
  maxLength: number,
): Token[] {
  const chars = Array.from(sentence)
  const tokens: Token[] = []
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    if (HAN.test(char)) {
      let matched = ''
      const limit = Math.min(maxLength, chars.length - index)
      for (let length = limit; length >= 1; length -= 1) {
        const candidate = chars.slice(index, index + length).join('')
        if (lexicon.has(candidate)) {
          matched = candidate
          break
        }
      }
      if (matched) {
        const length = Array.from(matched).length
        tokens.push({ word: matched, start: index, end: index + length })
        index += length
      } else {
        tokens.push({ word: char, start: index, end: index + 1 })
        index += 1
      }
      continue
    }
    tokens.push({ word: char, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

function applySandhi(phones: Phone[]): Phone[] {
  const result = phones.map((phone) => ({ ...phone }))
  for (let index = 0; index < result.length - 1; index += 1) {
    if (result[index].tone === 3 && result[index + 1].tone === 3) {
      result[index].tone = 2
    }
  }
  return result
}

function normalizeSandhiExempt(phones: Phone[]): Phone[] {
  const result = phones.map((phone) => ({ ...phone }))
  for (let index = 0; index < result.length; index += 1) {
    const phone = result[index]
    if (phone.tone !== null) continue
    if (phone.base !== 'yi' && phone.base !== 'bu') continue
    const next = result[index + 1]
    phone.tone = next?.tone === 4 ? 2 : 4
  }
  return result
}

function repeatedPositionPairs(stem: string): Array<[number, number]> {
  const chars = Array.from(stem)
  const pairs: Array<[number, number]> = []
  const add = (left: number, right: number) => {
    if (!pairs.some(([a, b]) => a === left && b === right)) {
      pairs.push([left, right])
    }
  }
  if (chars.length === 2 && chars[0] === chars[1]) {
    add(0, 1)
  } else if (chars.length === 3 && chars[1] === chars[2]) {
    add(1, 2)
  } else if (chars.length === 4) {
    if (chars[0] === chars[1] && chars[2] === chars[3]) {
      add(0, 1)
      add(2, 3)
    }
    if (chars[0] === chars[2] && chars[1] === chars[3]) {
      add(0, 2)
      add(1, 3)
    }
    if (chars[0] === chars[2]) add(0, 2)
    if (chars[2] === chars[3]) add(2, 3)
  }
  return pairs
}

function isAdverbialDeStem(stem: string): boolean {
  const chars = Array.from(stem)
  switch (chars.length) {
    case 1:
      return DE_SINGLE_CHAR_STEMS.has(stem)
    case 2:
      return chars[0] === chars[1] || DE_COMMON_STEMS.has(stem)
    case 3:
      return (
        DE_COMMON_STEMS.has(stem) ||
        (chars[0] === '一' && chars[1] === chars[2])
      )
    case 4: {
      const [a, b, c, d] = chars
      if (a === b && c === d) return true
      if (a === c && b === d) return true
      if (a === c && b === '里') return true
      if (a === c && DE_PATTERN_STARTS.has(a)) return true
      if (a === '东' && c === '西') return true
      if (a === '七' && c === '八') return true
      if (a === '千' && c === '万') return true
      return DE_COMMON_STEMS.has(stem)
    }
    default:
      return false
  }
}

function isAdverbialDeContext(chars: string[], deIndex: number): boolean {
  const next = chars[deIndex + 1]
  if (!next) return true
  if (!HAN.test(next)) return true
  return !DE_NON_PARTICLE_FOLLOWERS.has(next)
}

function readingsKey(phones: Phone[]): string {
  return phones.map(phoneText).join(' ')
}

export function generateBookLexicon(input: BookLexiconInput): BookLexiconResult {
  const maxEntries = input.maxEntries ?? MAX_BOOK_OVERLAY_ENTRIES
  const lexicon = parseLexicon(input.lexiconText)
  const tokens = parseTokens(input.tokensText)
  const curated = parseOverlay(input.curatedOverlay)
  const effective = new Map(lexicon)
  for (const [word, reading] of curated) effective.set(word, reading)
  const reserved = deriveReservedChars(curated, lexicon)

  let maxLexiconLength = 1
  for (const word of effective.keys()) {
    const length = Array.from(word).length
    if (length > maxLexiconLength) maxLexiconLength = length
  }

  const candidates = new Map<string, Candidate>()
  const discarded = new Set<string>()
  const discardedReadings = new Set<string>()
  const adverbialDe = new Set<string>()
  const standaloneCache = new Map<string, Phone[]>()
  const polyphonicCache = new Map<string, boolean>()
  const stats: BookLexiconStats = {
    chars: 0,
    sentences: 0,
    oov: 0,
    entries: 0,
    discarded: 0,
    truncated: 0,
  }

  function isPolyphonic(char: string): boolean {
    const cached = polyphonicCache.get(char)
    if (cached !== undefined) return cached
    const readings = new Set(
      pinyin(char, { ...PINYIN_OPTIONS, type: 'array', multiple: true }).map(
        (item) => phoneText(splitPhone(String(item))),
      ),
    )
    const result = readings.size > 1
    polyphonicCache.set(char, result)
    return result
  }

  function standaloneReading(word: string): Phone[] {
    const cached = standaloneCache.get(word)
    if (cached) return cached
    const readings = pinyinReading(word)
    standaloneCache.set(word, readings)
    return readings
  }

  function adverbialStemReading(stem: string): Phone[] {
    const known = effective.get(stem)
    if (known) {
      const phones = phonesOf(known)
      if (phones.length === Array.from(stem).length) return phones
    }
    return normalizeSandhiExempt(pinyinReading(stem))
  }

  function collectAdverbialDe(chars: string[]): void {
    if (!chars.includes('地')) return
    for (let deIndex = 1; deIndex < chars.length; deIndex += 1) {
      if (chars[deIndex] !== '地') continue
      if (!isAdverbialDeContext(chars, deIndex)) continue
      for (let length = 4; length >= 1; length -= 1) {
        const start = deIndex - length
        if (start < 0) continue
        const stemChars = chars.slice(start, deIndex)
        if (!stemChars.every((char) => HAN.test(char))) continue
        const stem = stemChars.join('')
        const word = `${stem}地`
        if (effective.has(word)) break
        if (!isAdverbialDeStem(stem)) continue
        const phones = adverbialStemReading(stem)
        if (phones.length !== length) break

        let consistent = true
        for (const [left, right] of repeatedPositionPairs(stem)) {
          if (
            phones[left].base !== phones[right].base ||
            phones[left].tone !== phones[right].tone
          ) {
            consistent = false
            break
          }
        }
        if (!consistent) break

        const output = applySandhi([...phones, { base: 'de', tone: null }])
        let valid = true
        for (const phone of output) {
          if (!tokens.has(phoneText(phone))) {
            valid = false
            break
          }
          if (phone.tone === null && !NEUTRAL_PHONES.has(phone.base)) {
            valid = false
            break
          }
        }
        if (!valid) break

        const reading = readingsKey(output)
        const existing = candidates.get(word)
        if (existing) {
          existing.count += 1
        } else {
          candidates.set(word, { word, reading, count: 1 })
        }
        adverbialDe.add(word)
        break
      }
    }
  }

  function reject(word: string): void {
    if (!discarded.has(word)) {
      discarded.add(word)
      stats.discarded += 1
    }
  }

  for (const chunk of input.chunks) {
    if (!chunk) continue
    stats.chars += Array.from(chunk).length
    for (const sentence of splitSentences(chunk)) {
      stats.sentences += 1
      const chars = Array.from(sentence)
      let words: string[]
      try {
        words = segment(sentence, {
          ...PINYIN_OPTIONS,
          format: OutputFormat.ZhSegment,
        })
      } catch {
        continue
      }
      if (words.join('') !== sentence) continue

      collectAdverbialDe(chars)

      const knownWord: boolean[] = new Array(chars.length).fill(false)
      for (const token of tokenize(sentence, effective, maxLexiconLength)) {
        if (Array.from(token.word).length < 2) continue
        for (let index = token.start; index < token.end; index += 1) {
          knownWord[index] = true
        }
      }

      const oovSegments: Array<{ word: string; start: number }> = []
      let offset = 0
      for (const word of words) {
        const start = offset
        const length = Array.from(word).length
        offset += length
        if (length < 2 || length > MAX_WORD_LENGTH) continue
        if (!isHanWord(word)) continue
        if (effective.has(word)) continue
        let covered = false
        for (let index = start; index < start + length; index += 1) {
          if (knownWord[index]) {
            covered = true
            break
          }
        }
        if (covered) continue
        oovSegments.push({ word, start })
      }
      if (!oovSegments.length) continue

      let alignment: PinyinItem[]
      try {
        alignment = pinyin(sentence, { ...PINYIN_OPTIONS, type: 'all' }) as unknown as PinyinItem[]
      } catch {
        continue
      }
      if (alignment.length !== chars.length) continue

      for (const { word, start } of oovSegments) {
        stats.oov += 1
        if (discarded.has(word) || discardedReadings.has(word)) continue
        const length = Array.from(word).length
        const span: Phone[] = []
        let aligned = true
        for (let index = start; index < start + length; index += 1) {
          const item = alignment[index]
          if (!item?.isZh || !item.pinyin) {
            aligned = false
            break
          }
          span.push(splitPhone(item.pinyin))
        }
        if (!aligned) continue

        const standalone = standaloneReading(word)
        if (readingsKey(span) !== readingsKey(standalone)) {
          // Context and dictionary disagree: the word's reading is ambiguous.
          discardedReadings.add(word)
          candidates.delete(word)
          stats.discarded += 1
          continue
        }

        const wordChars = Array.from(word)
        const engine: Phone[] = []
        let fallback = true
        for (const char of wordChars) {
          const reading = effective.get(char)
          const phone = reading ? phonesOf(reading)[0] : null
          if (!phone) {
            fallback = false
            break
          }
          engine.push(phone)
        }
        if (!fallback) continue

        const changed: number[] = []
        for (let index = 0; index < length; index += 1) {
          if (
            engine[index].base !== span[index].base ||
            engine[index].tone !== span[index].tone
          ) {
            changed.push(index)
          }
        }
        if (!changed.length) continue

        let accepted = true
        for (const index of changed) {
          const char = wordChars[index]
          if (reserved.has(char)) {
            accepted = false
            break
          }
          const reference = span[index]
          const current = engine[index]
          if (reference.tone === null && current.tone !== null) continue
          if (SANDHI_EXEMPT.has(char)) continue
          if (!isPolyphonic(char)) {
            accepted = false
            break
          }
        }
        if (!accepted) {
          reject(word)
          continue
        }

        const output = applySandhi(span)
        let valid = true
        for (const phone of output) {
          if (!tokens.has(phoneText(phone))) {
            valid = false
            break
          }
          if (phone.tone === null && !NEUTRAL_PHONES.has(phone.base)) {
            valid = false
            break
          }
        }
        if (!valid) {
          reject(word)
          continue
        }

        const reading = readingsKey(output)
        const existing = candidates.get(word)
        if (existing) {
          existing.count += 1
        } else {
          candidates.set(word, { word, reading, count: 1 })
        }
      }
    }
  }

  const sorted = Array.from(candidates.values()).sort((left, right) => {
    const leftDe = adverbialDe.has(left.word) ? 1 : 0
    const rightDe = adverbialDe.has(right.word) ? 1 : 0
    if (leftDe !== rightDe) return rightDe - leftDe
    if (left.count !== right.count) return right.count - left.count
    const lengthDiff =
      Array.from(right.word).length - Array.from(left.word).length
    if (lengthDiff !== 0) return lengthDiff
    return left.word.localeCompare(right.word, 'zh')
  })
  const selected = maxEntries > 0 ? sorted.slice(0, maxEntries) : []
  stats.truncated = sorted.length - selected.length
  stats.entries = selected.length

  const lines = selected
    .slice()
    .sort((left, right) => left.word.localeCompare(right.word, 'zh'))
    .map((entry) => `${entry.word} ${entry.reading}`)
  const overlay = lines.length
    ? `# 本书自动读音补充：词库未收录的词条，以及状语“地”的轻声读法。\n${lines.join('\n')}\n`
    : ''

  return { overlay, entries: selected, stats }
}
