export interface GroupableSentence {
  text: string
  speechText: string
  paragraphEnd: boolean
  /** Dialogue and narration keep separate utterances for clearer prosody. */
  dialogue?: boolean
}

export interface SpeechUnit {
  /** First sentence index, also the unit's stable position in the book. */
  start: number
  /** Last sentence index, inclusive. */
  end: number
  text: string
  speechText: string
  paragraphEnd: boolean
}

export interface SpeechGroupOptions {
  enabled?: boolean
  maxSentences?: number
  maxChars?: number
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

/**
 * Turns sentences into playback units. A unit may hold 2–3 neighbouring
 * sentences from the same paragraph, which lets the acoustic model carry
 * prosody across sentence marks instead of restarting on every full stop.
 */
export function buildSpeechUnits(
  sentences: readonly GroupableSentence[],
  options: SpeechGroupOptions = {},
): SpeechUnit[] {
  const enabled = options.enabled ?? true
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
    })
    index = end + 1
  }

  return units
}
