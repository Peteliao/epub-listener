/**
 * Produces the English string handed to the offline Piper voice. The lexicon
 * covers words only, so digits, currency, and dates are dropped silently;
 * everything is therefore rewritten as spoken words before synthesis. Curly
 * apostrophes are straightened because the lexicon stores ASCII entries.
 */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
]

const SCALES: Array<[number, string]> = [
  [1_000_000_000_000, 'trillion'],
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
]

const ORDINAL_WORDS: Record<string, string> = {
  zero: 'zeroth',
  one: 'first',
  two: 'second',
  three: 'third',
  four: 'fourth',
  five: 'fifth',
  six: 'sixth',
  seven: 'seventh',
  eight: 'eighth',
  nine: 'ninth',
  ten: 'tenth',
  eleven: 'eleventh',
  twelve: 'twelfth',
  thirteen: 'thirteenth',
  fourteen: 'fourteenth',
  fifteen: 'fifteenth',
  sixteen: 'sixteenth',
  seventeen: 'seventeenth',
  eighteen: 'eighteenth',
  nineteen: 'nineteenth',
  twenty: 'twentieth',
  thirty: 'thirtieth',
  forty: 'fortieth',
  fifty: 'fiftieth',
  sixty: 'sixtieth',
  seventy: 'seventieth',
  eighty: 'eightieth',
  ninety: 'ninetieth',
  hundred: 'hundredth',
  thousand: 'thousandth',
  million: 'millionth',
  billion: 'billionth',
  trillion: 'trillionth',
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const MONTH_ABBREVIATIONS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Sept: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
}

const MONTH_PATTERN =
  'January|February|March|April|May|June|July|August|September|October|November|December'

function belowHundred(value: number): string {
  if (value < 20) return ONES[value]!
  const tens = Math.floor(value / 10)
  const ones = value % 10
  return ones ? `${TENS[tens]} ${ONES[ones]}` : TENS[tens]!
}

function belowThousand(value: number): string {
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  if (hundreds === 0) return belowHundred(rest)
  const head = `${ONES[hundreds]} hundred`
  return rest ? `${head} ${belowHundred(rest)}` : head
}

function digitWords(digits: string): string {
  return Array.from(digits, (digit) => ONES[Number(digit)] ?? '').join(' ')
}

export function integerToEnglishWords(value: number): string {
  const number = Math.trunc(Math.abs(value))
  if (!Number.isFinite(number)) return ''
  if (number === 0) return 'zero'
  if (number >= SCALES[0]![0] * 1000) return digitWords(String(number))

  let rest = number
  const parts: string[] = []
  for (const [size, name] of SCALES) {
    if (rest < size) continue
    parts.push(`${belowThousand(Math.floor(rest / size))} ${name}`)
    rest %= size
  }
  if (rest > 0) parts.push(belowThousand(rest))
  return parts.join(' ')
}

// 1984 reads nineteen eighty-four, 1905 nineteen oh five, 2005 two thousand
// five. Values in this range are years far more often than counts.
function yearWords(value: number): string {
  if (value >= 1100 && value <= 1999) {
    const high = Math.floor(value / 100)
    const low = value % 100
    if (low === 0) return `${ONES[high]} hundred`
    if (low < 10) return `${ONES[high]} oh ${ONES[low]}`
    return `${ONES[high]} ${belowHundred(low)}`
  }
  if (value >= 2000 && value <= 2099) {
    const low = value % 100
    if (low === 0) return 'two thousand'
    return `two thousand ${belowHundred(low)}`
  }
  return integerToEnglishWords(value)
}

function ordinalWords(value: number): string {
  const words = integerToEnglishWords(value)
  const parts = words.split(' ')
  const last = parts[parts.length - 1]!
  const ordinal = ORDINAL_WORDS[last]
  if (ordinal) {
    parts[parts.length - 1] = ordinal
    return parts.join(' ')
  }
  if (last.endsWith('y')) {
    parts[parts.length - 1] = `${last.slice(0, -1)}ieth`
    return parts.join(' ')
  }
  parts[parts.length - 1] = `${last}th`
  return parts.join(' ')
}

function decadeWords(start: number): string {
  if (start % 100 === 0) return `${yearWords(start)}s`
  return yearWords(start).replace(/y$/, 'ies')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function expandAbbreviations(input: string): string {
  let text = input
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\bvs\.?(?=\s|$)/gi, 'versus')
    .replace(/\betc\./gi, 'etcetera')
    .replace(/\bno\.(?=\s*\d)/gi, 'Number')
    .replace(/\ba\.m\./gi, 'A M')
    .replace(/\bp\.m\./gi, 'P M')
    .replace(/\bmr\./gi, 'Mister')
    .replace(/\bmrs\./gi, 'Missus')
    .replace(/\bms\./gi, 'Miz')
    .replace(/\bdr\./gi, 'Doctor')
    .replace(/\bprof\./gi, 'Professor')
    .replace(/\bjr\./gi, 'Junior')
    .replace(/\bsr\./gi, 'Senior')
    .replace(/\bmt\./gi, 'Mount')
    .replace(/\bave\./gi, 'Avenue')
    .replace(/\bblvd\./gi, 'Boulevard')
    .replace(/\brd\./gi, 'Road')
    .replace(/\bln\./gi, 'Lane')

  // St. is a saint before a name and a street after one ("Main St.").
  text = text
    .replace(/\bst\.(?=\s+[A-Z])/gi, 'Saint')
    .replace(/\bst\./gi, 'Street')

  return text.replace(
    /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\./g,
    (match, abbreviation: string) => {
      const month = MONTH_ABBREVIATIONS[abbreviation]
      return month ? MONTHS[month - 1]! : match
    },
  )
}

const FRACTIONS: Array<[string, string]> = [
  ['½', ' one half '],
  ['⅓', ' one third '],
  ['⅔', ' two thirds '],
  ['¼', ' one quarter '],
  ['¾', ' three quarters '],
  ['⅛', ' one eighth '],
  ['⅜', ' three eighths '],
  ['⅝', ' five eighths '],
  ['⅞', ' seven eighths '],
]

function expandCurrency(
  input: string,
  symbol: string,
  singular: string,
  plural: string,
): string {
  const escaped = escapeRegExp(symbol)
  const format = (amount: string): string => {
    const clean = amount.replace(/,/g, '').replace(/\.$/, '')
    const [whole = '0', fraction] = clean.split('.')
    const isSingle = Number(whole) === 1 && !fraction
    const unit = isSingle ? singular : plural
    if (fraction && fraction.length === 2) {
      return `${whole} ${unit} and ${fraction} cents`
    }
    if (fraction) return `${whole} point ${digitWords(fraction)} ${unit}`
    return `${whole} ${unit}`
  }

  return input
    .replace(
      new RegExp(`${escaped}\\s*(\\d[\\d,]*(?:\\.\\d{1,2})?)`, 'g'),
      (_match, amount: string) => format(amount),
    )
    .replace(
      new RegExp(`(?<![\\d.])(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*${escaped}`, 'g'),
      (_match, amount: string) => format(amount),
    )
}

function expandSymbols(input: string): string {
  let text = input

  text = text
    .replace(/(\d[\d,.]*)\s*°\s*C\b/g, '$1 degrees Celsius')
    .replace(/(\d[\d,.]*)\s*°\s*F\b/g, '$1 degrees Fahrenheit')
    .replace(/(\d[\d,.]*)\s*°/g, '$1 degrees')
    .replace(/°\s*C\b/g, 'degrees Celsius')
    .replace(/°\s*F\b/g, 'degrees Fahrenheit')
    .replace(/±/g, ' plus or minus ')
    .replace(/(?<=\d)\s*\+\s*(?=\d)/g, ' plus ')
    .replace(/(?<=\d)\s*[×x]\s*(?=\d)/g, ' times ')
    .replace(/(?<=\d)\s*÷\s*(?=\d)/g, ' divided by ')
    .replace(/(?<=\d)\s*=\s*(?=\d)/g, ' equals ')
    .replace(/≈/g, 'about')
    .replace(/≤/g, 'less than or equal to')
    .replace(/≥/g, 'greater than or equal to')
    .replace(/≠/g, 'not equal to')
    .replace(/&/g, ' and ')
    .replace(/(\d[\d,.]*)\s*%/g, '$1 percent')
    .replace(/%/g, ' percent')

  text = expandCurrency(text, '$', 'dollar', 'dollars')
  text = expandCurrency(text, '£', 'pound', 'pounds')
  text = expandCurrency(text, '€', 'euro', 'euros')
  text = expandCurrency(text, '¥', 'yen', 'yen')

  for (const [symbol, words] of FRACTIONS) {
    text = text.split(symbol).join(words)
  }
  return text
}

function expandTimes(input: string): string {
  return input.replace(
    /(?<!\d)(\d{1,2}):([0-5]\d)(?::[0-5]\d)?(?!\d)/g,
    (_match, hour: string, minute: string) => {
      const hourWords = belowHundred(Number(hour))
      if (minute === '00') return `${hourWords} o'clock`
      const minutes = Number(minute)
      if (minutes < 10) return `${hourWords} oh ${ONES[minutes]}`
      return `${hourWords} ${belowHundred(minutes)}`
    },
  )
}

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function expandDates(input: string): string {
  let text = input.replace(
    /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g,
    (match, year: string, month: string, day: string) => {
      const m = Number(month)
      const d = Number(day)
      if (!validMonthDay(m, d)) return match
      return `${MONTHS[m - 1]} ${ordinalWords(d)}, ${yearWords(Number(year))}`
    },
  )

  text = text.replace(
    /(?<!\d)(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?!\d)/g,
    (match, first: string, second: string, year: string) => {
      let month = Number(first)
      let day = Number(second)
      if (!validMonthDay(month, day) && validMonthDay(day, month)) {
        ;[month, day] = [day, month]
      }
      if (!validMonthDay(month, day)) return match
      return `${MONTHS[month - 1]} ${ordinalWords(day)}, ${yearWords(Number(year))}`
    },
  )

  const monthDay = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?!\\d|st|nd|rd|th)`,
    'gi',
  )
  return text.replace(monthDay, (_match, month: string, day: string) => {
    const value = Number(day)
    if (value < 1 || value > 31) return `${month} ${day}`
    return `${month} ${ordinalWords(value)}`
  })
}

function expandRanges(input: string): string {
  return input.replace(
    /(?<![\d.])(\d[\d,.]*)\s*[-–—]\s*(\d[\d,.]*)(?![\d.])/g,
    '$1 to $2',
  )
}

function convertNumbers(input: string): string {
  let text = input.replace(
    /\b(1\d{3}|20\d{2})s\b/g,
    (_match, decade: string) => decadeWords(Number(decade)),
  )

  text = text.replace(/'(\d0)s\b/g, (_match, decade: string) =>
    decadeWords(1900 + Number(decade)),
  )

  text = text.replace(
    /(?<![\d.])(\d{1,3})(st|nd|rd|th)\b/gi,
    (_match, digits: string, suffix: string) => {
      const value = Number(digits)
      const tens = value % 100
      const expected =
        tens >= 11 && tens <= 13
          ? 'th'
          : value % 10 === 1
            ? 'st'
            : value % 10 === 2
              ? 'nd'
              : value % 10 === 3
                ? 'rd'
                : 'th'
      if (suffix.toLowerCase() !== expected) return _match
      return ordinalWords(value)
    },
  )

  // Phone numbers and account numbers must be voiced digit by digit.
  text = text.replace(/(?<![\d,])(\d{7,})(?![\d,])/g, (digits) =>
    digitWords(digits),
  )

  text = text.replace(
    /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d+)(?![\w.])/g,
    (_match, whole: string, fraction: string) => {
      const integer = Number(whole.replace(/,/g, ''))
      return `${integerToEnglishWords(integer)} point ${digitWords(fraction)}`
    },
  )

  text = text.replace(
    /(?<![\w.,])(\d{1,3}(?:,\d{3})+)(?![\w.,])/g,
    (whole) => integerToEnglishWords(Number(whole.replace(/,/g, ''))),
  )

  return text.replace(
    /(?<![\w.,])(\d+)(?![\w.,])/g,
    (_match, digits: string) => {
      const value = Number(digits)
      if (digits.length === 4) return yearWords(value)
      return integerToEnglishWords(value)
    },
  )
}

function cleanText(input: string): string {
  return input
    .replace(/[\u00a0\u2007\u202f\u3000]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/…+/g, '. ')
    .replace(/\n+/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim()
}

export function normalizeEnglishSpeech(input: string): string {
  let text = cleanText(input)
  if (!text) return ''

  text = expandAbbreviations(text)
  text = expandSymbols(text)
  text = expandTimes(text)
  text = expandDates(text)
  text = expandRanges(text)
  text = convertNumbers(text)

  // A residual hyphen (well-known, half-brother) is voiced as two words; the
  // lexicon lookup and OOV spelling both handle the parts better that way.
  return text
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim()
}
