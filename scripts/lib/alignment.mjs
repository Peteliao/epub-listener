/**
 * Time alignment helpers for full-sentence acoustic audits.
 *
 * The old audit used the duration of a separately synthesised prefix as an
 * absolute timestamp. That is only a rough estimate: the prefix is read with a
 * different sentence-final rhythm in isolation. Here we prefer exact worker
 * reset boundaries and, when none exist, align the prefix envelope to the full
 * audio with a normalised cross-correlation. Low-confidence alignments are
 * reported as NEEDS_LISTENING instead of driving a repair decision.
 */

export const ALIGNMENT_DEFAULTS = Object.freeze({
  frameMs: 10,
  voicedRatio: 0.1,
  windowMs: 800,
  highCorrelation: 0.8,
  highMargin: 0.08,
  mediumCorrelation: 0.65,
  mediumMargin: 0.04,
})

export function frameEnvelope(samples, sampleRate, frameMs = 10) {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const count = Math.floor(samples.length / frame)
  const values = new Float32Array(count)
  let peak = 0
  for (let index = 0; index < count; index += 1) {
    let sum = 0
    const offset = index * frame
    for (let i = 0; i < frame; i += 1) {
      const value = samples[offset + i] ?? 0
      sum += value * value
    }
    const rms = Math.sqrt(sum / frame)
    values[index] = rms
    if (rms > peak) peak = rms
  }
  return { values, count, peak, frameMs, frame }
}

/**
 * Find where `prefixSamples` occurs inside `fullSamples` by sliding its voiced
 * RMS envelope over the full envelope. Returns endMs of the aligned prefix and
 * a confidence based on correlation strength and the runner-up margin.
 */
export function alignPrefix(prefixSamples, fullSamples, sampleRate, options = {}) {
  const config = { ...ALIGNMENT_DEFAULTS, ...options }
  const prefix = frameEnvelope(prefixSamples, sampleRate, config.frameMs)
  const full = frameEnvelope(fullSamples, sampleRate, config.frameMs)
  if (!prefix.count || !full.count || prefix.peak < 1e-6 || full.peak < 1e-6) {
    return {
      offsetMs: 0, endMs: 0, correlation: 0, margin: 0,
      confidence: 'low', method: 'envelope-correlation',
    }
  }
  const floor = prefix.peak * config.voicedRatio
  let first = -1
  let last = -1
  for (let index = 0; index < prefix.count; index += 1) {
    if (prefix.values[index] < floor) continue
    if (first < 0) first = index
    last = index
  }
  if (first < 0) {
    return {
      offsetMs: 0, endMs: 0, correlation: 0, margin: 0,
      confidence: 'low', method: 'envelope-correlation',
    }
  }
  const template = prefix.values.subarray(first, last + 1)
  const maxStart = Math.max(0, full.count - template.length)
  if (!maxStart) {
    return {
      offsetMs: 0, endMs: template.length * config.frameMs,
      correlation: 0, margin: 0, confidence: 'low', method: 'envelope-correlation',
    }
  }
  const expected = Math.round((options.expectedMs ?? 0) / config.frameMs)
  const window = Math.round(config.windowMs / config.frameMs)
  const from = Number.isFinite(expected)
    ? Math.max(0, Math.min(maxStart, expected - window))
    : 0
  const to = Number.isFinite(expected)
    ? Math.min(maxStart, expected + window)
    : maxStart

  let best = { start: from, score: -1 }
  let second = { start: from, score: -1 }
  for (let start = from; start <= to; start += 1) {
    let dot = 0
    let left = 0
    let right = 0
    for (let i = 0; i < template.length; i += 1) {
      const a = template[i]
      const b = full.values[start + i]
      dot += a * b
      left += a * a
      right += b * b
    }
    const score = dot / Math.sqrt(left * right + 1e-12)
    if (score > best.score) {
      second = best
      best = { start, score }
    } else if (score > second.score) {
      second = { start, score }
    }
  }
  // A neighbouring window is not an independent runner-up.
  if (Math.abs(second.start - best.start) <= 2) second.score = 0
  const correlation = Math.max(0, best.score)
  const margin = Math.max(0, correlation - Math.max(0, second.score))
  const confidence =
    correlation >= config.highCorrelation && margin >= config.highMargin
      ? 'high'
      : correlation >= config.mediumCorrelation && margin >= config.mediumMargin
        ? 'medium'
        : 'low'
  return {
    offsetMs: best.start * config.frameMs,
    endMs: (best.start + last + 1) * config.frameMs,
    correlation,
    margin,
    confidence,
    method: 'envelope-correlation',
  }
}

/** Mirror of the worker's 120ms PCM join for utterance resets. */
export function joinPcmParts(results, gapMs = 120) {
  if (!results.length) return new Float32Array(0)
  const sampleRate = results[0].sampleRate
  const gap = Math.max(0, Math.round((sampleRate * gapMs) / 1000))
  const total = results.reduce((sum, item) => sum + item.samples.length, 0)
    + gap * (results.length - 1)
  const samples = new Float32Array(total)
  let offset = 0
  for (let index = 0; index < results.length; index += 1) {
    samples.set(results[index].samples, offset)
    offset += results[index].samples.length + gap
  }
  return samples
}

/** Start time of each worker part in the joined PCM. */
export function partStartsMs(results, gapMs = 120) {
  const sampleRate = results[0]?.sampleRate ?? 0
  let start = 0
  return results.map((item, index) => {
    if (index > 0) start += gapMs
    const current = start
    start += (item.samples.length / sampleRate) * 1000
    return current
  })
}

export function decisionFor(verdict, alignment) {
  if (alignment?.confidence === 'low') return 'NEEDS_LISTENING'
  if (verdict !== 'ok') {
    return alignment?.confidence === 'high' ? 'FAIL' : 'NEEDS_LISTENING'
  }
  return alignment?.confidence === 'medium' ? 'WARNING' : 'PASS'
}
