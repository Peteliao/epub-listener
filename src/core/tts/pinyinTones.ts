// The bundled lexicons store tones as trailing digits (zhuo2), so overlays
// that use tone marks (zhuó) must be converted before matching.
const TONE_MARKS: Record<string, [base: string, tone: number]> = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['v', 1], ǘ: ['v', 2], ǚ: ['v', 3], ǜ: ['v', 4],
  ń: ['n', 2], ň: ['n', 3], ǹ: ['n', 4],
  ḿ: ['m', 2],
}

function normalizeSyllable(raw: string): string {
  const token = raw.normalize('NFC').toLowerCase()
  let tone: number | null = null
  let marks = 0
  let output = ''

  for (const char of token) {
    const mark = TONE_MARKS[char]
    if (mark) {
      output += mark[0]
      tone = mark[1]
      marks += 1
    } else if (char === 'ü') {
      output += 'v'
    } else {
      output += char
    }
  }

  // A token with several tone marks is not a single syllable; leave it alone
  // instead of silently turning it into an unreadable phone.
  if (marks > 1) return raw

  const numeric = /^([a-z]+)([0-5])$/.exec(output)
  if (numeric) {
    const digit = Number(numeric[2])
    if (tone === null && digit >= 1 && digit <= 4) tone = digit
    output = numeric[1]
  }
  if (tone === 5 || tone === 0) tone = null
  return tone === null ? output : `${output}${tone}`
}

export function normalizePinyinReading(reading: string): string {
  return reading
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeSyllable)
    .join(' ')
}

/**
 * Merges the hand-verified overlay with the auto-generated per-book overlay.
 *
 * The worker appends every overlay row verbatim and Matcha keeps the LAST line
 * for a word, while the audit helpers (scripts/lib/reading.mjs parseOverlay)
 * keep the FIRST. The old order `[curated, bookOverlay]` therefore let a
 * pinyin-pro row (e.g. 便宜 -> yi0, a phone tokens.txt never trained) silently
 * win in the app while every gate still saw the curated row. The listener heard
 * a garbled or silent syllable and all phone-only checks stayed green.
 *
 * Rule: a per-book row is dropped whenever the curated table already pins that
 * word, and the curated rows are appended last. Every word then has exactly one
 * row, so the runtime and audit models agree, and the hand-verified reading wins.
 */
export function mergeLexiconOverlays(curated: string, book?: string): string {
  const rows = (source: string) => String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const curatedRows = rows(curated)
  const curatedWords = new Set(curatedRows.map((line) => line.split(/\s+/)[0]))
  const bookRows = rows(book ?? '').filter(
    (line) => !curatedWords.has(line.split(/\s+/)[0]),
  )
  return [...bookRows, ...curatedRows].join('\n')
}

/**
 * Converts every word-plus-reading line of an overlay to the numeric-tone
 * format the sherpa lexicons use. Comments, blank lines and English-style
 * `word || phones` lines are passed through untouched.
 */
export function normalizeOverlayText(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.includes('||')) {
        return trimmed
      }
      const match = /^(\S+)\s+(.+)$/.exec(trimmed)
      if (!match) return trimmed
      return `${match[1]} ${normalizePinyinReading(match[2])}`
    })
    .join('\n')
}
