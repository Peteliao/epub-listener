const CLOSERS = new Set([
  '”',
  '’',
  '」',
  '』',
  '）',
  '】',
  '》',
  '〉',
  '〕',
  '］',
  '｝',
  '"',
  "'",
  ')',
  ']',
  '}',
])

const TERMINAL = /[。！？!?.…]/
const CLAUSE = /[，,、；;：:—–―]/

const TERMINAL_GAP_MS = 210
const CLAUSE_GAP_MS = 120
const DEFAULT_GAP_MS = 170
const PARAGRAPH_GAP_MS = 280

// A grouped utterance already paused at every internal punctuation mark, so
// the player only needs a short breath between groups and a paragraph break.
const GROUP_GAP_MS = 110
const GROUP_PARAGRAPH_GAP_MS = 320

/**
 * Returns the final character that carries prosody, skipping closing quotes and
 * brackets so `他说：“好。”` is recognised as a full stop, not a quote mark.
 */
export function lastSpeechChar(text: string): string {
  let index = text.length - 1
  while (index >= 0) {
    const char = text[index]!
    if (!/\s/.test(char) && !CLOSERS.has(char)) return char
    index -= 1
  }
  return ''
}

export interface SentenceGapOptions {
  paragraphEnd?: boolean
  /** Playback speed; the model's own pauses shrink with it, so ours must too. */
  rate?: number
  /** The text was spoken as one grouped utterance, not a single sentence. */
  grouped?: boolean
  /** User preference from the pause preset. */
  scale?: number
}

/**
 * Ensures an utterance ends with punctuation. Matcha-family voices shorten the
 * final syllable noticeably when a sentence has no closing mark, so headings
 * like "第八章 槐树巷" need a synthetic period (or comma mid-sentence). The
 * English voice only recognises ASCII marks, so it gets a period instead.
 */
export function ensureSpeechEnd(
  text: string,
  final: boolean,
  lang: 'zh' | 'en' = 'zh',
): string {
  const trimmed = text.trimEnd()
  const last = lastSpeechChar(trimmed)
  if (!last || TERMINAL.test(last) || CLAUSE.test(last)) return trimmed
  if (lang === 'en') return `${trimmed}${final ? '.' : ','}`
  return `${trimmed}${final ? '。' : '，'}`
}

/** Silence the player inserts after a sentence. */
export function sentenceGapMs(
  text: string,
  options: SentenceGapOptions = {},
): number {
  let gap: number
  if (options.grouped) {
    gap = options.paragraphEnd ? GROUP_PARAGRAPH_GAP_MS : GROUP_GAP_MS
  } else {
    const last = lastSpeechChar(text)
    gap = DEFAULT_GAP_MS
    if (TERMINAL.test(last)) gap = TERMINAL_GAP_MS
    else if (CLAUSE.test(last)) gap = CLAUSE_GAP_MS
    if (options.paragraphEnd) gap += PARAGRAPH_GAP_MS
  }

  const preference = Math.min(1.5, Math.max(0.5, options.scale ?? 1))
  gap *= preference

  // A fixed gap feels twice as long at 2x. Dividing by sqrt(rate) keeps it
  // proportionate without making fast playback sound clipped together.
  const rate = Math.min(2, Math.max(0.5, options.rate ?? 1))
  const rateScale = rate === 1 ? 1 : Math.sqrt(rate)
  return Math.round(gap / rateScale)
}
