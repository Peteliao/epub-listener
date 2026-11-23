import { splitCorpus, discoverOovAcousticLeads } from './iterationFamilies.mjs'

const HAN_WORD = /^\p{Script=Han}{2}$/u

/**
 * Samples OOV two-character words that discoverOovAcousticLeads did NOT flag.
 *
 * The detector deliberately skips a word whose first character is covered by a
 * longer dictionary span (e.g. 说白 + 白果 -> the OOV 白果 is invisible). Those
 * words are not necessarily broken, but they are exactly the blind spots that
 * a periodic human recall audit should listen to. This sampler is advisory:
 * it never edits the lexicon and never claims a word is an error.
 */
export function collectRecallSample(text, assets, options = {}) {
  const sampleSize = options.sample ?? 20
  const minCount = options.minCount ?? 1
  const effective = assets.effective
  const detector = discoverOovAcousticLeads(text, assets, {
    limit: 10000,
    minCount,
  })
  const found = new Map(detector.map((item) => [item.word, item]))
  const dictionary = new Set()
  const missed = new Map()
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

  for (const sentence of splitCorpus(text)) {
    const words = [...segmenter.segment(sentence)].map((item) => item.segment)
    if (words.join('') !== sentence) continue
    for (const word of words) {
      if (!HAN_WORD.test(word)) continue
      if (effective.has(word)) {
        dictionary.add(word)
        continue
      }
      if (found.has(word)) continue
      let bucket = missed.get(word)
      if (!bucket) {
        bucket = { word, count: 0, evidence: [] }
        missed.set(word, bucket)
      }
      bucket.count += 1
      if (bucket.evidence.length < 2) {
        const evidence = sentence.trim().slice(0, 60)
        if (!bucket.evidence.includes(evidence)) bucket.evidence.push(evidence)
      }
    }
  }

  const sample = [...missed.values()]
    .sort((left, right) =>
      right.count - left.count || left.word.localeCompare(right.word, 'zh'))
    .slice(0, sampleSize)
  return {
    dictionary: dictionary.size,
    found: found.size,
    missed: missed.size,
    sample,
  }
}
