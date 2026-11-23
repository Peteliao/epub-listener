import { readFileSync, writeFileSync } from 'node:fs'

/** Minimal 16-bit PCM WAV reader for blind evaluation copies. */
export function readWav(path) {
  const buffer = readFileSync(path)
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`不是有效的 WAV：${path}`)
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let format = 0
  let channels = 1
  let sampleRate = 0
  let bits = 0
  let data = null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size))
    }
    offset = body + size + (size % 2)
  }
  if (format !== 1 || bits !== 16 || !sampleRate || !data) {
    throw new Error(`只支持 16-bit PCM WAV：${path}`)
  }
  const frames = Math.floor(data.length / (2 * channels))
  const samples = new Float32Array(frames)
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = dataView.getInt16(index * 2 * channels, true) / 32768
  }
  return { samples, sampleRate, channels }
}

export function writeWav(path, samples, sampleRate) {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32767)))
    buffer.writeInt16LE(value, 44 + index * 2)
  }
  writeFileSync(path, buffer)
}

/** Peak-normalise an EVALUATION COPY only; never touch the rendered original. */
export function normalizePeak(samples, targetPeak = 0.9) {
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  if (peak < 1e-6) return new Float32Array(samples.length)
  const gain = targetPeak / peak
  const output = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = samples[index] * gain
  }
  return output
}

export const LOUDNESS_DEFAULTS = Object.freeze({
  frameMs: 20,
  targetDb: -20,
  ceiling: 0.95,
  // Frames more than 25 dB below the loudest frame are pauses, not speech.
  gateBelowMaxDb: 25,
})

/**
 * Active-speech level of an EVALUATION COPY. Pauses are excluded so that a
 * version with longer inter-sentence silence is not made louder as a result.
 * This is RMS over active frames, not a full EBU R128/LUFS implementation.
 */
export function measureSpeechLevel(samples, sampleRate, options = {}) {
  const config = { ...LOUDNESS_DEFAULTS, ...options }
  const frame = Math.max(1, Math.round((sampleRate * config.frameMs) / 1000))
  const count = Math.floor(samples.length / frame)
  if (!count) {
    let peak = 0
    for (const value of samples) peak = Math.max(peak, Math.abs(value))
    return { peak, activeRms: 0, activeDb: -Infinity, activeFrames: 0, totalFrames: 0 }
  }
  // Peak must cover the final partial frame too; otherwise a transient there
  // escapes the ceiling check and the normalised copy clips.
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  let maxFrameRms = 0
  const frameRms = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    let sum = 0
    const offset = index * frame
    for (let i = 0; i < frame; i += 1) {
      const value = samples[offset + i] ?? 0
      sum += value * value
    }
    const rms = Math.sqrt(sum / frame)
    frameRms[index] = rms
    if (rms > maxFrameRms) maxFrameRms = rms
  }
  if (maxFrameRms < 1e-6) {
    return { peak, activeRms: 0, activeDb: -Infinity, activeFrames: 0, totalFrames: count }
  }
  // Use the 95th percentile rather than the single loudest frame so one click
  // cannot gate out the rest of the speech.
  const sorted = [...frameRms].sort((left, right) => left - right)
  const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const gate = reference * 10 ** (-config.gateBelowMaxDb / 20)
  let activeFrames = 0
  let sumSquares = 0
  for (const rms of frameRms) {
    if (rms < gate) continue
    activeFrames += 1
    sumSquares += rms * rms
  }
  const activeRms = Math.sqrt(sumSquares / activeFrames)
  return {
    peak,
    activeRms,
    activeDb: 20 * Math.log10(activeRms),
    activeFrames,
    totalFrames: count,
  }
}

/**
 * Loudness-normalise an EVALUATION COPY to an active-speech RMS target while
 * keeping a peak ceiling. Returns a new buffer; the rendered original is never
 * modified. Pauses do not inflate the measured level.
 */
export function normalizeLoudness(samples, sampleRate, options = {}) {
  const config = { ...LOUDNESS_DEFAULTS, ...options }
  const level = measureSpeechLevel(samples, sampleRate, config)
  if (level.activeRms < 1e-6 || level.peak < 1e-6) {
    return new Float32Array(samples.length)
  }
  const targetRms = 10 ** (config.targetDb / 20)
  let gain = targetRms / level.activeRms
  if (level.peak * gain > config.ceiling) gain = config.ceiling / level.peak
  const output = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = samples[index] * gain
  }
  return output
}
