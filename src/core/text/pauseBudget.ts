/**
 * Single source of truth for inter-utterance pauses.
 *
 * Previously the player, the remaining-time estimator and the model's own
 * silenceScale each carried a different set of numbers. Anything that needs a
 * pause duration must go through sentenceGapMs so the estimate matches what
 * the listener actually hears.
 */
const CLOSERS = new Set([
  '”', '’', '」', '』', '）', '】', '》', '〉', '〕',
  '］', '｝', '"', "'", ')', ']', '}',
])

export const TERMINAL = /[。！？!?.…]/
export const CLAUSE = /[，,、；;：:—–―]/

export const PAUSE_MS = {
  terminal: 210,
  clause: 120,
  default: 170,
  paragraph: 280,
  group: 110,
  groupParagraph: 320,
} as const

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

/** Silence the player inserts after a sentence. */
export function sentenceGapMs(
  text: string,
  options: SentenceGapOptions = {},
): number {
  let gap: number
  if (options.grouped) {
    gap = options.paragraphEnd ? PAUSE_MS.groupParagraph : PAUSE_MS.group
  } else {
    const last = lastSpeechChar(text)
    gap = PAUSE_MS.default
    if (TERMINAL.test(last)) gap = PAUSE_MS.terminal
    else if (CLAUSE.test(last)) gap = PAUSE_MS.clause
    if (options.paragraphEnd) gap += PAUSE_MS.paragraph
  }

  const preference = Math.min(1.5, Math.max(0.5, options.scale ?? 1))
  gap *= preference

  // A fixed gap feels twice as long at 2x. Dividing by sqrt(rate) keeps it
  // proportionate without making fast playback sound clipped together.
  const rate = Math.min(2, Math.max(0.5, options.rate ?? 1))
  const rateScale = rate === 1 ? 1 : Math.sqrt(rate)
  return Math.round(gap / rateScale)
}
