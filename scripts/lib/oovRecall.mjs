import { splitCorpus, discoverOovAcousticLeads } from './iterationFamilies.mjs'

const LENGTHS = [2, 3, 4, 5, 6]
const HAN_WORD = new RegExp(`^\\p{Script=Han}{2,6}$`, 'u')

/**
 * Samples OOV words of 2–6 characters that discoverOovAcousticLeads did NOT
 * flag. The acoustic detector only handles two-character words, so longer
 * entries are always a manual-recall queue: their segmentation and semantics
 * are too fragile for automatic repair. This never edits a lexicon.
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
  const byLength = Object.fromEntries(LENGTHS.map((length) => [
    length, { dictionary: new Set(), found: new Set(), missed: new Set() },
  ]))
  const missed = new Map()
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

  for (const sentence of splitCorpus(text)) {
    const words = [...segmenter.segment(sentence)].map((item) => item.segment)
    if (words.join('') !== sentence) continue
    for (const word of words) {
      const length = Array.from(word).length
      if (!HAN_WORD.test(word) || !byLength[length]) continue
      if (effective.has(word)) {
        byLength[length].dictionary.add(word)
        continue
      }
      if (found.has(word)) {
        byLength[length].found.add(word)
        continue
      }
      byLength[length].missed.add(word)
      let bucket = missed.get(word)
      if (!bucket) {
        bucket = { word, length, count: 0, evidence: [] }
        missed.set(word, bucket)
      }
      bucket.count += 1
      if (bucket.evidence.length < 2) {
        const evidence = sentence.trim().slice(0, 60)
        if (!bucket.evidence.includes(evidence)) bucket.evidence.push(evidence)
      }
    }
  }

  // Stratified sample: every word length gets a slot before 2-char pairs (the
  // noisiest bucket) can consume the whole quota.
  const quota = Math.max(1, Math.ceil(sampleSize / LENGTHS.length))
  const sample = []
  const claimed = new Set()
  for (const length of LENGTHS) {
    const candidates = [...missed.values()]
      .filter((item) => item.length === length && !claimed.has(item.word))
      .sort((left, right) =>
        right.count - left.count || left.word.localeCompare(right.word, 'zh'))
    for (const item of candidates.slice(0, quota)) {
      sample.push(item)
      claimed.add(item.word)
    }
  }
  if (sample.length < sampleSize) {
    const rest = [...missed.values()]
      .filter((item) => !claimed.has(item.word))
      .sort((left, right) =>
        right.count - left.count || left.word.localeCompare(right.word, 'zh'))
    for (const item of rest) {
      if (sample.length >= sampleSize) break
      sample.push(item)
      claimed.add(item.word)
    }
  }

  return {
    dictionary: LENGTHS.reduce((sum, length) => sum + byLength[length].dictionary.size, 0),
    found: found.size,
    missed: missed.size,
    sample,
    byLength: Object.fromEntries(LENGTHS.map((length) => [length, {
      dictionary: byLength[length].dictionary.size,
      found: byLength[length].found.size,
      missed: byLength[length].missed.size,
    }])),
  }
}
