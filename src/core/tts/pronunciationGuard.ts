import protectedWordsRaw from './protectedWords.v1.txt?raw'
import utteranceResetsRaw from './utteranceResets.v1.txt?raw'
import seamlessUtteranceResetsRaw from './seamlessUtteranceResets.v1.txt?raw'

/**
 * Zero-width boundary. sherpa-onnx's Matcha front end skips unknown characters
 * ("OOV word skipped") instead of emitting a token, so this adds a hard word
 * boundary with no acoustic footprint: the same text produces the same audio,
 * but the longest-match lookup has to restart at the protected word.
 */
export const WORD_BOUNDARY = '\u200b'

/**
 * Utterance-reset sentinel. A word boundary cannot undo long-sentence prosody
 * squashing a phrase-initial syllable (地盘's 地 is heard as `de`). The worker
 * splits the text here, synthesises each part independently and joins the PCM,
 * so the protected word starts a fresh utterance. Matcha skips this OOV char on
 * other engines; the worker strips it there too.
 */
export const UTTERANCE_RESET = '\u2060'

/** Word-internal synthesis seam joined with a short crossfade, not a pause. */
export const SEAMLESS_UTTERANCE_RESET = '\u2061'

export interface SeamlessUtteranceResetRule {
  readonly word: string
  readonly after: number
}

export const UTTERANCE_RESET_WORDS: readonly string[] = Object.freeze(
  utteranceResetsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .sort((left, right) => Array.from(right).length - Array.from(left).length),
)

export const SEAMLESS_UTTERANCE_RESET_RULES: readonly SeamlessUtteranceResetRule[] = Object.freeze(
  seamlessUtteranceResetsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [word, after] = line.split(/\s+/)
      return Object.freeze({ word: word!, after: Number(after) })
    })
    .sort((left, right) => Array.from(right.word).length - Array.from(left.word).length),
)

const HAN = /\p{Script=Han}/u
const PUNCTUATION = /[\p{P}\p{S}]/u

/** UTF-16 offsets of every Unicode code point, for astral-safe scanning. */
function codePointOffsets(text: string): number[] {
  const offsets: number[] = []
  let offset = 0
  for (const char of text) {
    offsets.push(offset)
    offset += char.length
  }
  return offsets
}

function previousCodePoint(text: string, offsets: number[], index: number): string {
  const position = offsets.indexOf(index)
  return position > 0 ? text.slice(offsets[position - 1]!, index) : ''
}

export const PROTECTED_WORDS: readonly string[] = Object.freeze(
  protectedWordsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .sort(
      (left, right) =>
        Array.from(right).length - Array.from(left).length ||
        left.localeCompare(right, 'zh'),
    ),
)

/**
 * Inserts a zero-width boundary before every protected word that is preceded by
 * a Han character. Longer words win first, so a shorter word nested inside an
 * already protected longer word (会计 inside 会计师) is left alone.
 *
 * Idempotent, and safe to call with the original text: cache keys and character
 * counts in the driver keep using the unmodified text.
 */
export function protectPronunciations(
  text: string,
  words: readonly string[] = PROTECTED_WORDS,
): string {
  const source = String(text)
  if (!source) return source
  const sorted = [...words].sort(
    (left, right) =>
      Array.from(right).length - Array.from(left).length ||
      left.localeCompare(right, 'zh'),
  )
  const insertions: number[] = []
  const covered: Array<[number, number]> = []
  const offsets = codePointOffsets(source)

  for (const word of sorted) {
    if (!word) continue
    // Advance by one CODE POINT, not by word.length: overlapping occurrences
    // and astral-plane characters must not be skipped by a UTF-16 shortcut.
    for (const index of offsets) {
      if (!source.startsWith(word, index)) continue
      if (covered.some(([start, end]) => index >= start && index < end)) continue
      // Mark every match, even at the sentence edge, so a shorter word nested
      // inside a longer one (会计 inside 学会计) cannot split the longer word.
      const before = previousCodePoint(source, offsets, index)
      // 万一倒闭 must keep the existing 倒闭 word instead of 一倒 + 闭.
      if (word === '一倒' && before === '万' && source.startsWith('闭', index + word.length)) continue
      covered.push([index, index + word.length])
      if (!before || !HAN.test(before) || before === WORD_BOUNDARY) continue
      insertions.push(index)
    }
  }

  if (insertions.length === 0) return source
  insertions.sort((left, right) => right - left)
  let result = source
  for (const index of insertions) {
    result = `${result.slice(0, index)}${WORD_BOUNDARY}${result.slice(index)}`
  }
  return result
}

/**
 * Marks the words registered in `utteranceResets.v1.txt` for a real utterance
 * reset. Expects `protectPronunciations()` output: the sentinel goes *before*
 * the existing U+200B, so the second part still starts with the protected word.
 *
 * A longer protected word wins: splitting 「地盘之争」 at 「地盘」 would cut a
 * compound in half, so it is left to the plain word-boundary repair.
 * Idempotent, and safe on text that carries no boundaries at all.
 */
export function applyUtteranceResets(
  text: string,
  words: readonly string[] = UTTERANCE_RESET_WORDS,
  protectedWords: readonly string[] = PROTECTED_WORDS,
): string {
  const source = String(text)
  if (!source) return source
  const sortedProtected = [...protectedWords].sort(
    (left, right) =>
      Array.from(right).length - Array.from(left).length ||
      left.localeCompare(right, 'zh'),
  )
  const insertions = new Set<number>()
  const offsets = codePointOffsets(source)
  for (const index of offsets) {
    const boundary = source[index] === WORD_BOUNDARY
    const start = boundary ? index + 1 : index
    const before = previousCodePoint(source, offsets, boundary ? index : start)
    if (!boundary && !PUNCTUATION.test(before)) continue
    const longest = sortedProtected.find((word) => source.startsWith(word, start))
    if (longest && !words.includes(longest)) continue
    const resetWord = words.find((word) => source.startsWith(word, start))
    if (!resetWord) continue
    if (!boundary && sortedProtected.includes(resetWord)) continue
    if (!before || before === UTTERANCE_RESET || before === SEAMLESS_UTTERANCE_RESET) continue
    insertions.add(boundary ? index : start)
  }
  let result = source
  for (const index of [...insertions].sort((left, right) => right - left)) {
    result = `${result.slice(0, index)}${UTTERANCE_RESET}${result.slice(index)}`
  }
  return result
}

/** Splits registered fused words for independent synthesis without a pause. */
export function applySeamlessUtteranceResets(
  text: string,
  rules: readonly SeamlessUtteranceResetRule[] = SEAMLESS_UTTERANCE_RESET_RULES,
): string {
  const source = String(text)
  if (!source) return source
  const insertions: number[] = []
  const covered: Array<[number, number]> = []
  const offsets = codePointOffsets(source)
  const sorted = [...rules].sort(
    (left, right) => Array.from(right.word).length - Array.from(left.word).length,
  )
  for (const rule of sorted) {
    if (!rule.word || rule.after <= 0 || rule.after >= Array.from(rule.word).length) continue
    for (const index of offsets) {
      if (source[index] === WORD_BOUNDARY || source[index] === UTTERANCE_RESET || source[index] === SEAMLESS_UTTERANCE_RESET) continue
      if (!source.startsWith(rule.word, index)) continue
      if (covered.some(([start, end]) => index >= start && index < end)) continue
      covered.push([index, index + rule.word.length])
      const split = index + Array.from(rule.word).slice(0, rule.after).join('').length
      if (source[split] !== SEAMLESS_UTTERANCE_RESET) insertions.push(split)
    }
  }
  let result = source
  for (const index of insertions.sort((left, right) => right - left)) {
    result = `${result.slice(0, index)}${SEAMLESS_UTTERANCE_RESET}${result.slice(index)}`
  }
  return result
}

/**
 * The text actually sent to the offline worker for Chinese Matcha packs.
 *
 * `protectedWords` may be extended with per-book words derived from the
 * runtime lexicon overlay (see SherpaDriver); that only adds U+200B word
 * boundaries. Utterance resets (U+2060/U+2061) deliberately keep using the
 * static tables: dynamic words must not change which phrases are re-synthesised.
 *
 * With no arguments both parameters default to the static tables, so the
 * audit mirror and all existing tests see exactly the same text as before.
 */
export function preparePronunciationText(
  text: string,
  protectedWords?: readonly string[],
  resetWords?: readonly string[],
  seamlessRules?: readonly SeamlessUtteranceResetRule[],
): string {
  const resetProtectedWords = protectedWords ?? PROTECTED_WORDS
  const punctuationResets = applyUtteranceResets(text, resetWords, resetProtectedWords)
  return applySeamlessUtteranceResets(
    applyUtteranceResets(
      protectPronunciations(punctuationResets, protectedWords),
      resetWords,
      resetProtectedWords,
    ),
    seamlessRules,
  )
}

/**
 * Extract the multi-character words from a merged lexicon overlay so the
 * per-book pronunciation fixes also get a hard longest-match boundary.
 * The static tables stay the default baseline; this only ADDS candidates.
 * Single-character rows, non-Han words and known dangerous bare words are
 * excluded (a bare 便宜 would split 占便宜).
 */
export function overlayProtectedWords(
  overlay: string | undefined,
  staticWords: readonly string[] = PROTECTED_WORDS,
): readonly string[] {
  if (!overlay) return staticWords
  const HAN = /\p{Script=Han}/u
  const excluded = new Set(['便宜'])
  const words = new Set(staticWords)
  for (const line of overlay.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('||')) continue
    const word = trimmed.split(/\s+/)[0]
    const chars = Array.from(word)
    if (chars.length < 2 || chars.length > 6) continue
    if (!chars.every((char) => HAN.test(char))) continue
    if (excluded.has(word)) continue
    words.add(word)
  }
  return [...words].sort(
    (left, right) =>
      Array.from(right).length - Array.from(left).length ||
      left.localeCompare(right, 'zh'),
  )
}
