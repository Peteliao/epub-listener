// Dev-only: whole-corpus "what did this lexicon change actually affect?" diff.
// Compares per-character readings before/after an overlay edit, so a fix that
// silently changes the longest-match segmentation of unrelated words is caught
// before it can be merged. The app never imports this module.
import { tokenizeSpans, phoneticPhones, maxWordLength } from './reading.mjs'
import { splitSentences, makeContext } from './corpus.mjs'

const HAN = /\p{Script=Han}/u

/** Parses candidate overlay lines (word phones) into a Map, ignoring comments. */
export function parseOverlayLines(text) {
  const entries = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (word && phones.length) entries.set(word, phones.join(' '))
  }
  return entries
}

/** Builds the "after" dictionary from the current effective one plus candidates. */
export function applyOverlay(before, overlayText) {
  const after = new Map(before)
  const candidates = parseOverlayLines(overlayText)
  for (const [word, reading] of candidates) after.set(word, reading)
  return { after, changedWords: new Set(candidates.keys()) }
}

function charReadings(spans, entries, length) {
  const out = new Array(length).fill(null)
  for (const span of spans) {
    const reading = entries.get(span.word)
    if (!reading) continue
    const phones = phoneticPhones(reading)
    for (let index = span.start; index < span.end; index += 1) {
      out[index] = phones[index - span.start] ?? null
    }
  }
  return out
}

/**
 * @param {object} options
 * @param {string} options.text raw corpus text
 * @param {Map<string,string>} options.before effective dictionary before the edit
 * @param {Map<string,string>} options.after effective dictionary after the edit
 * @param {Set<string>} options.changedWords words the edit intends to change
 * @param {number} [options.limitSentences] stop after N sentences (0 = all)
 * @param {number} [options.maxSamples] keep at most N example contexts
 */
export function compareReadingChanges({
  text,
  before,
  after,
  changedWords,
  limitSentences = 0,
  maxSamples = 20,
}) {
  const maxLength = Math.max(maxWordLength(before), maxWordLength(after))
  const result = {
    sentences: 0,
    total: 0,
    intended: 0,
    unexpected: 0,
    byWord: new Map(),
    samples: [],
  }
  const sentences = splitSentences(text)

  for (const sentence of sentences) {
    if (limitSentences && result.sentences >= limitSentences) break
    result.sentences += 1
    const chars = Array.from(sentence)
    const spansBefore = tokenizeSpans(sentence, before, maxLength)
    const spansAfter = tokenizeSpans(sentence, after, maxLength)
    const readingsBefore = charReadings(spansBefore, before, chars.length)
    const readingsAfter = charReadings(spansAfter, after, chars.length)

    for (let index = 0; index < chars.length; index += 1) {
      if (readingsBefore[index] === readingsAfter[index]) continue
      if (!HAN.test(chars[index])) continue
      result.total += 1
      const afterSpan = spansAfter.find((span) => index >= span.start && index < span.end)
      const beforeSpan = spansBefore.find((span) => index >= span.start && index < span.end)
      const intentional = Boolean(
        afterSpan && changedWords.has(afterSpan.word),
      )
      if (intentional) result.intended += 1
      else result.unexpected += 1

      const label = `${afterSpan?.word ?? '?'} / ${beforeSpan?.word ?? '?'}`
      result.byWord.set(label, (result.byWord.get(label) ?? 0) + 1)
      if (result.samples.length < maxSamples) {
        result.samples.push({
          char: chars[index],
          before: readingsBefore[index],
          after: readingsAfter[index],
          afterWord: afterSpan?.word ?? null,
          beforeWord: beforeSpan?.word ?? null,
          intentional,
          context: makeContext(sentence, index, index + 1),
        })
      }
    }
  }
  return result
}

export function summarizeImpact(report) {
  return {
    sentences: report.sentences,
    total: report.total,
    intended: report.intended,
    unexpected: report.unexpected,
    byWord: [...report.byWord.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count })),
    samples: report.samples,
  }
}
