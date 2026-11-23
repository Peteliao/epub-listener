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
