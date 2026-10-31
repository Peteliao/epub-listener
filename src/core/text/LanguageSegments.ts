export type SegmentLang = 'zh' | 'en'

export interface LanguageSegment {
  text: string
  lang: SegmentLang
}

const HAN = /\p{Script=Han}/u
const LATIN = /\p{Script=Latin}/u
const NUMBER = /\p{Nd}/u
const SPEAKABLE = /[\p{L}\p{N}]/u

// CJK punctuation is placed in the Chinese bucket so a full-width comma
// between two English words stays with the English run instead of opening an
// empty Chinese segment.
const CJK_PUNCTUATION =
  /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u00b7]/u

function classify(char: string): SegmentLang | null {
  if (CJK_PUNCTUATION.test(char)) return 'zh'
  if (HAN.test(char)) return 'zh'
  if (LATIN.test(char)) return 'en'
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
 * be sent to an engine that actually supports it. Whitespace and digits stay
 * with the neighbouring run; punctuation-only runs are absorbed by the run
 * before them.
 */
export function splitLanguageSegments(input: string): LanguageSegment[] {
  const segments: LanguageSegment[] = []
  let current: LanguageSegment | null = null
  let pending = ''

  for (const char of input) {
    const lang = classify(char)
    if (lang === null) {
      pending += char
      continue
    }

    if (current && current.lang === lang) {
      current.text += pending + char
    } else if (current) {
      current.text += pending
      pushSegment(segments, current.lang, current.text)
      current = { lang, text: char }
    } else {
      current = { lang, text: pending + char }
    }
    pending = ''
  }

  if (current) {
    current.text += pending
    pushSegment(segments, current.lang, current.text)
  }

  return segments
}
