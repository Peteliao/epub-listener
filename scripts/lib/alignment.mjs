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
 *
 * `expectedMs` is the expected END of the prefix in the full audio (the callers
 * pass the prefix's own voiced end). The search window is centred on
 * `expectedMs - template.length`, not on `expectedMs` itself; otherwise a
 * prefix longer than the window can only ever be found at its tail.
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
  const hasExpected = Number.isFinite(options.expectedMs)
  const window = Math.round(config.windowMs / config.frameMs)
  const expectedStart = hasExpected
    ? Math.round(options.expectedMs / config.frameMs) - template.length
    : null
  const from = expectedStart == null
    ? 0
    : Math.max(0, Math.min(maxStart, expectedStart - window))
  const to = expectedStart == null
    ? maxStart
    : Math.min(maxStart, expectedStart + window)

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
    // `best.start` aligns with the template's first voiced frame. Adding
    // `last` would re-add the prefix's own leading silence and drift the word
    // boundary by `first * frameMs`.
    endMs: (best.start + template.length) * config.frameMs,
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

function trimForSeamlessJoin(samples, sampleRate) {
  const frame = Math.max(1, Math.round(sampleRate * 0.01))
  const count = Math.floor(samples.length / frame)
  const rms = new Float32Array(count)
  let peak = 0
  for (let index = 0; index < count; index += 1) {
    let sum = 0
    const offset = index * frame
    for (let i = 0; i < frame; i += 1) sum += samples[offset + i] ** 2
    const value = Math.sqrt(sum / frame)
    rms[index] = value
    if (value > peak) peak = value
  }
  if (!count || peak < 1e-6) return samples
  const floor = peak * 0.02
  let first = -1
  let last = -1
  for (let index = 0; index < count; index += 1) {
    if (rms[index] < floor) continue
    if (first < 0) first = index
    last = index
  }
  if (first < 0) return samples
  const margin = Math.round(sampleRate * 0.02)
  const from = Math.max(0, first * frame - margin)
  const to = Math.min(samples.length, (last + 1) * frame + margin)
  return samples.subarray(from, to)
}

/** Mirror of the worker's registered U+2061 seam: trim + 20ms equal-power crossfade. */
export function joinSeamlessPcmParts(results, fadeMs = 20) {
  if (!results.length) return new Float32Array(0)
  const sampleRate = results[0].sampleRate
  const prepared = results.map((item) => trimForSeamlessJoin(item.samples, sampleRate))
    .filter((samples) => samples.length > 0)
  if (!prepared.length) return new Float32Array(0)
  if (prepared.length === 1) return prepared[0]
  const fade = Math.min(
    Math.max(0, Math.round(sampleRate * fadeMs / 1000)),
    Math.floor(Math.min(...prepared.map((samples) => samples.length)) / 2),
  )
  const total = prepared.reduce((sum, samples) => sum + samples.length, 0)
    - fade * (prepared.length - 1)
  const samples = new Float32Array(total)
  let offset = 0
  prepared.forEach((part, index) => {
    if (index === 0) {
      samples.set(part, 0)
      offset = part.length
      return
    }
    const overlapStart = offset - fade
    for (let i = 0; i < fade; i += 1) {
      const t = fade <= 1 ? 1 : i / (fade - 1)
      samples[overlapStart + i] = samples[overlapStart + i] * Math.cos(t * Math.PI / 2)
        + part[i] * Math.sin(t * Math.PI / 2)
    }
    samples.set(part.subarray(fade), offset)
    offset += part.length - fade
  })
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
