import type { BookFormat } from '@/types'

export const IMPORT_ACCEPT =
  '.epub,.fb2,.mobi,.azw3,.txt,application/epub+zip,application/x-mobipocket-ebook,text/plain'

function isZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false
  const bytes = new Uint8Array(buffer, 0, 4)
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)
}

function isMobi(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 68) return false
  const magic = new TextDecoder('ascii').decode(
    new Uint8Array(buffer, 60, 8),
  )
  return magic === 'BOOKMOBI'
}

function looksLikeFb2(buffer: ArrayBuffer): boolean {
  const head = new TextDecoder('utf-8').decode(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)),
  )
  return /<FictionBook[\s>]/i.test(head)
}

export function detectBookFormat(fileName: string, buffer: ArrayBuffer): BookFormat | null {
  if (isZip(buffer)) return 'epub'
  if (isMobi(buffer)) return /\.azw3$/i.test(fileName) ? 'azw3' : 'mobi'
  if (looksLikeFb2(buffer)) return 'fb2'
  if (/\.fb2$/i.test(fileName)) return 'fb2'
  if (/\.azw3$/i.test(fileName)) return 'azw3'
  if (/\.mobi$/i.test(fileName)) return 'mobi'
  if (/\.txt$/i.test(fileName)) return 'txt'
  return null
}
