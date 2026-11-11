import type { ChapterInfo, ReaderSettings, StoredBook } from '@/types'
import { DEFAULT_SETTINGS, getBookFormat } from '@/types'
import { Highlighter } from './Highlighter'
import {
  cleanLabel,
  type ChapterRender,
  type OpenedBook,
  type ReaderSession,
  type SessionCallbacks,
} from './ReaderSession'
import { applyReaderStyle, injectContentPolicy } from './readerStyle'
import { extractDocumentText, yieldToMain } from './plainText'
import { bindSwipeNavigation } from './contentSwipe'
import { bindContentTaps } from './contentTap'
import { elementAtClientPoint } from './stageTap'
import { buildFb2Book, buildMobiBook, foliateAuthors, foliateTitle } from './formats/foliateBook'
import type { FoliateBookLike, FoliateResolvedTarget, FoliateSection, FoliateTocItem } from './formats/types'
import { buildTextBook } from './formats/textBook'

const LOAD_TIMEOUT = 15000

const FLOW_STYLE =
  'position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;'

const FRAME_STYLE =
  'display:block;width:100%;border:0;background:transparent;height:100%;opacity:0;'

interface PendingLoad {
  epoch: number
  resolve: (value: ChapterRender) => void
  reject: (error: Error) => void
  timer: number
}

function abortError(): Error {
  const error = new Error('章节加载已取消。')
  error.name = 'AbortError'
  return error
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function elementForRange(range: Range): Element | null {
  const start = range.startContainer
  if (start.nodeType === Node.ELEMENT_NODE) return start as Element
  return start.parentElement
}

/**
 * Renders FB2 / MOBI / TXT sections, whose text is already self-contained
 * XHTML, in a script-blocked iframe and reuses the EPUB highlighter. The outer
 * scroller is what Highlighter discovers, so sentence auto-scroll matches the
 * EPUB scrolled-doc behaviour.
 */
export class FlowSession implements ReaderSession {
  chapters: ChapterInfo[] = []

  private readonly record: StoredBook
  private readonly container: HTMLElement
  private readonly callbacks: SessionCallbacks
  private book: FoliateBookLike | null = null
  private flow: HTMLDivElement | null = null
  private frame: HTMLIFrameElement | null = null
  private frameDoc: Document | null = null
  private highlighter: Highlighter | null = null
  private sections: FoliateSection[] = []
  private sectionToChapter = new Map<number, number>()
  private styleSettings: ReaderSettings = { ...DEFAULT_SETTINGS }
  private activeChapterIndex = -1
  private epoch = 0
  private pending: PendingLoad | null = null
  private contentAbort: AbortController | null = null
  private resizeObserver: ResizeObserver | null = null
  private measureTimer: number | null = null
  private removeImageListener: (() => void) | null = null

  constructor(
    record: StoredBook,
    container: HTMLElement,
    callbacks: SessionCallbacks = {},
  ) {
    this.record = record
    this.container = container
    this.callbacks = callbacks
  }

  get currentHighlighter(): Highlighter | null {
    return this.highlighter
  }

  async open(source: ArrayBuffer): Promise<OpenedBook> {
    if (this.book) throw new Error('书籍已经打开。')

    const format = getBookFormat(this.record)
    try {
      this.book =
        format === 'fb2'
          ? await buildFb2Book(source)
          : format === 'txt'
            ? buildTextBook(source, this.record.title)
            : await buildMobiBook(source)
      await this.buildChapters(this.book)
    } catch (error) {
      this.book?.destroy?.()
      this.book = null
      throw error
    }

    if (!this.chapters.length) {
      this.book.destroy?.()
      this.book = null
      throw new Error('这本书里没有可阅读的章节。')
    }

    return {
      title: foliateTitle(this.book) || this.record.title,
      author: foliateAuthors(this.book),
      chapters: this.chapters,
    }
  }

  setStyle(settings: ReaderSettings): void {
    this.styleSettings = { ...settings }
    if (!this.frameDoc) return
    applyReaderStyle(this.frameDoc, this.styleSettings)
    window.requestAnimationFrame(() => {
      this.measureHeight()
      this.callbacks.onReflow?.()
    })
  }

  async displayChapter(
    index: number,
    options: { anchor?: string | null } = {},
  ): Promise<ChapterRender> {
    if (!this.book) throw new Error('阅读器还未准备好。')
    const chapter = this.chapters[index]
    if (!chapter) throw new Error('这一章不存在。')

    this.cancelPending()
    this.teardownFrame()
    this.activeChapterIndex = index
    this.epoch += 1
    const epoch = this.epoch

    const wait = new Promise<ChapterRender>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pending?.epoch !== epoch) return
        this.pending = null
        reject(new Error('这一章加载超时，请重试。'))
      }, LOAD_TIMEOUT)
      this.pending = { epoch, resolve, reject, timer }
    })
    void wait.catch(() => undefined)

    try {
      const section = this.sections[index]
      if (!section) throw new Error('这一章不存在。')
      const url = await section.load()
      if (this.epoch !== epoch) throw abortError()
      if (this.pending?.epoch !== epoch) return wait

      const flow = document.createElement('div')
      flow.style.cssText = FLOW_STYLE
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-same-origin')
      frame.setAttribute('scrolling', 'no')
      frame.setAttribute('title', chapter.label)
      frame.style.cssText = FRAME_STYLE
      frame.addEventListener('load', () => {
        if (this.frame !== frame) return
        const doc = frame.contentDocument
        // Inserting an iframe fires an initial blank load that must not
        // consume the real chapter navigation.
        if (!doc || doc.URL === 'about:blank') return
        this.handleFrameLoad(epoch, index, options.anchor ?? null)
      })
      flow.appendChild(frame)
      this.flow = flow
      this.frame = frame
      this.container.appendChild(flow)
      frame.src = url
    } catch (error) {
      const next = error instanceof Error ? error : new Error('这一章加载失败，请重试。')
      this.rejectPending(epoch, next)
      throw next
    }

    return wait
  }

  tapAt(clientX: number, clientY: number): void {
    const doc = this.frameDoc
    const frame = this.frame
    if (!doc || !frame) return

    const target = elementAtClientPoint(doc, frame, clientX, clientY)
    if (!target) {
      this.callbacks.onContentTap?.()
      return
    }

    const anchor = target.closest('a[href]')
    if (anchor) {
      void this.handleAnchorClick(anchor)
      return
    }

    this.emitContentTap(target)
  }

  scrollToAnchor(anchor: string): boolean {
    if (!this.frameDoc || !this.book) return false
    void this.applyAnchor(anchor, 'smooth')
    return true
  }

  async collectPlainText(signal?: AbortSignal): Promise<string[]> {
    const chunks: string[] = []
    for (const section of this.sections) {
      if (signal?.aborted) throw abortError()
      try {
        const doc =
          typeof section.createDocument === 'function'
            ? await section.createDocument()
            : null
        chunks.push(doc ? extractDocumentText(doc) : '')
      } catch {
        chunks.push('')
      }
      await yieldToMain()
    }
    return chunks
  }

  destroy(): void {
    this.epoch += 1
    this.cancelPending()
    this.teardownFrame()
    this.book?.destroy?.()
    this.book = null
    this.sections = []
    this.chapters = []
    this.activeChapterIndex = -1
  }

  private async buildChapters(book: FoliateBookLike): Promise<void> {
    const usable: FoliateSection[] = []
    book.sections.forEach((section, sectionIndex) => {
      if (typeof section.load !== 'function') return
      if (section.linear === 'no') return
      this.sectionToChapter.set(sectionIndex, usable.length)
      usable.push(section)
    })

    const labels = new Map<number, string>()
    const visit = async (items: FoliateTocItem[]): Promise<void> => {
      for (const item of items) {
        const href = item.href?.trim()
        const label = item.label?.trim()
        if (href && label) {
          try {
            const parts = await book.splitTOCHref?.(href)
            const sectionIndex = Number(parts?.[0])
            const chapterIndex = this.sectionToChapter.get(sectionIndex)
            if (chapterIndex !== undefined && !labels.has(chapterIndex)) {
              labels.set(chapterIndex, cleanLabel(label))
            }
          } catch {
            // TOC entries outside the readable sections are ignored.
          }
        }
        if (item.subitems?.length) await visit(item.subitems)
      }
    }
    await visit(book.toc ?? [])

    this.sections = usable
    this.chapters = usable.map((section, index) => ({
      index,
      href: String(section.id),
      label: labels.get(index) ?? `第 ${index + 1} 节`,
    }))
  }

  private handleFrameLoad(
    epoch: number,
    index: number,
    anchor: string | null,
  ): void {
    const pending = this.pending
    if (!pending || pending.epoch !== epoch) return

    const frame = this.frame
    const doc = frame?.contentDocument
    if (!frame || !doc?.body) {
      this.rejectPending(epoch, new Error('这一章加载失败，请重试。'))
      return
    }

    this.frameDoc = doc
    injectContentPolicy(doc)
    applyReaderStyle(doc, this.styleSettings)

    const highlighter = new Highlighter(doc, index)
    this.highlighter = highlighter
    this.bindContentEvents(doc)
    this.observeContent(doc)
    this.measureHeight()
    frame.style.opacity = '1'

    if (anchor) {
      window.requestAnimationFrame(() => {
        void this.applyAnchor(anchor, 'auto')
      })
    }

    const chapter = this.chapters[index]
    if (!chapter) return
    const result = { chapter, highlighter }
    this.callbacks.onContentReady?.(result)
    this.resolvePending(index, result)
  }

  private observeContent(doc: Document): void {
    const onResourceLoad = () => this.scheduleMeasure()
    doc.addEventListener('load', onResourceLoad, true)
    this.removeImageListener = () => doc.removeEventListener('load', onResourceLoad, true)

    void doc.fonts?.ready.then(() => this.scheduleMeasure()).catch(() => undefined)

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleMeasure())
      this.resizeObserver.observe(doc.body)
    }
  }

  private measureHeight(): void {
    const doc = this.frameDoc
    const frame = this.frame
    if (!doc?.body || !frame) return
    const height = Math.max(
      1,
      Math.ceil(doc.body.scrollHeight),
      Math.ceil(doc.body.getBoundingClientRect().height),
    )
    const next = `${height}px`
    if (frame.style.height !== next) frame.style.height = next
  }

  private scheduleMeasure(): void {
    if (this.measureTimer !== null) return
    this.measureTimer = window.setTimeout(() => {
      this.measureTimer = null
      this.measureHeight()
    }, 60)
  }

  private bindContentEvents(doc: Document): void {
    this.contentAbort?.abort()
    const controller = new AbortController()
    this.contentAbort = controller

    bindSwipeNavigation(
      doc,
      (direction) => this.callbacks.onPageSwipe?.(direction),
      controller.signal,
    )

    let pointerStart: { x: number; y: number; time: number } | null = null
    let touchTapAt = 0

    bindContentTaps(
      doc,
      (target) => {
        touchTapAt = Date.now()
        this.emitContentTap(target)
      },
      controller.signal,
    )

    doc.addEventListener(
      'pointerdown',
      (event) => {
        const pointer = event as PointerEvent
        pointerStart = { x: pointer.clientX, y: pointer.clientY, time: Date.now() }
      },
      { capture: true, signal: controller.signal },
    )

    doc.addEventListener(
      'click',
      (event) => {
        const mouse = event as MouseEvent
        const target = mouse.target as Element | null
        if (!target) return
        // Ignore the synthetic click that follows a touch tap.
        if (Date.now() - touchTapAt < 600) return

        const anchor = target.closest('a[href]')
        if (anchor) {
          mouse.preventDefault()
          mouse.stopPropagation()
          pointerStart = null
          void this.handleAnchorClick(anchor)
          return
        }

        if (pointerStart) {
          const moved = Math.hypot(
            mouse.clientX - pointerStart.x,
            mouse.clientY - pointerStart.y,
          )
          const elapsed = Date.now() - pointerStart.time
          pointerStart = null
          if (moved > 10 || elapsed > 700) return
        }

        const selection = doc.getSelection()
        if (selection && !selection.isCollapsed && selection.toString().trim()) return

        this.emitContentTap(target)
      },
      { capture: true, signal: controller.signal },
    )
  }

  private emitContentTap(target: Element): void {
    this.callbacks.onContentTap?.()
    const sentenceElement = target.closest('[data-sentence-index]')
    if (!sentenceElement) return

    const index = Number((sentenceElement as HTMLElement).dataset.sentenceIndex)
    if (Number.isInteger(index)) this.callbacks.onSentenceTap?.(index)
  }

  private async handleAnchorClick(anchor: Element): Promise<void> {
    const href = anchor.getAttribute('href')?.trim()
    if (!href) return

    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      this.callbacks.onExternalLink?.(href)
      return
    }
    if (href.startsWith('//')) {
      this.callbacks.onExternalLink?.(`https:${href}`)
      return
    }

    if (href.startsWith('#')) {
      const id = safeDecode(href.slice(1))
      const element = this.frameDoc?.getElementById(id)
      if (element) {
        this.scrollTarget(element, 'smooth')
        return
      }
    }

    const resolved = await this.resolveTarget(href)
    if (!resolved) {
      if (this.book?.isExternal?.(href)) {
        this.callbacks.onExternalLink?.(href)
        return
      }
      this.callbacks.onError?.('这个链接无法打开。')
      return
    }

    const chapterIndex = this.sectionToChapter.get(resolved.index)
    if (chapterIndex === undefined) {
      this.callbacks.onError?.('这个链接指向的内容不在本书中。')
      return
    }

    const doc = this.frameDoc
    if (chapterIndex === this.activeChapterIndex && doc) {
      const target = resolved.anchor(doc)
      if (!target) {
        this.callbacks.onError?.('这个链接指向的内容不在本书中。')
        return
      }
      this.scrollTarget(target, 'smooth')
      return
    }

    this.callbacks.onLinkNavigate?.(chapterIndex, href)
  }

  private async applyAnchor(anchor: string, behavior: ScrollBehavior): Promise<void> {
    const doc = this.frameDoc
    if (!doc) return

    if (anchor.startsWith('#')) {
      const element = doc.getElementById(safeDecode(anchor.slice(1)))
      if (element) {
        this.scrollTarget(element, behavior)
        return
      }
    }

    const resolved = await this.resolveTarget(anchor)
    if (!resolved || this.frameDoc !== doc) return
    if (this.sectionToChapter.get(resolved.index) !== this.activeChapterIndex) return
    const target = resolved.anchor(doc)
    if (target) this.scrollTarget(target, behavior)
  }

  private async resolveTarget(href: string): Promise<FoliateResolvedTarget | null> {
    try {
      return (await this.book?.resolveHref(href)) ?? null
    } catch {
      return null
    }
  }

  private scrollTarget(target: Element | Range, behavior: ScrollBehavior): void {
    const element = target instanceof Element ? target : elementForRange(target)
    if (!element) return
    this.highlighter?.scrollElement(element, {
      behavior,
      forceScroll: true,
      topInset: 8,
    })
  }

  private resolvePending(index: number, result: ChapterRender): void {
    const pending = this.pending
    if (!pending || this.activeChapterIndex !== index) return
    window.clearTimeout(pending.timer)
    this.pending = null
    pending.resolve(result)
  }

  private rejectPending(epoch: number, error: Error): void {
    const pending = this.pending
    if (!pending || pending.epoch !== epoch) return
    window.clearTimeout(pending.timer)
    this.pending = null
    pending.reject(error)
  }

  private cancelPending(): void {
    const pending = this.pending
    if (!pending) return
    window.clearTimeout(pending.timer)
    this.pending = null
    pending.reject(abortError())
  }

  private teardownFrame(): void {
    this.contentAbort?.abort()
    this.contentAbort = null
    this.removeImageListener?.()
    this.removeImageListener = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.measureTimer !== null) {
      window.clearTimeout(this.measureTimer)
      this.measureTimer = null
    }
    this.highlighter?.destroy()
    this.highlighter = null
    this.frameDoc = null
    this.frame = null
    this.flow?.remove()
    this.flow = null
  }
}
