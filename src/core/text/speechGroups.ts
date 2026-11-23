export interface GroupableSentence {
  text: string
  speechText: string
  paragraphEnd: boolean
  /** Dialogue and narration keep separate utterances for clearer prosody. */
  dialogue?: boolean
}

export type SentenceTerminal =
  | 'question'
  | 'exclamation'
  | 'ellipsis'
  | 'statement'
  | null

export interface SpeechUnit {
  /** First sentence index, also the unit's stable position in the book. */
  start: number
  /** Last sentence index, inclusive. */
  end: number
  text: string
  speechText: string
  paragraphEnd: boolean
  /** Last sentence is dialogue/narration; useful for diagnostics and future pacing. */
  dialogue?: boolean
  /** Terminal mode of the last sentence. */
  terminal?: SentenceTerminal
}

export interface SpeechGroupOptions {
  enabled?: boolean
  maxSentences?: number
  maxChars?: number
  /** End a group after ？/！/…… so the model gets a real utterance-final contour. */
  breakOnTerminal?: boolean
}

// A/B measured on the real WASM runtime (tests/fixtures/ab-baseline.json):
// a 105-char group took 6.8s to synthesize vs 5.1s at 83 chars, with the same
// RTF and slightly higher peaks. 90 keeps 2–3 sentences of shared prosody
// while cutting the worst first-audio wait by about a quarter on desktop (and
// proportionally more on slower phones).
const DEFAULTS = {
  maxSentences: 3,
  maxChars: 90,
}

function countChars(text: string): number {
  return text.replace(/\s+/g, '').length
}

/**
 * Adapts the group size to the measured real-time factor of the previous
 * chapter. Desktop sits near 0.31; once synthesis approaches playback speed a
 * shorter group keeps the first-audio wait and underrun risk bounded. The cap
 * never grows past the measured 90-character default (120 was measurably
 * slower and closer to the limiter).
 *
 * A/B evidence: tests/fixtures/ab-statistics.json (groupChars, p=0.0044).
 */
export function groupCharsForRtf(rtf: number | null | undefined): number {
  if (typeof rtf === 'number' && Number.isFinite(rtf) && rtf >= 0.9) {
    return 60
  }
  return DEFAULTS.maxChars
}

const ASCII_END = /[A-Za-z0-9]$/
const ASCII_START = /^[A-Za-z0-9]/
const ASCII_TERMINAL_END = /[.!?…]["')\]]*$/

/**
 * Joins sentences without inserting a pause: Chinese punctuation already ends
 * the run, while two English sentences still need a space between them.
 */
export function joinSentenceText(parts: readonly string[]): string {
  let result = ''
  for (const raw of parts) {
    const part = raw.trim()
    if (!part) continue
    if (!result) {
      result = part
      continue
    }
    const needsSpace =
      (ASCII_END.test(result) && ASCII_START.test(part)) ||
      (ASCII_TERMINAL_END.test(result) && ASCII_START.test(part))
    result += needsSpace ? ` ${part}` : part
  }
  return result
}

const CLOSERS = /[”’」』）】》〉"']+$/u

/** Classify the last meaningful punctuation of a sentence for grouping. */
export function sentenceTerminal(text: string): SentenceTerminal {
  const trimmed = text.trimEnd().replace(CLOSERS, '').trimEnd()
  if (!trimmed) return null
  const last = trimmed[trimmed.length - 1]!
  if (last === '？' || last === '?') return 'question'
  if (last === '！' || last === '!') return 'exclamation'
  if (last === '…' || trimmed.endsWith('...')) return 'ellipsis'
  if (last === '。' || last === '.') return 'statement'
  return null
}

/**
 * Turns sentences into playback units. A unit may hold 2–3 neighbouring
 * sentences from the same paragraph, which lets the acoustic model carry
 * prosody across sentence marks instead of restarting on every full stop.
 *
 * A question/exclamation/ellipsis ends the unit. If it were followed by more
 * text in the same synthesis request, the model would see the punctuation in
 * the middle and flatten the final contour; ending the request there is the
 * only per-sentence intonation control Matcha exposes without model changes.
 */
export function buildSpeechUnits(
  sentences: readonly GroupableSentence[],
  options: SpeechGroupOptions = {},
): SpeechUnit[] {
  const enabled = options.enabled ?? true
  const breakOnTerminal = options.breakOnTerminal ?? true
  const maxSentences = Math.max(2, options.maxSentences ?? DEFAULTS.maxSentences)
  const maxChars = Math.max(1, options.maxChars ?? DEFAULTS.maxChars)
  const units: SpeechUnit[] = []
  let index = 0

  while (index < sentences.length) {
    const start = index
    let end = index
    let chars = countChars(sentences[index]!.speechText)

    if (enabled) {
      while (
        end + 1 < sentences.length &&
        end - start + 1 < maxSentences &&
        !sentences[end]!.paragraphEnd &&
        Boolean(sentences[end]!.dialogue) === Boolean(sentences[end + 1]!.dialogue) &&
        (!breakOnTerminal
          || sentenceTerminal(sentences[end]!.speechText) === null
          || sentenceTerminal(sentences[end]!.speechText) === 'statement') &&
        chars + countChars(sentences[end + 1]!.speechText) <= maxChars
      ) {
        end += 1
        chars += countChars(sentences[end]!.speechText)
      }
    }

    const group = sentences.slice(start, end + 1)
    units.push({
      start,
      end,
      text: joinSentenceText(group.map((sentence) => sentence.text)),
      speechText: joinSentenceText(
        group.map((sentence) => sentence.speechText),
      ),
      paragraphEnd: sentences[end]!.paragraphEnd,
      dialogue: Boolean(sentences[start]!.dialogue),
      terminal: sentenceTerminal(sentences[end]!.speechText),
    })
    index = end + 1
  }

  return units
}
