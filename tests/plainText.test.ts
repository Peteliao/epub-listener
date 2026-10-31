import { describe, expect, it } from 'vitest'
import { extractDocumentText } from '@/core/reader/plainText'

function extract(html: string): string {
  document.body.innerHTML = html
  return extractDocumentText(document)
}

describe('extractDocumentText', () => {
  it('joins inline content and separates blocks with single newlines', () => {
    expect(
      extract(
        '<div><p>他慢慢地<em>转过身来</em>，看着山谷。</p><p>第二段。</p></div>',
      ),
    ).toBe('他慢慢地转过身来，看着山谷。\n第二段。')
  })

  it('turns br into a newline and skips ruby annotations', () => {
    expect(
      extract('<p>汉<ruby>字<rt>zi</rt><rp>(</rp></ruby><br>下一行</p>'),
    ).toBe('汉字\n下一行')
  })

  it('ignores script, style and document metadata', () => {
    expect(
      extract(
        '<p>正文<span>补充</span></p><script>alert(1)</script><style>p{}</style><title>标题</title>',
      ),
    ).toBe('正文补充')
  })

  it('normalizes non-breaking spaces and collapses blank lines', () => {
    expect(extract('<p>一&nbsp;二</p><div></div><div></div><p>三</p>')).toBe(
      '一 二\n三',
    )
  })

  it('returns an empty string for an empty document', () => {
    expect(extract('')).toBe('')
  })
})
