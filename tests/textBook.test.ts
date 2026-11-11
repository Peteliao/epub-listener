import { describe, expect, it } from 'vitest'
import {
  decodeTextBuffer,
  parseTextBook,
  splitTextSections,
} from '@/core/reader/formats/textBook'

function utf8(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer
}

describe('decodeTextBuffer', () => {
  it('decodes UTF-8 with BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('你好')])
    expect(decodeTextBuffer(bytes.buffer)).toBe('你好')
  })

  it('decodes UTF-16LE with BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59])
    expect(decodeTextBuffer(bytes.buffer)).toBe('你好')
  })

  it('falls back to GB18030 for legacy Chinese text', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeTextBuffer(bytes.buffer)).toBe('中文')
  })
})

describe('splitTextSections', () => {
  it('splits on chapter headings', () => {
    const text = [
      '第一章 起点',
      '',
      '第一段。',
      '第二段。',
      '',
      '第二章 终点',
      '',
      '第三段。',
    ].join('\n')
    const sections = splitTextSections(text)
    expect(sections).toHaveLength(2)
    expect(sections[0]!.heading).toBe('第一章 起点')
    expect(sections[0]!.paragraphs).toEqual(['第一段。', '第二段。'])
    expect(sections[1]!.heading).toBe('第二章 终点')
    expect(sections[1]!.paragraphs).toEqual(['第三段。'])
  })

  it('keeps text before the first heading', () => {
    const sections = splitTextSections('前言文字。\n\n第一章 开始\n\n正文。\n\n第二章 继续\n\n结尾。')
    expect(sections.map((section) => section.label)).toEqual(['开篇', '第一章 开始', '第二章 继续'])
  })

  it('keeps a single heading as a chapter title', () => {
    const sections = splitTextSections('第一章 清晨\n\n天刚亮。')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.heading).toBe('第一章 清晨')
    expect(sections[0]!.paragraphs).toEqual(['天刚亮。'])
  })

  it('joins hard-wrapped lines and keeps paragraph breaks', () => {
    const sections = splitTextSections(
      'This is a long line\nthat wraps here.\n\nNext paragraph follows.',
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]!.paragraphs).toEqual([
      'This is a long line that wraps here.',
      'Next paragraph follows.',
    ])
  })

  it('starts a new paragraph on Chinese indentation', () => {
    const sections = splitTextSections('上一段没有句号\n　　这是新的一段。')
    expect(sections[0]!.paragraphs).toEqual(['上一段没有句号', '这是新的一段。'])
  })

  it('chunks long text without headings', () => {
    const paragraph = '这是一段很长的正文。'.repeat(50)
    const sections = splitTextSections(Array.from({ length: 40 }, () => paragraph).join('\n'))
    expect(sections.length).toBeGreaterThan(1)
    expect(sections.every((section) => section.heading === null)).toBe(true)
  })
})

describe('parseTextBook', () => {
  it('returns a readable title and sections', () => {
    const parsed = parseTextBook(utf8('第一章 开始\n\n正文。'), '  我的书  ')
    expect(parsed.title).toBe('我的书')
    expect(parsed.sections).toHaveLength(1)
  })

  it('rejects empty text', () => {
    expect(() => parseTextBook(utf8('   \n\n  '), '空书')).toThrow()
  })
})
