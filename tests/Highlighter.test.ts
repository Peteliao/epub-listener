import { beforeEach, describe, expect, it } from 'vitest'
import { Highlighter } from '../src/core/reader/Highlighter'

function build(html: string, spineIndex = 2): Highlighter {
  document.head.innerHTML = ''
  document.body.innerHTML = html
  return new Highlighter(document, spineIndex)
}

describe('Highlighter', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  it('joins inline elements into one sentence and stamps every fragment', () => {
    const highlighter = build(
      '<p>他慢慢地<em>转过身来</em>，看着远处的山谷。第二句话也足够长，可以独立成句。</p>',
    )

    expect(highlighter.sentences.map((sentence) => sentence.text)).toEqual([
      '他慢慢地转过身来，看着远处的山谷。',
      '第二句话也足够长，可以独立成句。',
    ])

    const first = highlighter.sentences[0]!
    expect(first.spans).toHaveLength(3)
    expect(first.spans.map((span) => span.textContent).join('')).toBe(first.text)
    expect(new Set(first.spans.map((span) => span.dataset.sid)).size).toBe(1)
    expect(first.spans[0]!.dataset.sentenceIndex).toBe('0')
    expect(document.body.dataset.ttsWrapped).toBe('v1')
  })

  it('treats soft line breaks inside a paragraph as spaces', () => {
    const highlighter = build('<p>埃及人平均所得水\n准只有美国人的12%左右。</p>')

    expect(highlighter.sentences).toHaveLength(1)
    expect(highlighter.sentences[0]!.speechText).toContain('水准')
  })

  it('drops the gap a source line break leaves after punctuation', () => {
    const highlighter = build(
      '<p>（与地底爬虫族无关）\n为争夺地球铜矿的毁灭战导致恐龙灭绝。</p>',
    )

    const speechText = highlighter.sentences[0]!.speechText
    expect(speechText).toContain('）为争夺')
    expect(speechText).not.toContain(' ')
  })

  it('joins words split by a <br> line break', () => {
    const highlighter = build('<p>透过后<br>世对他的高歌与唾骂。</p>')

    expect(highlighter.sentences).toHaveLength(1)
    expect(highlighter.sentences[0]!.speechText).toBe(
      '透过后世对他的高歌与唾骂。',
    )
  })

  it('joins words split by block boundaries without punctuation', () => {
    const highlighter = build(
      '<p>始终吹不尽的是孟</p><p>姜女千年哭咒。</p><p>怎奈，秦国始终未能拿到督亢<br/>地图。</p>',
    )

    expect(highlighter.sentences.map((sentence) => sentence.speechText)).toEqual([
      '始终吹不尽的是孟姜女千年哭咒。',
      '怎奈，秦国始终未能拿到督亢地图。',
    ])
  })

  it('joins 地图 when the wrap falls between 地 and 图', () => {
    const highlighter = build(
      '<p>怎奈，秦国始终未能拿到督亢地<br/>图，大军只得在城外安营扎寨。</p>',
    )

    expect(highlighter.sentences).toHaveLength(1)
    expect(highlighter.sentences[0]!.speechText).toBe(
      '怎奈，秦国始终未能拿到督亢地图，大军只得在城外安营扎寨。',
    )
  })

  it('keeps headings and list items as separate sentences', () => {
    const highlighter = build(
      '<h1>第一章</h1><ul><li>第一件事</li><li>第二件事</li></ul><p>他走进屋子，看到桌上有一封没有署名的信。</p>',
    )

    expect(highlighter.sentences.map((sentence) => sentence.text)).toEqual([
      '第一章',
      '第一件事',
      '第二件事',
      '他走进屋子，看到桌上有一封没有署名的信。',
    ])
  })

  it('never merges sentences across block elements', () => {
    const highlighter = build(
      '<p>第一段文字内容足够长一些。</p><p>第二段文字内容也足够长。</p>',
    )
    expect(highlighter.sentences.map((sentence) => sentence.text)).toEqual([
      '第一段文字内容足够长一些。',
      '第二段文字内容也足够长。',
    ])
  })

  it('treats lowercase XHTML block tags as paragraph boundaries', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一段文字内容足够长一些。</p><p>第二段文字内容也足够长。</p></body></html>',
      'application/xhtml+xml',
    )
    const highlighter = new Highlighter(doc, 2)

    expect(highlighter.sentences.map((sentence) => sentence.text)).toEqual([
      '第一段文字内容足够长一些。',
      '第二段文字内容也足够长。',
    ])
  })

  it('skips ruby annotations, scripts, styles and footnotes', () => {
    const highlighter = build(`
      <style>.noise { color: red; }</style>
      <script>const noise = '脚本内容'</script>
      <p><ruby>汉<rt>hàn</rt></ruby>字句子足够长了。另一个句子也足够长了。</p>
      <p>正文句子内容足够长一些。</p>
      <aside epub:type="footnote">脚注内容不应朗读。</aside>
    `)

    const text = highlighter.sentences.map((sentence) => sentence.text).join('|')
    expect(text).not.toContain('hàn')
    expect(text).not.toContain('脚本内容')
    expect(text).not.toContain('脚注内容')
    expect(text).toContain('汉字句子足够长了。')
  })

  it('highlights every span of the active sentence', () => {
    const highlighter = build(
      '<p>他慢慢地<em>转过身来</em>，看着远处的山谷。第二句话也足够长，可以独立成句。</p>',
    )

    highlighter.setActive(0, { scroll: false })
    expect(document.querySelectorAll('.tts-active')).toHaveLength(3)

    highlighter.setActive(1, { scroll: false })
    expect(document.querySelectorAll('.tts-active')).toHaveLength(1)
    expect(highlighter.sentences[1]!.spans[0]!.classList.contains('tts-active')).toBe(true)
    expect(highlighter.sentences[0]!.spans[0]!.classList.contains('tts-active')).toBe(false)
  })

  it('highlights a range of sentences and shrinks it again', () => {
    const highlighter = build(
      '<p>他慢慢地<em>转过身来</em>，看着远处的山谷。第二句话也足够长，可以独立成句。</p>',
    )

    highlighter.setActiveRange(0, 1, { scroll: false })
    expect(document.querySelectorAll('.tts-active')).toHaveLength(4)
    expect(highlighter.activeSentence?.index).toBe(0)
    expect(highlighter.activeSentences.map((sentence) => sentence.index)).toEqual([0, 1])

    highlighter.syncActive({ scroll: false })
    expect(document.querySelectorAll('.tts-active')).toHaveLength(4)

    highlighter.setActive(1, { scroll: false })
    expect(document.querySelectorAll('.tts-active')).toHaveLength(1)
    expect(
      highlighter.sentences[0]!.spans[0]!.classList.contains('tts-active'),
    ).toBe(false)

    highlighter.clearActive()
    expect(document.querySelectorAll('.tts-active')).toHaveLength(0)
    expect(highlighter.activeSentence).toBeNull()
  })

  it('is idempotent when rebuilt on the same document', () => {
    const html =
      '<p>他慢慢地<em>转过身来</em>，看着远处的山谷。第二句话也足够长，可以独立成句。</p>'
    const first = build(html)
    const originalText = document.body.textContent
    const originalSids = first.sentences.map((sentence) => sentence.sid)

    const second = new Highlighter(document, 2)

    expect(second.sentences.map((sentence) => sentence.sid)).toEqual(originalSids)
    expect(document.body.textContent).toBe(originalText)
    expect(document.querySelectorAll('span.tts-sentence')).toHaveLength(
      second.sentences.reduce((total, sentence) => total + sentence.spans.length, 0),
    )
    expect(document.querySelectorAll('span.tts-sentence span.tts-sentence')).toHaveLength(0)
  })

  it('restores the original DOM when destroyed', () => {
    const html = '<p>他慢慢地<em>转过身来</em>，看着远处的山谷。第二句话也足够长，可以独立成句。</p>'
    const highlighter = build(html)
    highlighter.destroy()

    expect(document.querySelectorAll('span.tts-sentence')).toHaveLength(0)
    expect(document.body.dataset.ttsWrapped).toBeUndefined()
    expect(document.querySelector('p')!.textContent).toBe(
      '他慢慢地转过身来，看着远处的山谷。第二句话也足够长，可以独立成句。',
    )
  })
})
