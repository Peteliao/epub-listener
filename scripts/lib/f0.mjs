/**
 * Frame-wise F0 / voicing analysis for the listening-quality report.
 *
 * This is a diagnostic, not a hard gate: voiceless consonants (the k closure in
 * 立刻) are legitimately low-energy. We only report continuity, jumps and the
 * final slope so a human can compare before/after and spot interrupted tones.
 */

export const F0_DEFAULTS = Object.freeze({
  frameMs: 40,
  hopMs: 20,
  minHz: 70,
  maxHz: 400,
  rmsFloorRatio: 0.02,
  minCorrelation: 0.45,
  jumpRatio: 0.2,
  finalWindowMs: 300,
})

function frameRms(samples, start, size) {
  let sum = 0
  for (let i = 0; i < size; i += 1) {
    const value = samples[start + i] ?? 0
    sum += value * value
  }
  return Math.sqrt(sum / size)
}

function frameF0(samples, start, size, sampleRate, minLag, maxLag, minCorrelation) {
  let mean = 0
  for (let i = 0; i < size; i += 1) mean += samples[start + i] ?? 0
  mean /= size
  let bestLag = 0
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0
    let left = 0
    let right = 0
    for (let i = 0; i + lag < size; i += 1) {
      const a = (samples[start + i] ?? 0) - mean
      const b = (samples[start + i + lag] ?? 0) - mean
      corr += a * b
      left += a * a
      right += b * b
    }
    const norm = corr / Math.sqrt(left * right + 1e-12)
    if (norm > best) {
      best = norm
      bestLag = lag
    }
  }
  return best >= minCorrelation
    ? { f0: sampleRate / bestLag, correlation: best }
    : { f0: null, correlation: best }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function linearSlope(frames) {
  if (frames.length < 3) return null
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const item of frames) {
    const x = item.timeMs / 1000
    const y = item.f0
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denominator = frames.length * sumXX - sumX * sumX
  return Math.abs(denominator) > 1e-9
    ? (frames.length * sumXY - sumX * sumY) / denominator
    : null
}

/** Local F0 of the target word, not the sentence-final tail. */
export function analyzeTargetF0(report, startMs, endMs) {
  const frames = (report.frames ?? []).filter((item) =>
    item.f0 !== null && item.timeMs >= startMs && item.timeMs <= endMs)
  if (!frames.length) {
    return {
      frames: 0, meanF0: null, minF0: null, maxF0: null,
      slopeHzPerSec: null, jumpRatio: 0, confidence: 'low',
    }
  }
  let jumps = 0
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1].f0
    const current = frames[index].f0
    if (Math.abs(current - previous) / Math.min(current, previous) > 0.2) jumps += 1
  }
  const slope = linearSlope(frames)
  return {
    frames: frames.length,
    meanF0: frames.reduce((sum, item) => sum + item.f0, 0) / frames.length,
    minF0: Math.min(...frames.map((item) => item.f0)),
    maxF0: Math.max(...frames.map((item) => item.f0)),
    slopeHzPerSec: slope,
    jumpRatio: frames.length > 1 ? jumps / (frames.length - 1) : 0,
    confidence: frames.length >= 4 ? 'high' : frames.length >= 2 ? 'medium' : 'low',
  }
}

export function analyzeF0(samples, sampleRate, options = {}) {
  const config = { ...F0_DEFAULTS, ...options }
  const frame = Math.max(2, Math.round((sampleRate * config.frameMs) / 1000))
  const hop = Math.max(1, Math.round((sampleRate * config.hopMs) / 1000))
  if (!samples.length) {
    return {
      frames: [], voicedFrames: 0, totalFrames: 0, voicedRatio: 0,
      meanF0: null, jumpRatio: 0, maxJump: 0, octaveJumps: 0,
      finalSlopeHzPerSec: null, peakRms: 0,
    }
  }
  let peakRms = 0
  for (let start = 0; start + frame <= samples.length; start += hop) {
    peakRms = Math.max(peakRms, frameRms(samples, start, frame))
  }
  const floor = peakRms * config.rmsFloorRatio
  const minLag = Math.max(2, Math.floor(sampleRate / config.maxHz))
  const maxLag = Math.max(minLag + 1, Math.ceil(sampleRate / config.minHz))
  const frames = []
  for (let start = 0; start + frame <= samples.length; start += hop) {
    const rms = frameRms(samples, start, frame)
    if (rms < floor) {
      frames.push({ timeMs: (start / sampleRate) * 1000, f0: null, rms, correlation: 0 })
      continue
    }
    const result = frameF0(samples, start, frame, sampleRate, minLag, maxLag, config.minCorrelation)
    frames.push({
      timeMs: (start / sampleRate) * 1000,
      rms,
      ...result,
    })
  }

  // Octave errors are common with short, high-pitched Chinese syllables. Pull
  // an isolated 2x/0.5x frame back toward the median of its voiced neighbours.
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    if (frame.f0 === null) continue
    const neighbours = frames
      .slice(Math.max(0, index - 3), Math.min(frames.length, index + 4))
      .filter((item) => item.f0 !== null)
      .map((item) => item.f0)
    const local = median(neighbours)
    if (!local) continue
    const ratio = frame.f0 / local
    if (ratio > 1.7 && ratio < 2.3) frame.f0 /= 2
    else if (ratio > 0.43 && ratio < 0.59) frame.f0 *= 2
  }

  const voiced = frames.filter((item) => item.f0 !== null)
  let jumpFrames = 0
  let maxJump = 0
  let octaveJumps = 0
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]
    const current = frames[index]
    if (previous.f0 === null || current.f0 === null) continue
    const low = Math.min(previous.f0, current.f0)
    const high = Math.max(previous.f0, current.f0)
    const jump = (high - low) / low
    maxJump = Math.max(maxJump, jump)
    if (jump > config.jumpRatio) jumpFrames += 1
    if ((high / low >= 1.8 && high / low <= 2.2) || (low / high >= 0.45 && low / high <= 0.55)) {
      octaveJumps += 1
    }
  }

  let finalSlopeHzPerSec = null
  const lastVoicedTime = voiced[voiced.length - 1]?.timeMs ?? 0
  const tail = voiced.filter((item) => item.timeMs >= lastVoicedTime - config.finalWindowMs)
  if (tail.length >= 3) finalSlopeHzPerSec = linearSlope(tail)

  return {
    frames,
    voicedFrames: voiced.length,
    totalFrames: frames.length,
    voicedRatio: frames.length ? voiced.length / frames.length : 0,
    meanF0: voiced.length
      ? voiced.reduce((sum, item) => sum + item.f0, 0) / voiced.length
      : null,
    jumpRatio: voiced.length > 1 ? jumpFrames / (voiced.length - 1) : 0,
    maxJump,
    octaveJumps,
    finalSlopeHzPerSec,
    peakRms,
  }
}
