const SAMPLE_BYTES = 1024 * 1024

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function sampleBuffer(file: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(file)
  const size = Math.min(bytes.length, SAMPLE_BYTES)
  if (bytes.length <= SAMPLE_BYTES) return bytes.slice(0, size)

  const first = bytes.slice(0, SAMPLE_BYTES)
  const last = bytes.slice(bytes.length - SAMPLE_BYTES)
  const payload = new Uint8Array(first.length + last.length)
  payload.set(first, 0)
  payload.set(last, first.length)
  return payload
}

/**
 * A cheap cross-device identity for an imported file. Hashing the first and
 * last megabyte catches the EPUB mimetype/container headers and central
 * directory without reading a 200 MB book on a phone.
 */
export async function computeBookFingerprint(
  file: ArrayBuffer,
  format: string,
): Promise<string | null> {
  try {
    const sample = sampleBuffer(file)
    if (!sample.length) return null

    const meta = new TextEncoder().encode(`${file.byteLength}:${format}:`)
    const payload = new Uint8Array(meta.length + sample.length)
    payload.set(meta, 0)
    payload.set(sample, meta.length)

    const subtle = globalThis.crypto?.subtle
    if (subtle) {
      const digest = await subtle.digest('SHA-256', payload)
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
      return `sha256:${hex.slice(0, 32)}`
    }

    return `fnv1a:${fnv1a(payload)}:${file.byteLength}`
  } catch {
    return null
  }
}
