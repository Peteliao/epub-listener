export type SegmentLang = 'zh' | 'en'

export interface LanguageSegment {
  text: string
  lang: SegmentLang
}

const HAN = /\p{Script=Han}/u
const LATIN = /\p{Script=Latin}/u
// Full-width Latin letters are English too. Without this they fell through as
// unclassified characters and a sentence made only of them produced no
// segment at all (silent playback).
const FULLWIDTH_LATIN = /[\uff21-\uff3a\uff41-\uff5a]/u
const NUMBER = /[\p{Nd}\p{Nl}]/u
// Roman numerals share the Latin script but are numbers, not letters.
const ROMAN_NUMERAL = /[\u2160-\u217f]/u
const SPEAKABLE = /[\p{L}\p{N}]/u

// CJK punctuation is placed in the Chinese bucket so a full-width comma
// between two English words stays with the English run instead of opening an
// empty Chinese segment.
const CJK_PUNCTUATION =
  /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00b7]/u

function classify(char: string): SegmentLang | null {
  if (CJK_PUNCTUATION.test(char)) return 'zh'
  if (HAN.test(char)) return 'zh'
  if (ROMAN_NUMERAL.test(char)) return null
  if (LATIN.test(char) || FULLWIDTH_LATIN.test(char)) return 'en'
  // Digits, spaces and ASCII punctuation join the surrounding run; leading
  // neutral characters join whichever language starts next.
  if (NUMBER.test(char) || /[\s!-/:-@[-`{-~]/.test(char)) return null
  return null
}

function pushSegment(list: LanguageSegment[], lang: SegmentLang, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const previous = list[list.length - 1]
  if (!SPEAKABLE.test(trimmed)) {
    if (previous) previous.text += trimmed
    return
  }
  if (previous && previous.lang === lang) {
    previous.text += trimmed
    return
  }
  list.push({ lang, text: trimmed })
}

/**
 * Splits text into runs of Chinese and non-Chinese characters so each run can
 * be sent to an engine that actually supports it.
 *
 * A digit run followed by Latin text belongs to that English run ("用了5G" →
 * "用了" + "5G"), while digits surrounded by Chinese stay in the Chinese run.
 * Unclassified-but-speakable text is never dropped: a sentence of only
 * full-width letters or numerals still produces a segment.
 */
export function splitLanguageSegments(input: string): LanguageSegment[] {
  const segments: LanguageSegment[] = []
  const chars = Array.from(input)
  // Precompute the next classified language to the right in one backwards
  // pass, so deciding where a digit run belongs stays O(n).
  const nextLang: Array<SegmentLang | null> = new Array(chars.length + 1).fill(null)
  let next: SegmentLang | null = null
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const lang = classify(chars[i]!)
    if (lang) next = lang
    nextLang[i] = next
  }

  let current: LanguageSegment | null = null
  let pending = ''
  let heldForRight = ''

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!
    const lang = classify(char)
    if (lang === null) {
      if (current?.lang === 'zh' && nextLang[i + 1] === 'en') {
        heldForRight += char
      } else {
        pending += char
      }
      continue
    }

    if (current && current.lang === lang) {
      current.text += pending + char
    } else if (current) {
      current.text += pending
      pushSegment(segments, current.lang, current.text)
      current = { lang, text: heldForRight + char }
    } else {
      current = { lang, text: pending + heldForRight + char }
    }
    pending = ''
    heldForRight = ''
  }

  if (current) {
    current.text += pending + heldForRight
    pushSegment(segments, current.lang, current.text)
  } else if (SPEAKABLE.test(pending + heldForRight)) {
    // Never return an empty list for text that has something to pronounce.
    pushSegment(segments, 'zh', pending + heldForRight)
  }

  return segments
}
