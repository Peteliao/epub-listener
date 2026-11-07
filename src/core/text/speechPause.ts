export {
  CLAUSE,
  TERMINAL,
  PAUSE_MS,
  lastSpeechChar,
  sentenceGapMs,
  type SentenceGapOptions,
} from './pauseBudget'
import { CLAUSE, TERMINAL, lastSpeechChar } from './pauseBudget'

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
