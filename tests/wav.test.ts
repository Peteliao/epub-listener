import { describe, expect, it } from 'vitest'
import { encodeWavBlob, wavDurationMs } from '../src/core/tts/wav'

const HEADER_BYTES = 44

async function readWav(samples: Float32Array, sampleRate: number) {
  const blob = encodeWavBlob(samples, sampleRate)
  return new DataView(await blob.arrayBuffer())
}

function ascii(view: DataView, offset: number, length: number): string {
  let text = ''
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i))
  }
  return text
}

describe('encodeWavBlob', () => {
  it('writes a mono 16-bit PCM header', async () => {
    const view = await readWav(new Float32Array([0, 0.5, -0.5]), 8000)

    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint32(28, true)).toBe(16000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.byteLength).toBe(HEADER_BYTES + 6)
  })

  it('converts samples to signed 16-bit values', async () => {
    const view = await readWav(new Float32Array([0, 1, -1, 0.5]), 8000)

    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
    expect(view.getInt16(50, true)).toBe(16384)
  })

  it('clamps out-of-range samples', async () => {
    const view = await readWav(new Float32Array([4, -4]), 8000)

    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })

  it('reads back the duration', () => {
    expect(wavDurationMs(new Float32Array(8000), 8000)).toBe(1000)
    expect(wavDurationMs(new Float32Array(22050), 22050)).toBe(1000)
    expect(wavDurationMs(new Float32Array(10), 0)).toBe(0)
  })
})
