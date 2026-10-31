import type { SpeechUnit } from '@/core/text/speechGroups'
import { splitLanguageSegments } from '@/core/text/LanguageSegments'

export interface ListenEstimateOptions {
  rate: number
  englishRate: number
  /** Measured audio milliseconds per Chinese character at 1× playback. */
  zhMsPerChar?: number | null
  /** Measured audio milliseconds per English character at 1× playback. */
  enMsPerChar?: number | null
  grouped?: boolean
  pauseScale?: number
  unitGapMs?: number
  paragraphGapMs?: number
}

const DEFAULT_ZH_MS_PER_CHAR = 240
const DEFAULT_EN_MS_PER_CHAR = 75
const GROUP_GAP_MS = 110
const SENTENCE_GAP_MS = 210
const PARAGRAPH_GAP_MS = 280
const SPEAKABLE = /[\p{L}\p{N}]/gu

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function countSpeakable(text: string): number {
  return text.match(SPEAKABLE)?.length ?? 0
}

/**
 * Estimates how much audio is left in the current chapter. Chinese runs use a
 * rate calibrated from real synthesis audio lengths, so changing the voice or
 * speed shifts the estimate with the actual playback.
 */
export function estimateRemainingMs(
  units: readonly SpeechUnit[],
  fromIndex: number,
  options: ListenEstimateOptions,
): number {
  if (!units.length) return 0

  const from = clamp(Math.trunc(fromIndex), 0, units.length - 1)
  const rate = clamp(Number.isFinite(options.rate) ? options.rate : 1, 0.5, 2)
  const englishRate = clamp(
    Number.isFinite(options.englishRate) ? options.englishRate : 1,
    0.6,
    1.4,
  )
  const zhMsPerChar =
    options.zhMsPerChar && Number.isFinite(options.zhMsPerChar)
      ? clamp(options.zhMsPerChar, 80, 800)
      : DEFAULT_ZH_MS_PER_CHAR
  const enMsPerChar =
    options.enMsPerChar && Number.isFinite(options.enMsPerChar)
      ? clamp(options.enMsPerChar, 30, 300)
      : DEFAULT_EN_MS_PER_CHAR
  const pauseScale = clamp(options.pauseScale ?? 1, 0.5, 1.5)
  const rateGap = Math.sqrt(rate)
  const unitGap =
    (options.unitGapMs ?? (options.grouped ? GROUP_GAP_MS : SENTENCE_GAP_MS)) *
    pauseScale /
    rateGap
  const paragraphGap =
    (options.paragraphGapMs ?? PARAGRAPH_GAP_MS) * pauseScale / rateGap

  let total = 0
  for (let i = from; i < units.length; i += 1) {
    const unit = units[i]!
    const segments = splitLanguageSegments(unit.speechText)
    for (const segment of segments) {
      const chars = countSpeakable(segment.text)
      total +=
        chars *
        (segment.lang === 'zh'
          ? zhMsPerChar / rate
          : enMsPerChar / (rate * englishRate))
    }
    total += unitGap
    if (unit.paragraphEnd) total += paragraphGap
  }

  return Math.round(total)
}
