/**
 * Produces the string handed to a TTS engine. Display text is never modified.
 * Chinese dates and thousands-separated numbers are rewritten as Chinese
 * numerals because the engine misreads them ("8,500年" comes out as
 * 八五零零年), symbols it silently drops (%, ℃, currency, maths) are spelled
 * out when the text is Chinese, and gaps it voices as an extra syllable are
 * removed.
 */
// Chinese context is detected from Han characters or CJK typography, so a
// numeric-only line such as “12%。” is expanded while “50% off” is left alone.
const CJK_CONTEXT =
  /[\p{Script=Han}\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\uffe5]/u
// Matcha turns a gap between Han characters into an extra syllable ("序 言"
// comes out like "序托言"). The same happens after a digit ("200 年" gains an
// extra syllable between 0 and 年), so both kinds of gap are dropped.
const HAN_GAP = /(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu
const DIGIT_HAN_GAP =
  /(?<=\d)[ \t]+(?=\p{Script=Han})|(?<=\p{Script=Han})[ \t]+(?=\d)/gu
// A space that reaches Matcha is emitted as its own token, which the model
// voices as an "a"-like syllable: “（无关） 为争夺” is heard as 为A争夺.
// Chinese punctuation never takes spaces, so drop them on either side.
const CJK_PUNCTUATION_RANGE =
  '\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\u00b7\\u2013\\u2014\\u2018\\u2019\\u201c\\u201d\\u2026'
const PUNCT_GAP = new RegExp(
  `[ \\t]+(?=[${CJK_PUNCTUATION_RANGE}])|(?<=[${CJK_PUNCTUATION_RANGE}])[ \\t]+`,
  'gu',
)
// The engine stops at the comma in 6,500 and reads the pieces separately.
const THOUSANDS_SEPARATOR = /(?<=\d),(?=\d{3}(?:\D|$))/g
const GROUPED_NUMBER = /(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?(?![\d,])/g

const HAN = /\p{Script=Han}/u
const LATIN = /\p{Script=Latin}/u
const DIGITS = '零一二三四五六七八九'
// 2 reads 两 before measure words (两年、两百人、两万), but stays 二 for
// ordinals and calendar readings (第2、2月、2号、2楼、公元200年、星期2), for
// tens (20、20万), and in decimals, which the engine already reads correctly.
const LIANG_MEASURES = new Set(
  '个位名人只支枝条张本台辆架艘间家所座片场次遍趟回倍米里斤克吨升岁天夜年周分秒点度份层页行列排队组批套双对副幅篇首句段节课门科项款步声口碗杯瓶盒包袋桶盘块元角毛头匹峰波轮边面侧端极岸者方部类样种国公毫英美欧摄平立厘',
)
const TWO_PREFIX_GUARD = /(?:第|公元|公元前|星期|礼拜|周|分之)$/

const CIRCLED_NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

const UNIT_WORDS: Array<[string, string]> = [
  ['㎡', '平方米'],
  ['㎥', '立方米'],
  ['㎠', '平方厘米'],
  ['㎤', '立方厘米'],
  ['㎞', '公里'],
  ['㎝', '厘米'],
  ['㎜', '毫米'],
  ['㎏', '千克'],
  ['㎎', '毫克'],
  ['㎖', '毫升'],
  ['㎗', '分升'],
]

const FRACTION_WORDS: Array<[string, string]> = [
  ['½', '二分之一'],
  ['⅓', '三分之一'],
  ['⅔', '三分之二'],
  ['¼', '四分之一'],
  ['¾', '四分之三'],
  ['⅛', '八分之一'],
  ['⅜', '八分之三'],
  ['⅝', '八分之五'],
  ['⅞', '八分之七'],
]

function expandNumberUnit(input: string, symbol: string, word: string): string {
  return input.replaceAll(new RegExp(`(\\d[\\d.,]*)\\s*${symbol}`, 'g'), `$1${word}`)
    .replaceAll(symbol, word)
}

function expandSymbols(input: string): string {
  let text = input

  // Negative temperatures read as 零下 rather than 负, which sounds wrong.
  text = text
    .replace(/([-−])\s*(\d[\d.,]*)\s*℃/g, '零下$2摄氏度')
    .replace(/([-−])\s*(\d[\d.,]*)\s*℉/g, '零下$2华氏度')
    .replace(/([-−])\s*(\d[\d.,]*)\s*°\s*C\b/gi, '零下$2摄氏度')
    .replace(/([-−])\s*(\d[\d.,]*)\s*°\s*F\b/gi, '零下$2华氏度')
    .replace(/([-−])\s*(\d[\d.,]*)\s*°/g, '零下$2度')
    .replace(/(\d[\d.,]*)\s*℃/g, '$1摄氏度')
    .replace(/℃/g, '摄氏度')
    .replace(/(\d[\d.,]*)\s*℉/g, '$1华氏度')
    .replace(/℉/g, '华氏度')
    .replace(/(\d[\d.,]*)\s*°\s*C\b/gi, '$1摄氏度')
    .replace(/°\s*C\b/gi, '摄氏度')
    .replace(/(\d[\d.,]*)\s*°\s*F\b/gi, '$1华氏度')
    .replace(/°\s*F\b/gi, '华氏度')
    .replace(/(\d[\d.,]*)\s*°/g, '$1度')
    .replace(/°/g, '度')

  // ASCII unit spellings; compound and squared forms must run first so the
  // bare unit rules never leave a dangling “平方”.
  text = text
    .replace(/(\d[\d.,]*)\s*km\s*\/\s*h(?![A-Za-z])/gi, '$1公里每小时')
    .replace(/(\d[\d.,]*)\s*m\s*\/\s*s(?![A-Za-z])/gi, '$1米每秒')
    .replace(/(\d[\d.,]*)\s*km²/g, '$1平方公里')
    .replace(/(\d[\d.,]*)\s*m²/g, '$1平方米')
    .replace(/(\d[\d.,]*)\s*cm²/g, '$1平方厘米')
    .replace(/(\d[\d.,]*)\s*mm²/g, '$1平方毫米')
    .replace(/(\d[\d.,]*)\s*km³/g, '$1立方公里')
    .replace(/(\d[\d.,]*)\s*m³/g, '$1立方米')
    .replace(/(\d[\d.,]*)\s*cm³/g, '$1立方厘米')
    .replace(/(\d[\d.,]*)\s*mm³/g, '$1立方毫米')
    .replace(/(\d[\d.,]*)\s*km(?![A-Za-z])/gi, '$1公里')
    .replace(/(\d[\d.,]*)\s*cm(?![A-Za-z])/gi, '$1厘米')
    .replace(/(\d[\d.,]*)\s*mm(?![A-Za-z])/gi, '$1毫米')
    .replace(/(\d[\d.,]*)\s*kg(?![A-Za-z])/gi, '$1千克')
    .replace(/(\d[\d.,]*)\s*ml(?![A-Za-z])/gi, '$1毫升')
    .replace(/(\d[\d.,]*)\s*[Ll](?![A-Za-z])/g, '$1升')
    .replace(/(\d[\d.,]*)\s*m(?![A-Za-z])/g, '$1米')

  for (const [symbol, word] of UNIT_WORDS) {
    text = expandNumberUnit(text, symbol, word)
  }

  text = text
    .replace(/([-−])\s*(\d[\d.,]*)\s*[%％﹪]/g, '负百分之$2')
    .replace(/(\d[\d.,]*)\s*[%％﹪]/g, '百分之$1')
    .replace(/[%％﹪]/g, '百分之')
    .replace(/([-−])\s*(\d[\d.,]*)\s*‰/g, '负千分之$2')
    .replace(/(\d[\d.,]*)\s*‰/g, '千分之$1')
    .replace(/‰/g, '千分之')
    .replace(/[¥￥]\s*(\d[\d.,]*)/g, '$1元')
    .replace(/(\d[\d.,]*)\s*[¥￥]/g, '$1元')
    .replace(/\$\s*(\d[\d.,]*)/g, '$1美元')
    .replace(/(\d[\d.,]*)\s*\$/g, '$1美元')
    .replace(/€\s*(\d[\d.,]*)/g, '$1欧元')
    .replace(/(\d[\d.,]*)\s*€/g, '$1欧元')
    .replace(/£\s*(\d[\d.,]*)/g, '$1英镑')
    .replace(/(\d[\d.,]*)\s*£/g, '$1英镑')
    .replace(/±/g, '正负')
    .replace(/×/g, '乘')
    .replace(/÷/g, '除以')
    .replace(/≈/g, '约等于')
    .replace(/≤/g, '小于等于')
    .replace(/≥/g, '大于等于')
    .replace(/≠/g, '不等于')
    .replace(/√/g, '根号')
    .replace(/(\d)\s*[~～〜]\s*(?=\d)/g, '$1至')

  for (const [symbol, word] of FRACTION_WORDS) {
    text = text.replaceAll(symbol, word)
  }

  for (let index = 0; index < CIRCLED_NUMBERS.length; index += 1) {
    text = text.replaceAll(CIRCLED_NUMBERS[index]!, String(index + 1))
  }

  return text
}

function nearestChar(text: string, index: number, step: 1 | -1): string {
  let position = index
  while (position >= 0 && position < text.length && /[ \t]/.test(text[position]!)) {
    position += step
  }
  return text[position] ?? ''
}

/**
 * Numbers inside a mostly-Chinese sentence can still belong to an English
 * run ("He paid 1,000 dollars，然后离开"). Only rewrite them when the nearest
 * character is Chinese rather than Latin; sentence edges and punctuation fall
 * back to the Chinese reading.
 */
function isChineseNumberContext(text: string, start: number, end: number): boolean {
  const before = nearestChar(text, start - 1, -1)
  const after = nearestChar(text, end, 1)
  if (HAN.test(before) || HAN.test(after)) return true
  return !LATIN.test(before) && !LATIN.test(after)
}

const GROUP_UNITS = ['', '万', '亿', '万亿']
const SECTION_UNITS = ['千', '百', '十', '']

function sectionToChinese(section: string): string {
  let out = ''
  let pendingZero = false
  for (let index = 0; index < 4; index += 1) {
    const digit = Number(section[index])
    if (digit === 0) {
      if (out) pendingZero = true
      continue
    }
    if (pendingZero) {
      out += '零'
      pendingZero = false
    }
    out += DIGITS[digit] + SECTION_UNITS[index]
  }
  return out
}

function integerToChinese(digits: string): string {
  const trimmed = digits.replace(/^0+/, '')
  if (!trimmed) return '零'
  if (trimmed.length > 16) return trimmed

  const groups: string[] = []
  for (let end = trimmed.length; end > 0; end -= 4) {
    groups.unshift(trimmed.slice(Math.max(0, end - 4), end))
  }

  let out = ''
  let pendingZero = false
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!
    const value = Number(group)
    if (value === 0) {
      if (out) pendingZero = true
      continue
    }
    if (out && (pendingZero || value < 1000)) out += '零'
    out += sectionToChinese(group.padStart(4, '0')) + (GROUP_UNITS[groups.length - 1 - index] ?? '')
    pendingZero = false
  }
  return out.replace(/^一十/, '十')
}

// A leading 2 reads 两 (两千、两万、两百万), but tens keep 二 (二十万).
function withLiang(chinese: string): string {
  return chinese.startsWith('二') && !chinese.startsWith('二十')
    ? `两${chinese.slice(1)}`
    : chinese
}

function groupedNumberToChinese(integerPart: string, fraction?: string): string {
  const integer = withLiang(integerToChinese(integerPart.replace(/,/g, '')))
  if (!fraction) return integer
  const decimals = Array.from(fraction, (digit) => DIGITS[Number(digit)]).join('')
  return `${integer}点${decimals}`
}

function chineseYear(year: string): string {
  return Array.from(year, (digit) => DIGITS[Number(digit)]).join('')
}

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function chineseDate(year: string, month: number, day: number): string {
  return `${chineseYear(year)}年${integerToChinese(String(month))}月${integerToChinese(String(day))}日`
}

// Engines either skip the separators (2026-09-12 comes out as
// 二千零二十六零九十二) or misread dots as decimals (2026.09.12), so dates are
// rewritten as 二零二六年九月十二日 before they reach the model. A trailing
// year is read as month/day/year, and a leading number that cannot be a month
// flips it to day/month/year.
const DATE_YMD = /(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/g
const DATE_END_YEAR = /(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})(?!\d)/g
const DATE_CN_FULL = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g
const DATE_CN_MONTH = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月/g
const DATE_CN_MONTH_DAY = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g

function normalizeDates(input: string): string {
  let text = input.replace(
    DATE_YMD,
    (match, year: string, month: string, day: string, offset: number) => {
      const m = Number(month)
      const d = Number(day)
      if (!validMonthDay(m, d)) return match
      if (!isChineseNumberContext(input, offset, offset + match.length)) return match
      return chineseDate(year, m, d)
    },
  )

  text = text.replace(
    DATE_END_YEAR,
    (match, first: string, second: string, year: string, offset: number) => {
      const a = Number(first)
      const b = Number(second)
      const monthFirst = a <= 12 && b >= 1 && b <= 31
      const month = monthFirst ? a : b
      const day = monthFirst ? b : a
      if (!validMonthDay(month, day)) return match
      if (!isChineseNumberContext(text, offset, offset + match.length)) return match
      return chineseDate(year, month, day)
    },
  )

  text = text.replace(DATE_CN_FULL, (match, year: string, month: string, day: string) => {
    const m = Number(month)
    const d = Number(day)
    return validMonthDay(m, d) ? chineseDate(year, m, d) : match
  })

  text = text.replace(DATE_CN_MONTH, (match, year: string, month: string) => {
    const m = Number(month)
    return m >= 1 && m <= 12
      ? `${chineseYear(year)}年${integerToChinese(String(m))}月`
      : match
  })

  text = text.replace(DATE_CN_MONTH_DAY, (match, month: string, day: string) => {
    const m = Number(month)
    const d = Number(day)
    return validMonthDay(m, d)
      ? `${integerToChinese(String(m))}月${integerToChinese(String(d))}日`
      : match
  })

  return text
}

function twoToChinese(value: number): string {
  const thousands = Math.floor(value / 1000)
  const hundreds = Math.floor(value / 100) % 10
  const tens = Math.floor(value / 10) % 10
  const ones = value % 10

  let out = ''
  if (thousands) out += '两千'
  if (hundreds) {
    out += `${thousands ? DIGITS[hundreds] : '两'}百`
  } else if (thousands && (tens || ones)) {
    out += '零'
  }
  if (tens) {
    out += tens === 1 ? '一十' : `${DIGITS[tens]}十`
  } else if (hundreds && ones) {
    out += '零'
  }
  if (ones) out += DIGITS[ones]
  return out
}

function leadingTwoToLiang(digits: string): string | null {
  if (digits === '2') return '两'
  if ((digits.length === 3 || digits.length === 4) && digits.startsWith('2')) {
    return twoToChinese(Number(digits))
  }
  return null
}

function chineseDigits(digits: string): string {
  return Array.from(digits, (digit) => DIGITS[Number(digit)]).join('')
}

// 百分之12.5 must be spoken as 十二点五; plain decimals such as 3.14 are
// already read correctly by the engine and stay untouched.
function normalizePercentDecimals(input: string): string {
  return input.replace(
    /(百分之|千分之)(\d{1,6})\.(\d+)/g,
    (_match, prefix: string, integer: string, fraction: string) => {
      const integerPart = integer.replace(/^0+(?=\d)/, '')
      return `${prefix}${integerToChinese(integerPart)}点${chineseDigits(fraction)}`
    },
  )
}

// Phone and account-style numbers must be voiced digit by digit; otherwise
// the engine reads 13800138000 as one huge number. Only rewrite when Chinese
// context surrounds the match, so English lines keep their digits.
function normalizePhoneNumbers(input: string): string {
  const digitByDigit = (
    match: string,
    offset: number,
    digits: string,
  ): string =>
    isChineseNumberContext(input, offset, offset + match.length)
      ? chineseDigits(digits)
      : match

  return input
    .replace(/(?<!\d)(400)[-\s]?(\d{3})[-\s]?(\d{4})(?!\d)/g, (match, prefix: string, middle: string, tail: string, offset: number) =>
      digitByDigit(match, offset, `${prefix}${middle}${tail}`),
    )
    .replace(/(?<!\d)(0\d{2,3})[-\s]?(\d{7,8})(?!\d)/g, (match, area: string, local: string, offset: number) =>
      digitByDigit(match, offset, `${area}${local}`),
    )
    .replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/g, (match, digits: string, offset: number) =>
      digitByDigit(match, offset, digits),
    )
}

// 1/2 → 二分之一. A leading zero on either side usually means a bare date
// (09/12), which must not become a fraction.
function normalizeFractions(input: string): string {
  return input.replace(
    /(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/g,
    (match, numerator: string, denominator: string, offset: number) => {
      if (/^0\d/.test(numerator) || /^0\d/.test(denominator)) return match
      const top = Number(numerator)
      const bottom = Number(denominator)
      if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) {
        return match
      }
      if (!isChineseNumberContext(input, offset, offset + match.length)) return match
      return `${integerToChinese(String(bottom))}分之${integerToChinese(String(top))}`
    },
  )
}

// 3:30 → 三点半, 14:05 → 十四点零五分. Colons with seconds are left alone.
function normalizeTimes(input: string): string {
  return input.replace(
    /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)(?!:\d{2})/g,
    (match, hour: string, minute: string, offset: number) => {
      if (!isChineseNumberContext(input, offset, offset + match.length)) return match
      const prefix = integerToChinese(hour.replace(/^0(?=\d)/, ''))
      if (minute === '00') return `${prefix}点整`
      if (minute === '30') return `${prefix}点半`
      const minutes = Number(minute)
      return `${prefix}点${minutes < 10 ? '零' : ''}${integerToChinese(minute)}分`
    },
  )
}

// A leading minus reads 负, while an en dash between digits is a range.
// Dates and phone numbers are already rewritten before this runs.
function normalizeNumberSigns(input: string): string {
  return input
    .replace(/(?<=\d)[ \t]*[-–—][ \t]*(?=\d)/g, '至')
    .replace(/(?<![\d.A-Za-z])[-−](?=\s*\d)/g, '负')
}

// 6,500 → 六千五百, "200 年" → "200年", then 200 → 两百. Four-digit values
// only become 两 before 万/亿 or a measure word other than 年, so years such
// as 2026年 are still handed to the engine's date rules.
function normalizeNumbers(input: string): string {
  let text = normalizePercentDecimals(input)
  text = normalizePhoneNumbers(text)
  text = normalizeFractions(text)
  text = normalizeTimes(text)
  text = normalizeNumberSigns(text)

  const joined = text
    .replace(
      GROUPED_NUMBER,
      (match, integerPart: string, fraction: string | undefined, offset: number) => {
        if (!isChineseNumberContext(text, offset, offset + match.length)) return match
        return groupedNumberToChinese(integerPart, fraction)
      },
    )
    .replace(THOUSANDS_SEPARATOR, '')
    .replace(DIGIT_HAN_GAP, '')

  return joined.replace(
    /(?<![\d.])(\d{1,4})(?=\p{Script=Han})/gu,
    (match, digits: string, offset: number) => {
      if (!digits.startsWith('2') || digits.length === 2) return match

      const nextIndex = offset + digits.length
      const next = joined[nextIndex] ?? ''
      if (!HAN.test(next)) return match
      if (TWO_PREFIX_GUARD.test(joined.slice(0, offset))) return match
      if (next === '万' || next === '亿') {
        return leadingTwoToLiang(digits) ?? match
      }
      if (digits.length === 4) {
        if (next === '年' || !LIANG_MEASURES.has(next)) return match
      }
      if (
        joined.startsWith('年级', nextIndex) ||
        joined.startsWith('年度', nextIndex) ||
        joined.startsWith('次元', nextIndex)
      ) {
        return match
      }
      if (next === '点' && /\d/.test(joined[nextIndex + 1] ?? '')) return match

      const measured =
        LIANG_MEASURES.has(next) ||
        joined.startsWith('小时', nextIndex) ||
        joined.startsWith('星期', nextIndex) ||
        joined.startsWith('礼拜', nextIndex) ||
        /^(?:千克|千米|厘米|毫米|毫克|毫升|分升)/.test(joined.slice(nextIndex))
      return measured ? leadingTwoToLiang(digits) ?? match : match
    },
  )
}

export function normalizeSpeechText(input: string): string {
  const cleaned = input
    .replace(/[\u00a0\u2007\u202f\u3000]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '\n')
    .replace(/…+/g, '……')
    .replace(/\.{3,}/g, '……')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()

  const cjk = CJK_CONTEXT.test(cleaned)
  let text = cjk ? expandSymbols(cleaned) : cleaned
  // A bare date or grouped number has no Chinese context, but it still goes
  // to the Chinese voice. Only skip rewriting when the line contains Latin.
  if (cjk || !LATIN.test(cleaned)) {
    text = normalizeNumbers(normalizeDates(text))
  }
  return text.replace(HAN_GAP, '$1').replace(PUNCT_GAP, '').trim()
}
