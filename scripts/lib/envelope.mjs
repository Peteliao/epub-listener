/**
 * Full-sentence envelope analysis for the "phones look right but the word is
 * swallowed" class (立刻 is the canonical case).
 *
 * This is intentionally an ADVISORY metric: Chinese syllables can merge without
 * a hard silent gap, so the envelope cannot replace listening. It is useful for
 * ranking targets and for proving a target's second syllable still has a real
 * burst after a fix.
 */

export const ENVELOPE_DEFAULTS = Object.freeze({
  frameMs: 10,
  thresholdRatio: 0.15,
})

function framesOf(samples, sampleRate, frameMs) {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const count = Math.floor(samples.length / frame)
  const rms = new Float32Array(count)
  let peak = 0
  for (let index = 0; index < count; index += 1) {
    let sum = 0
    const offset = index * frame
    for (let i = 0; i < frame; i += 1) {
      const value = samples[offset + i] ?? 0
      sum += value * value
    }
    const value = Math.sqrt(sum / frame)
    rms[index] = value
    if (value > peak) peak = value
  }
  return { frame, count, rms, peak }
}

/**
 * Returns voiced runs and gaps in milliseconds. A run is a contiguous set of
 * 10ms frames above `thresholdRatio * peak`; a gap is the low-energy stretch
 * between two runs.
 */
export function analyzeEnvelope(samples, sampleRate, options = {}) {
  const frameMs = options.frameMs ?? ENVELOPE_DEFAULTS.frameMs
  const thresholdRatio = options.thresholdRatio ?? ENVELOPE_DEFAULTS.thresholdRatio
  const { frame, count, rms, peak } = framesOf(samples, sampleRate, frameMs)
  if (!count || peak < 1e-6) {
    return { sampleMs: 0, frameMs, peak: 0, threshold: 0, runs: [], gaps: [] }
  }
  const threshold = peak * thresholdRatio
  const runs = []
  let start = -1
  let runPeak = 0
  for (let index = 0; index <= count; index += 1) {
    const active = index < count && rms[index] >= threshold
    if (active) {
      if (start < 0) start = index
      runPeak = Math.max(runPeak, rms[index])
      continue
    }
    if (start >= 0) {
      runs.push({
        startMs: start * frameMs,
        endMs: index * frameMs,
        ms: (index - start) * frameMs,
        peak: runPeak,
      })
      start = -1
      runPeak = 0
    }
  }
  const gaps = []
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]
    const current = runs[index]
    gaps.push({
      startMs: previous.endMs,
      endMs: current.startMs,
      ms: current.startMs - previous.endMs,
    })
  }
  return {
    sampleMs: (samples.length / sampleRate) * 1000,
    frameMs,
    peak,
    threshold,
    runs,
    gaps,
  }
}

/** Last voiced frame of a rendered prefix, used to estimate the word's start. */
export function voicedBounds(samples, sampleRate, options = {}) {
  const frameMs = options.frameMs ?? ENVELOPE_DEFAULTS.frameMs
  const thresholdRatio = options.thresholdRatio ?? 0.05
  const { count, rms, peak } = framesOf(samples, sampleRate, frameMs)
  if (!count || peak < 1e-6) return { startMs: 0, endMs: 0, ms: 0 }
  const threshold = peak * thresholdRatio
  let first = -1
  let last = -1
  for (let index = 0; index < count; index += 1) {
    if (rms[index] < threshold) continue
    if (first < 0) first = index
    last = index
  }
  if (first < 0) return { startMs: 0, endMs: 0, ms: 0 }
  return {
    startMs: first * frameMs,
    endMs: (last + 1) * frameMs,
    ms: (last + 1 - first) * frameMs,
  }
}

/**
 * Locate the target word's first two bursts after `prefixEndMs`.
 *
 * A run that ends within 50ms of the prefix bound is treated as the prefix's
 * own tail and skipped. The next two runs are the two syllables. If the second
 * run is missing or has too little energy/duration, the target is flagged.
 */
/**
 * Triage grade used by the listening queue:
 *   S = full-sentence envelope already shows a swallow/merge;
 *   A = second burst survives but is still short (<100ms);
 *   B = OOV/acoustic candidate that measured normal.
 * C is reserved for dictionary-normal boundary candidates (never an emergency).
 */
export function severityFor(result, options = {}) {
  const aMs = options.aMs ?? 100
  if (!result || result.verdict !== 'ok') return 'S'
  return (result.second?.ms ?? 0) < aMs ? 'A' : 'B'
}

export function evaluateTarget(envelope, prefixEndMs, options = {}) {
  const searchBeforeMs = options.searchBeforeMs ?? 400
  const searchAfterMs = options.searchAfterMs ?? 800
  const minPeakRatio = options.minPeakRatio ?? 0.2
  const minSecondMs = options.minSecondMs ?? 60
  const minSecondPeakRatio = options.minSecondPeakRatio ?? 0.25
  const searchStart = Math.max(0, prefixEndMs - searchBeforeMs)
  const searchEnd = Math.min(envelope.sampleMs, prefixEndMs + searchAfterMs)
  const minPeak = envelope.peak * minPeakRatio
  const candidates = envelope.runs.filter((run) =>
    run.startMs >= searchStart
    && run.endMs <= searchEnd + 200
    && run.endMs > prefixEndMs + 50
    && run.peak >= minPeak)
  if (!candidates.length) {
    return { verdict: 'missing', prefixEndMs, first: null, second: null, gapMs: null }
  }
  const first = candidates[0]
  const second = candidates.find((run) => run.startMs >= first.endMs + 20) ?? null
  if (!second) {
    return {
      verdict: 'merged',
      prefixEndMs,
      first,
      second: null,
      gapMs: null,
    }
  }
  const gapMs = second.startMs - first.endMs
  const weak =
    second.ms < minSecondMs || second.peak < first.peak * minSecondPeakRatio
  return {
    verdict: weak ? 'weak-second' : 'ok',
    prefixEndMs,
    first,
    second,
    gapMs,
  }
}
