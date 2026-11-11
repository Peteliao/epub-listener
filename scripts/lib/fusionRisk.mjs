// Dev-only: static detection of "syllable fusion" (C-class) risks for 山岚.
//
// The Matcha front end hands the acoustic model one flat phone sequence: word
// boundaries never reach it. When the onset of syllable A and the rhyme of the
// following syllable B form another syllable the model was trained on, the two
// characters can be co-articulated into that single syllable. The first observed
// case was 「来到了」: lai2 + dao4 -> l + ao = lao ("老"), made worse by the base
// lexicon entry 「到了 dao4 le」 which leaves 「来」 as a lone character.
//
// This module is pure (no WASM, no file IO) so the whole discovery stage can be
// unit-tested and run in CI. Measurement/application live in
// scripts/auto-pronunciation-loop.mjs.
import { BOUNDARY_PHONE, maxWordLength, phoneticPhones, tokenizeSpans } from './reading.mjs'

// Longest-first: zh/ch/sh must be tried before z/c/s.
const INITIALS = [
  'zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
  'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w',
]
// Onsets that weaken easily in connected speech. Nasals/liquids/glides are not
// in this set: they normally survive and the pair does not collapse into one
// syllable (ta1 + shi4 would otherwise be a false positive for every sentence).
const WEAK_ONSETS = new Set([
  'b', 'p', 'd', 't', 'g', 'k', 'z', 'c', 's', 'zh', 'ch', 'sh', 'j', 'q', 'h',
])
const OPEN_RHYME = /^[aoe]/
const WEAK_CODA = /[ioung]$/
const HAN = /^\p{Script=Han}+$/u
const PUNCT = {
  '，': ',', ',': ',', '。': '.', '.': '.', '！': '!', '!': '!',
  '？': '?', '?': '?', '；': ';', ';': ';', '、': ',', '：': ':', ':': ':',
}
export const NON_PHONE = new Set(['"', ',', '.', '!', '?', ';', ':', '_'])

/** Split `lai2` into { initial: 'l', final: 'ai', tone: '2', base: 'lai' }. */
export function splitSyllable(phone) {
  const raw = String(phone ?? '').toLowerCase().replace(/ü/g, 'v')
  const match = /^([a-z]+)([0-5])?$/.exec(raw)
  if (!match) return null
  const base = match[1]
  const tone = match[2] ?? ''
  for (const initial of INITIALS) {
    if (base.startsWith(initial) && base.length > initial.length) {
      return { initial, final: base.slice(initial.length), tone, base }
    }
  }
  return { initial: '', final: base, tone, base }
}

/**
 * The syllable a listener may hear when A and B merge: onset(A) + rhyme(B).
 * Returns null when the pair cannot plausibly collapse into one syllable.
 */
export function blendSyllable(aPhone, bPhone) {
  const a = splitSyllable(aPhone)
  const b = splitSyllable(bPhone)
  if (!a || !b || !a.initial || !b.initial) return null
  if (!WEAK_ONSETS.has(b.initial) || !OPEN_RHYME.test(b.final)) return null
  if (!WEAK_CODA.test(a.final)) return null
  const blend = `${a.initial}${b.final}`
  if (blend === a.base || blend === b.base) return null
  return blend
}

/** True when the blended syllable exists in the model's token inventory. */
export function isFusionRisk(aPhone, bPhone, tokens) {
  const blend = blendSyllable(aPhone, bPhone)
  if (!blend) return false
  for (const tone of ['', '1', '2', '3', '4', '5']) {
    if (tokens.has(`${blend}${tone}`)) return true
  }
  return false
}

function clip(sentence, start, end, radius = 14) {
  const chars = Array.from(sentence)
  const from = Math.max(0, start - radius)
  const to = Math.min(chars.length, end + radius)
  return `${from > 0 ? '…' : ''}${chars.slice(from, to).join('')}${to < chars.length ? '…' : ''}`
}

/**
 * Scan a corpus for "lone character + multi-character lexicon word" pairs whose
 * phones can fuse. The lone-character condition is what makes 「来到了」 special:
 * 「到了」 is a dictionary word, so longest-match strips 「来」 away and the model
 * sees the two syllables as one continuous gesture.
 */
export function scanFusionRisks(text, assets, { limitSentences = 0, maxEvidence = 3, minCount = 1 } = {}) {
  const effective = assets.effective
  const maxLength = assets.maxLength ?? maxWordLength(effective)
  const sentences = String(text)
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;…\n])/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const scanned = limitSentences > 0 ? sentences.slice(0, limitSentences) : sentences
  const buckets = new Map()

  for (const sentence of scanned) {
    const spans = tokenizeSpans(sentence, effective, maxLength)
    for (let index = 0; index < spans.length - 1; index += 1) {
      const a = spans[index]
      const b = spans[index + 1]
      const aChars = Array.from(a.word)
      const bChars = Array.from(b.word)
      if (aChars.length !== 1 || bChars.length < 2 || bChars.length > 3) continue
      if (!HAN.test(a.word) || !HAN.test(b.word)) continue
      const aReading = phoneticPhones(effective.get(a.word) ?? '')
      const bReading = phoneticPhones(effective.get(b.word) ?? '')
      if (aReading.length !== 1 || bReading.length !== bChars.length) continue
      const aPhone = aReading[0]
      const bPhone = bReading[0]
      if (!isFusionRisk(aPhone, bPhone, assets.tokens)) continue

      const word = `${a.word}${b.word}`
      const phones = [...aReading, ...bReading]
      const neutralTail = !/[0-5]$/.test(bReading[bReading.length - 1])
        && assets.neutrals.has(bReading[bReading.length - 1])
      // Real WASM measurements showed the fusion happens when the following
      // rhyme is `ao` and a neutral particle (了) stretches the syllable:
      // lai2 + dao4 -> lao. Other blended syllables are kept as low-confidence
      // leads so the inventory stays exhaustive without driving auto-edits.
      const confidence = splitSyllable(bPhone)?.final === 'ao' && neutralTail
        ? 'high'
        : 'low'
      let bucket = buckets.get(word)
      if (!bucket) {
        bucket = {
          word,
          phones,
          blend: blendSyllable(aPhone, bPhone),
          fromPhone: aPhone,
          toPhone: bPhone,
          neutralTail,
          confidence,
          count: 0,
          evidence: [],
        }
        buckets.set(word, bucket)
      }
      bucket.count += 1
      if (bucket.evidence.length < maxEvidence) {
        bucket.evidence.push(clip(sentence, a.start, b.end))
      }
    }
  }

  return [...buckets.values()]
    .filter((item) => item.count >= minCount)
    .sort((left, right) =>
      (left.confidence === 'high' ? 0 : 1) - (right.confidence === 'high' ? 0 : 1)
      || Number(right.neutralTail) - Number(left.neutralTail)
      || right.count - left.count
      || left.word.localeCompare(right.word, 'zh'))
}

/** The whole-word overlay line that pins the pair and gives it a completion boundary. */
export function fixLine(candidate) {
  return `${candidate.word} ${candidate.phones.join(' ')} ${BOUNDARY_PHONE}`
}

/** A short real-text window keeps WASM measurement local and fast. */
export function contextWindow(sentence, word, radius = 10) {
  const index = sentence.indexOf(word)
  if (index < 0) return sentence
  const from = Math.max(0, index - radius)
  const to = Math.min(sentence.length, index + word.length + radius)
  const body = sentence.slice(from, to)
    .replace(/^[^\p{Script=Han}]+/u, '')
    .replace(/[^\p{Script=Han}]+$/u, '')
  return `${body}。`
}

/** Mirrors the Matcha front end: lexicon lookup -> one flat token sequence. */
export function sentenceTokens(sentence, effective, maxLength) {
  const spans = tokenizeSpans(sentence, effective, maxLength)
  const tokens = []
  const ranges = []
  for (const span of spans) {
    const start = tokens.length
    const reading = effective.get(span.word)
    if (reading) {
      for (const phone of reading.split(/\s+/)) if (phone) tokens.push(phone)
    } else if (PUNCT[span.word]) {
      tokens.push(PUNCT[span.word])
    }
    if (tokens.length > start) {
      ranges.push({
        word: span.word,
        start,
        end: tokens.length,
        startChar: span.start,
        endChar: span.end,
      })
    }
  }
  return { tokens, ranges }
}

/** Token indices of the first `count` real phones at/after `start`. */
export function phoneIndices(tokens, start, count) {
  const indices = []
  let index = start
  while (index < tokens.length && indices.length < count) {
    if (!NON_PHONE.has(tokens[index])) indices.push(index)
    index += 1
  }
  return indices
}

/**
 * Locate a candidate word inside a real context window, even when the word is
 * not yet a lexicon entry (it is currently split across two spans).
 */
export function candidateSpan(window, word, effective, maxLength) {
  const chars = Array.from(window)
  const wordChars = Array.from(word)
  const startChar = chars.findIndex((_, index) =>
    wordChars.every((char, offset) => chars[index + offset] === char))
  if (startChar < 0) return null
  const { tokens, ranges } = sentenceTokens(window, effective, maxLength)
  const covering = ranges.filter((range) =>
    range.endChar > startChar && range.startChar < startChar + wordChars.length)
  if (!covering.length) return null
  return { tokens, start: covering[0].start, endChar: covering[covering.length - 1].endChar }
}
