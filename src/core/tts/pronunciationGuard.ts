import protectedWordsRaw from './protectedWords.v1.txt?raw'
import utteranceResetsRaw from './utteranceResets.v1.txt?raw'

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

export const UTTERANCE_RESET_WORDS: readonly string[] = Object.freeze(
  utteranceResetsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .sort((left, right) => Array.from(right).length - Array.from(left).length),
)

const HAN = /\p{Script=Han}/u

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

  for (const word of sorted) {
    if (!word) continue
    let from = 0
    for (;;) {
      const index = source.indexOf(word, from)
      if (index < 0) break
      from = index + word.length
      if (index === 0 || !HAN.test(source[index - 1])) continue
      if (source[index - 1] === WORD_BOUNDARY) continue
      if (covered.some(([start, end]) => index >= start && index < end)) continue
      insertions.push(index)
      covered.push([index, index + word.length])
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
  const insertions: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== WORD_BOUNDARY) continue
    const longest = sortedProtected.find((word) => source.startsWith(word, index + 1))
    if (longest && !words.includes(longest)) continue
    if (!words.some((word) => source.startsWith(word, index + 1))) continue
    if (index === 0 || source[index - 1] === UTTERANCE_RESET) continue
    insertions.push(index)
  }
  let result = source
  for (const index of insertions.reverse()) {
    result = `${result.slice(0, index)}${UTTERANCE_RESET}${result.slice(index)}`
  }
  return result
}

/**
 * The text actually sent to the offline worker for Chinese Matcha packs.
 *
 * `protectedWords` may be extended with per-book words derived from the
 * runtime lexicon overlay (see SherpaDriver); that only adds U+200B word
 * boundaries. Utterance resets (U+2060) deliberately keep using the static,
 * listening-confirmed tables: feeding the dynamic list into the longest-match
 * check would change which phrases get split into two syntheses.
 *
 * With no arguments both parameters default to the static tables, so the
 * audit mirror and all existing tests see exactly the same text as before.
 */
export function preparePronunciationText(
  text: string,
  protectedWords?: readonly string[],
  resetWords?: readonly string[],
): string {
  return applyUtteranceResets(
    protectPronunciations(text, protectedWords),
    resetWords,
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
