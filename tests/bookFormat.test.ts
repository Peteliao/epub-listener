import { describe, expect, it } from 'vitest'
import { detectBookFormat } from '@/core/reader/formats/bookFormat'

function makeBuffer(bytes: number[], size = 256): ArrayBuffer {
  const buffer = new Uint8Array(size)
  buffer.set(bytes)
  return buffer.buffer
}

function asciiAt(buffer: ArrayBuffer, offset: number, text: string): ArrayBuffer {
  new Uint8Array(buffer).set(new TextEncoder().encode(text), offset)
  return buffer
}

describe('detectBookFormat', () => {
  it('detects EPUB by zip magic', () => {
    expect(detectBookFormat('book.epub', makeBuffer([0x50, 0x4b, 0x03, 0x04]))).toBe('epub')
    expect(detectBookFormat('renamed.bin', makeBuffer([0x50, 0x4b, 0x05, 0x06]))).toBe('epub')
  })

  it('detects MOBI and AZW3 by BOOKMOBI magic', () => {
    const buffer = asciiAt(makeBuffer([]), 60, 'BOOKMOBI')
    expect(detectBookFormat('book.mobi', buffer)).toBe('mobi')
    expect(detectBookFormat('book.azw3', buffer)).toBe('azw3')
  })

  it('detects FB2 by FictionBook root element', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body/></FictionBook>'
    const buffer = new TextEncoder().encode(xml).buffer
    expect(detectBookFormat('book.fb2', buffer)).toBe('fb2')
    expect(detectBookFormat('book.zip', buffer)).toBe('fb2')
  })

  it('treats .txt as plain text', () => {
    const buffer = new TextEncoder().encode('第一章 开始\n正文。').buffer
    expect(detectBookFormat('novel.txt', buffer)).toBe('txt')
  })

  it('rejects unsupported formats', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n...').buffer
    expect(detectBookFormat('book.pdf', pdf)).toBeNull()
    expect(detectBookFormat('book.azw', new TextEncoder().encode('x').buffer)).toBeNull()
  })
})
