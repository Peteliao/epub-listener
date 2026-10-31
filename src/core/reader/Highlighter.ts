import { splitSentences } from '../text/SentenceSplitter'
import { normalizeSpeechText } from '../text/TextNormalizer'

interface CharRef {
  node: Text
  offset: number
}

interface FragmentSlice {
  node: Text
  start: number
  end: number
  sentenceIndex: number
  sid: string
}

export interface Sentence {
  index: number
  sid: string
  text: string
  speechText: string
  paragraphEnd: boolean
  dialogue: boolean
  spans: HTMLElement[]
}

export interface HighlightOptions {
  scroll?: boolean
  behavior?: ScrollBehavior
  forceScroll?: boolean
  topInset?: number
  bottomInset?: number
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'RT',
  'RP',
  'SVG',
  'MATH',
  'HEAD',
])

export const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'NAV',
  'LI',
  'UL',
  'OL',
  'DL',
  'DT',
  'DD',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'FIGCAPTION',
  'FIGURE',
  'FORM',
  'FIELDSET',
  'ADDRESS',
  'CENTER',
  'DETAILS',
  'SUMMARY',
  'HR',
])

const STYLE_ID = 'shusheng-sentence-style'

const HIGHLIGHT_CSS = `
.tts-sentence {
  display: inline;
}
.tts-sentence.tts-active {
  background-color: var(--tts-highlight, rgba(218, 154, 70, 0.34));
  border-radius: 0.18em;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  transition: background-color 140ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .tts-sentence.tts-active { transition: none; }
}
`

function shouldSkip(element: Element): boolean {
  // XHTML documents keep tagName lowercase, so compare in one case.
  if (SKIP_TAGS.has(element.tagName.toUpperCase())) return true
  if (element.hasAttribute('hidden')) return true
  if (element.getAttribute('aria-hidden') === 'true') return true

  const epubType = element.getAttribute('epub:type') ?? ''
  const role = element.getAttribute('role') ?? ''
  return /footnote|endnote|doc-noteref/.test(`${epubType} ${role}`)
}

function findScrollContainer(doc: Document): HTMLElement | null {
  const frame = doc.defaultView?.frameElement as HTMLElement | null
  if (!frame) return null

  let element = frame.parentElement
  while (element) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
      return element
    }
    element = element.parentElement
  }
  return null
}

/**
 * Wraps every readable sentence in one or more inline spans and maps each
 * sentence to its spans. Text content and reading order are preserved.
 */
export class Highlighter {
  readonly sentences: Sentence[] = []

  private readonly doc: Document
  private readonly spineIndex: number
  private readonly scrollContainer: HTMLElement | null
  private activeRange: { start: number; end: number } | null = null
  private animationFrame: number | null = null
  private scrollRetryTimer: number | null = null
  private scrollRetryCount = 0

  constructor(doc: Document, spineIndex: number) {
    this.doc = doc
    this.spineIndex = spineIndex
    this.scrollContainer = findScrollContainer(doc)
    this.build()
  }

  get activeSentence(): Sentence | null {
    return this.activeRange
      ? (this.sentences[this.activeRange.start] ?? null)
      : null
  }

  get activeSentences(): Sentence[] {
    if (!this.activeRange) return []
    return this.sentences.slice(this.activeRange.start, this.activeRange.end + 1)
  }

  getSentence(index: number): Sentence | null {
    return this.sentences[index] ?? null
  }

  setActive(index: number, options: HighlightOptions = {}): void {
    this.setActiveRange(index, index, options)
  }

  /** Highlights a run of sentences, used when several are spoken as a group. */
  setActiveRange(
    start: number,
    end: number,
    options: HighlightOptions = {},
  ): void {
    if (!this.sentences.length) return
    const from = Math.max(0, Math.min(start, end, this.sentences.length - 1))
    const to = Math.min(
      this.sentences.length - 1,
      Math.max(start, end, 0),
    )
    if (from > to) return

    const previous = this.activeRange
    if (!previous || previous.start !== from || previous.end !== to) {
      if (previous) this.clearSpans(previous)
      for (let i = from; i <= to; i += 1) {
        this.sentences[i]?.spans.forEach((span) =>
          span.classList.add('tts-active'),
        )
      }
      this.activeRange = { start: from, end: to }
    }

    if (options.scroll !== false) {
      this.scrollTo(from, options)
    }
  }

  /** Re-applies the active class after a reflow and optionally scrolls again. */
  syncActive(options: HighlightOptions = {}): void {
    const range = this.activeRange
    if (!range) return
    for (let i = range.start; i <= range.end; i += 1) {
      this.sentences[i]?.spans.forEach((span) =>
        span.classList.add('tts-active'),
      )
    }
    if (options.scroll !== false) {
      this.scrollTo(range.start, options)
    }
  }

  clearActive(): void {
    const range = this.activeRange
    if (!range) return
    this.clearSpans(range)
    this.activeRange = null
  }

  scrollToActive(options: HighlightOptions = {}): void {
    if (this.activeRange) this.scrollTo(this.activeRange.start, options)
  }

  /**
   * Moves one viewport for swipe paging. Returns false when the requested
   * direction is already at the chapter edge, so the caller can switch
   * chapters instead.
   */
  pageBy(direction: 1 | -1, ratio = 0.9): boolean {
    const container = this.scrollContainer
    if (!container) return false

    const viewport = container.clientHeight
    if (viewport <= 0) return false

    const max = Math.max(0, container.scrollHeight - viewport)
    const current = container.scrollTop
    if (direction > 0) {
      if (current >= max - 4) return false
      container.scrollTo({
        top: Math.min(max, current + Math.max(viewport * ratio, 120)),
        behavior: 'smooth',
      })
      return true
    }

    if (current <= 4) return false
    container.scrollTo({
      top: Math.max(0, current - Math.max(viewport * ratio, 120)),
      behavior: 'smooth',
    })
    return true
  }

  private clearSpans(range: { start: number; end: number }): void {
    for (let i = range.start; i <= range.end; i += 1) {
      this.sentences[i]?.spans.forEach((span) =>
        span.classList.remove('tts-active'),
      )
    }
  }

  scrollTo(index: number, options: HighlightOptions = {}): void {
    const sentence = this.sentences[index]
    if (!sentence?.spans.length) return
    this.cancelScrollRetry()
    this.scrollRect(sentence.spans[0]!.getBoundingClientRect(), options)
  }

  scrollElement(element: Element, options: HighlightOptions = {}): void {
    this.cancelScrollRetry()
    this.scrollRect(element.getBoundingClientRect(), options)
  }

  private scrollRect(spanRect: DOMRect, options: HighlightOptions): void {
    const frame = this.doc.defaultView?.frameElement as HTMLElement | null
    const container = this.scrollContainer
    if (!frame || !container) return

    const frameRect = frame.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const innerScroll =
      (this.doc.scrollingElement as HTMLElement | null)?.scrollTop ??
      this.doc.documentElement.scrollTop ??
      0

    const topInset = options.topInset ?? 0
    const bottomInset = options.bottomInset ?? 0
    const viewportHeight = container.clientHeight - topInset - bottomInset
    if (viewportHeight <= 0) return

    const absoluteTop =
      frameRect.top - containerRect.top + container.scrollTop + innerScroll + spanRect.top
    const relativeTop = absoluteTop - container.scrollTop

    if (!options.forceScroll) {
      const comfortableTop = topInset + viewportHeight * 0.14
      const comfortableBottom = topInset + viewportHeight * 0.62
      if (relativeTop >= comfortableTop && relativeTop <= comfortableBottom) return
    }

    const desiredTarget = absoluteTop - topInset - viewportHeight * 0.38
    const maxScroll = container.scrollHeight - container.clientHeight
    const target = Math.max(0, Math.min(desiredTarget, maxScroll))

    // The stage is still growing right after a chapter render; realign once
    // the iframe reports its final height so restored progress stays visible.
    if (target <= 0 && desiredTarget > 2 && maxScroll <= 1) {
      this.scheduleScrollRetry(options)
    }

    if (options.behavior === 'auto') {
      this.cancelAnimation()
      container.scrollTop = target
      return
    }

    this.animateScroll(container, target)
  }

  destroy(): void {
    this.cancelAnimation()
    this.cancelScrollRetry()
    this.unwrap()
    this.sentences.length = 0
  }

  private scheduleScrollRetry(options: HighlightOptions): void {
    if (this.scrollRetryTimer !== null || this.scrollRetryCount >= 12) return
    this.scrollRetryCount += 1
    this.scrollRetryTimer = window.setTimeout(() => {
      this.scrollRetryTimer = null
      const range = this.activeRange
      if (!range) return
      const sentence = this.sentences[range.start]
      if (!sentence?.spans.length) return
      this.scrollRect(sentence.spans[0]!.getBoundingClientRect(), options)
    }, 90)
  }

  private cancelScrollRetry(): void {
    if (this.scrollRetryTimer !== null) {
      window.clearTimeout(this.scrollRetryTimer)
      this.scrollRetryTimer = null
    }
    this.scrollRetryCount = 0
  }

  private build(): void {
    const body = this.doc.body
    if (!body) return

    this.unwrap()
    this.injectStyles()

    const parts: string[] = []
    const chars: Array<CharRef | null> = []

    const appendBoundary = () => {
      parts.push('\n')
      chars.push(null)
    }

    const walk = (parent: Element) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const textNode = child as Text
          const data = textNode.data
          if (!data) continue
          // Source line breaks inside a paragraph are layout, not sentence
          // ends. Replace them in place so offsets still map to the original
          // text node and only real block boundaries stay hard breaks.
          const text = data.replace(/[\r\n\t]/g, ' ')
          parts.push(text)
          for (let offset = 0; offset < text.length; offset += 1) {
            chars.push({ node: textNode, offset })
          }
          continue
        }

        if (child.nodeType !== Node.ELEMENT_NODE) continue
        const element = child as Element
        if (shouldSkip(element)) continue

        const tag = element.tagName.toUpperCase()
        if (tag === 'BR') {
          appendBoundary()
          continue
        }

        walk(element)
        if (BLOCK_TAGS.has(tag)) appendBoundary()
      }
    }

    walk(body)
    appendBoundary()

    const combined = parts.join('')
    const ranges = splitSentences(combined)
    const fixtures: FragmentSlice[][] = []

    for (const range of ranges) {
      const speechText = normalizeSpeechText(range.text)
      if (!speechText) continue

      const slices: FragmentSlice[] = []
      const index = this.sentences.length
      const sid = `${this.spineIndex}-s${index}`

      for (let i = range.start; i < range.end; i += 1) {
        const ref = chars[i]
        if (!ref) continue
        const last = slices[slices.length - 1]
        if (last && last.node === ref.node && last.end === ref.offset) {
          last.end = ref.offset + 1
        } else {
          slices.push({
            node: ref.node,
            start: ref.offset,
            end: ref.offset + 1,
            sentenceIndex: index,
            sid,
          })
        }
      }

      if (!slices.length) continue

      this.sentences.push({
        index,
        sid,
        text: range.text,
        speechText,
        paragraphEnd: range.paragraphEnd,
        dialogue: range.dialogue,
        spans: [],
      })
      fixtures.push(slices)
    }

    const byNode = new Map<Text, FragmentSlice[]>()
    for (const slices of fixtures) {
      for (const slice of slices) {
        const list = byNode.get(slice.node)
        if (list) list.push(slice)
        else byNode.set(slice.node, [slice])
      }
    }

    for (const [node, slices] of byNode) {
      this.wrapNode(node, slices)
    }

    body.dataset.ttsWrapped = 'v1'
  }

  private wrapNode(node: Text, slices: FragmentSlice[]): void {
    const parent = node.parentNode
    if (!parent) return

    const raw = node.data
    const ordered = [...slices].sort((a, b) => a.start - b.start)
    const fragment = this.doc.createDocumentFragment()
    let cursor = 0

    for (const slice of ordered) {
      if (slice.start < cursor) continue
      if (slice.start > cursor) {
        fragment.appendChild(this.doc.createTextNode(raw.slice(cursor, slice.start)))
      }

      const span = this.doc.createElement('span')
      span.className = 'tts-sentence'
      span.dataset.sid = slice.sid
      span.dataset.sentenceIndex = String(slice.sentenceIndex)
      span.textContent = raw.slice(slice.start, slice.end)
      fragment.appendChild(span)

      this.sentences[slice.sentenceIndex]!.spans.push(span)
      cursor = slice.end
    }

    if (cursor < raw.length) {
      fragment.appendChild(this.doc.createTextNode(raw.slice(cursor)))
    }

    parent.replaceChild(fragment, node)
  }

  private unwrap(): void {
    const spans = Array.from(this.doc.querySelectorAll('span.tts-sentence'))
    if (!spans.length) return

    const parents = new Set<Node>()
    for (const span of spans) {
      const parent = span.parentNode
      if (!parent) continue
      parent.replaceChild(this.doc.createTextNode(span.textContent ?? ''), span)
      parents.add(parent)
    }
    parents.forEach((parent) => parent.normalize())

    if (this.doc.body) delete this.doc.body.dataset.ttsWrapped
  }

  private injectStyles(): void {
    const existing = this.doc.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (existing) {
      existing.textContent = HIGHLIGHT_CSS
      return
    }

    const style = this.doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = HIGHLIGHT_CSS
    const head = this.doc.head ?? this.doc.documentElement
    head.appendChild(style)
  }

  private animateScroll(container: HTMLElement, target: number): void {
    this.cancelAnimation()

    const win = this.doc.defaultView
    if (!win) {
      container.scrollTop = target
      return
    }

    const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)').matches
    const from = container.scrollTop
    const distance = target - from

    if (reducedMotion || Math.abs(distance) < 2) {
      container.scrollTop = target
      return
    }

    const startedAt = win.performance.now()
    const duration = 320

    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      container.scrollTop = from + distance * eased
      if (progress < 1) {
        this.animationFrame = win!.requestAnimationFrame(step)
      } else {
        this.animationFrame = null
      }
    }

    this.animationFrame = win!.requestAnimationFrame(step)
  }

  private cancelAnimation(): void {
    if (this.animationFrame !== null) {
      this.doc.defaultView?.cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }
  }
}
