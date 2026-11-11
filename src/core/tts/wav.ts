const HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 2

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

/** Packs float PCM into a 16-bit mono WAV so an <audio> element can play it. */
export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  view.setUint16(32, BYTES_PER_SAMPLE, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = HEADER_BYTES
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    view.setInt16(offset, Math.round(value), true)
    offset += BYTES_PER_SAMPLE
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export function wavDurationMs(
  samples: Float32Array,
  sampleRate: number,
): number {
  if (sampleRate <= 0) return 0
  return Math.round((samples.length / sampleRate) * 1000)
}
