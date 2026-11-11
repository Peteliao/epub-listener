import ePub, { type Book, type Contents, type NavItem, type Rendition } from 'epubjs'
import type { ChapterInfo, ReaderSettings } from '@/types'
import { DEFAULT_SETTINGS } from '@/types'
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
import { makeQueueBackgroundSafe } from './renditionQueue'

interface RawSection {
  index: number
  href: string
  linear?: boolean
  properties?: string[]
}

interface SpineSection extends RawSection {
  load?: (request?: unknown) => Promise<unknown>
  document?: Document
  unload?: () => void
}

interface SpineLike {
  each: (callback: (section: RawSection) => void) => void
}

interface ContentsLike {
  document: Document
}

interface PendingDisplay {
  epoch: number
  resolve: (value: ChapterRender) => void
  reject: (error: Error) => void
  timer: number
}

function abortError(): Error {
  const error = new Error('已取消。')
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

function normalizeHref(href: string): string {
  const withoutFragment = href.split('#')[0]!.split('?')[0]!.trim()
  return safeDecode(withoutFragment).replace(/^\.\//, '').replace(/^\/+/, '')
}

function resolveLinkPath(
  baseHref: string,
  targetHref: string,
): { path: string; anchor: string | null } | null {
  const hashIndex = targetHref.indexOf('#')
  const anchorRaw = hashIndex >= 0 ? targetHref.slice(hashIndex + 1) : ''
  const anchor = anchorRaw ? safeDecode(anchorRaw) : null
  const pathRaw = (hashIndex >= 0 ? targetHref.slice(0, hashIndex) : targetHref)
    .split('?')[0]!
    .trim()

  if (!pathRaw) return { path: normalizeHref(baseHref), anchor }

  try {
    const base = new URL(normalizeHref(baseHref), 'https://epub.local/')
    const resolved = new URL(pathRaw, base)
    return { path: normalizeHref(resolved.pathname), anchor }
  } catch {
    return null
  }
}

/**
 * Thin adapter around epub.js. Owns rendering, sentence wrapping and content
 * gestures; playback policy stays in the controller layer.
 */
export class EpubSession implements ReaderSession {
  chapters: ChapterInfo[] = []

  private readonly container: HTMLElement
  private readonly callbacks: SessionCallbacks
  private book: Book | null = null
  private rendition: Rendition | null = null
  private spineSections: SpineSection[] = []
  private highlighter: Highlighter | null = null
  private attachedDocument: Document | null = null
  private attachedChapterIndex = -1
  private activeChapterIndex = -1
  private styleSettings: ReaderSettings = { ...DEFAULT_SETTINGS }
  private chapterByHref = new Map<string, number>()
  private chapterBySpineIndex = new Map<number, number>()
  private displayEpoch = 0
  private pendingDisplay: PendingDisplay | null = null
  private reflowTimer: number | null = null
  private recoveryTimer: number | null = null
  private recoveryAttempts = 0
  private contentAbort: AbortController | null = null

  constructor(container: HTMLElement, callbacks: SessionCallbacks = {}) {
    this.container = container
    this.callbacks = callbacks
  }

  get currentChapter(): ChapterInfo | null {
    return this.chapters[this.activeChapterIndex] ?? null
  }

  get currentHighlighter(): Highlighter | null {
    return this.highlighter
  }

  async open(source: ArrayBuffer): Promise<OpenedBook> {
    if (this.book) throw new Error('书籍已经打开。')

    const book = ePub(source)
    this.book = book
    await book.opened

    const [metadata, navigation] = await Promise.all([
      book.loaded.metadata,
      book.loaded.navigation.catch(() => null),
    ])

    this.buildChapters(navigation?.toc ?? [])

    this.rendition = book.renderTo(this.container, {
      width: '100%',
      height: '100%',
      flow: 'scrolled-doc',
      manager: 'default',
      spread: 'none',
      allowScriptedContent: false,
    })
    makeQueueBackgroundSafe(this.rendition)
    this.rendition.on('rendered', this.handleRendered)
    this.rendition.on('resized', this.handleResized)
    this.rendition.on('displayerror', this.handleDisplayError)

    return {
      title: (metadata.title ?? '').trim(),
      author: (metadata.creator ?? '').trim(),
      chapters: this.chapters,
    }
  }

  setStyle(settings: ReaderSettings): void {
    this.styleSettings = { ...settings }
    if (this.attachedDocument) {
      applyReaderStyle(this.attachedDocument, this.styleSettings)
      this.scheduleReflow(30)
    }
  }

  async displayChapter(
    index: number,
    options: { anchor?: string | null } = {},
  ): Promise<ChapterRender> {
    const rendition = this.rendition
    const chapter = this.chapters[index]
    if (!rendition) throw new Error('阅读器还未准备好。')
    if (!chapter) throw new Error('这一章不存在。')

    this.cancelPendingDisplay()
    this.activeChapterIndex = index
    this.displayEpoch += 1
    const epoch = this.displayEpoch

    const wait = new Promise<ChapterRender>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pendingDisplay?.epoch !== epoch) return
        this.pendingDisplay = null
        reject(new Error('这一章加载超时，请重试。'))
      }, 15000)
      this.pendingDisplay = { epoch, resolve, reject, timer }
    })
    void wait.catch(() => undefined)

    const displayAttempt = rendition.display(chapter.href)
    void displayAttempt.catch(() => undefined)

    displayAttempt
      .then(() => {
        if (this.pendingDisplay?.epoch !== epoch) return
        const contents = this.getCurrentContents()
        if (contents) this.attachContents(index, contents)
      })
      .catch(() => {
        this.rejectPending(epoch, new Error('这一章加载失败，请重试。'))
      })

    const result = await wait
    if (options.anchor) {
      window.requestAnimationFrame(() => this.scrollToAnchor(options.anchor!))
    }
    return result
  }

  tapAt(clientX: number, clientY: number): void {
    const doc = this.attachedDocument
    const frame = doc?.defaultView?.frameElement as HTMLElement | null
    if (!doc || !frame) return

    const target = elementAtClientPoint(doc, frame, clientX, clientY)
    if (!target) {
      this.callbacks.onContentTap?.()
      return
    }

    const anchor = target.closest('a[href]')
    if (anchor) {
      this.handleAnchorClick(anchor)
      return
    }

    this.emitContentTap(target)
  }

  scrollToAnchor(anchor: string): boolean {
    const doc = this.attachedDocument
    if (!doc) return false

    const id = safeDecode(anchor.replace(/^#/, ''))
    const element = doc.getElementById(id)
    if (!element) return false

    if (this.highlighter) {
      this.highlighter.scrollElement(element, {
        behavior: 'smooth',
        forceScroll: true,
      })
    } else {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    return true
  }

  async collectPlainText(signal?: AbortSignal): Promise<string[]> {
    const book = this.book
    const chunks: string[] = []
    if (!book) return chunks

    for (const section of this.spineSections) {
      if (signal?.aborted) throw abortError()
      const hadDocument = Boolean(section.document)
      try {
        if (typeof section.load !== 'function') {
          chunks.push('')
        } else {
          await section.load(
            book.load.bind(book) as unknown as (request?: unknown) => Promise<unknown>,
          )
          chunks.push(section.document ? extractDocumentText(section.document) : '')
        }
      } catch {
        chunks.push('')
      } finally {
        // Never unload the section the rendition is currently showing.
        if (!hadDocument) section.unload?.()
      }
      await yieldToMain()
    }
    return chunks
  }

  async nextChapter(): Promise<ChapterRender> {
    if (this.activeChapterIndex >= this.chapters.length - 1) {
      throw new Error('已经是最后一章了。')
    }
    return this.displayChapter(this.activeChapterIndex + 1)
  }

  async previousChapter(): Promise<ChapterRender> {
    if (this.activeChapterIndex <= 0) {
      throw new Error('已经是第一章了。')
    }
    return this.displayChapter(this.activeChapterIndex - 1)
  }

  destroy(): void {
    this.cancelPendingDisplay()
    if (this.reflowTimer !== null) {
      window.clearTimeout(this.reflowTimer)
      this.reflowTimer = null
    }
    this.cancelResizeRecovery()
    this.teardownContent()

    try {
      this.rendition?.destroy()
    } catch {
      // A partially rendered book may already have released its views.
    }
    try {
      this.book?.destroy()
    } catch {
      // Best-effort cleanup during navigation away.
    }

    this.rendition = null
    this.book = null
    this.spineSections = []
    this.chapters = []
  }

  private buildChapters(toc: NavItem[]): void {
    const spine = this.book?.spine as unknown as SpineLike | undefined
    if (!spine) {
      this.chapters = []
      return
    }

    const collect = (linearOnly: boolean): RawSection[] => {
      const sections: RawSection[] = []
      spine.each((section) => {
        if (!section.href) return
        if (linearOnly && section.linear === false) return
        sections.push(section)
      })
      return sections
    }

    let sections = collect(true)
    if (!sections.length) sections = collect(false)
    this.spineSections = sections as SpineSection[]

    const labels = new Map<string, string>()
    const visitToc = (items: NavItem[]): void => {
      for (const item of items) {
        const label = cleanLabel(item.label ?? '')
        const key = normalizeHref(item.href ?? '')
        if (label && key && !labels.has(key)) labels.set(key, label)
        if (item.subitems?.length) visitToc(item.subitems)
      }
    }
    visitToc(toc)

    this.chapterByHref.clear()
    this.chapterBySpineIndex.clear()

    this.chapters = sections.map((section, index) => {
      const href = section.href
      const normalized = normalizeHref(href)
      const isCover =
        /cover|titlepage|title-page/i.test(href) ||
        section.properties?.some((property) => property.includes('cover')) === true
      const label = labels.get(normalized) ?? (isCover ? '封面' : `第 ${index + 1} 章`)

      this.chapterByHref.set(normalized, index)
      this.chapterBySpineIndex.set(section.index, index)

      return { index, href, label }
    })
  }

  private chapterIndexForSection(section: { index?: number; href?: string }): number | null {
    if (typeof section.index === 'number') {
      const bySpine = this.chapterBySpineIndex.get(section.index)
      if (bySpine !== undefined) return bySpine
    }
    if (section.href) {
      const byHref = this.chapterByHref.get(normalizeHref(section.href))
      if (byHref !== undefined) return byHref
    }
    return null
  }

  private handleRendered = (section: unknown, view: unknown): void => {
    const rawSection = section as { index?: number; href?: string }
    const chapterIndex = this.chapterIndexForSection(rawSection)
    if (chapterIndex === null || chapterIndex !== this.activeChapterIndex) return

    const viewRecord = view as { contents?: ContentsLike }
    const contents =
      viewRecord.contents?.document != null ? viewRecord.contents : this.getCurrentContents()
    if (!contents) return

    this.attachContents(chapterIndex, contents)
  }

  private handleResized = (): void => {
    this.scheduleReflow(150)
    this.recoveryAttempts = 0
    this.scheduleResizeRecovery()
  }

  /**
   * epub.js clears the current view on every size change and re-displays it
   * from `rendition.location`, which is still unset right after opening a
   * chapter or when resize events race a render. The chapter then stays
   * blank with no error, so re-display it ourselves when nothing came back.
   */
  private scheduleResizeRecovery(): void {
    this.cancelResizeRecovery()
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null
      if (!this.rendition) return
      if (this.getCurrentContents()) {
        this.recoveryAttempts = 0
        return
      }
      if (this.pendingDisplay || this.isRenditionDisplaying()) {
        if (this.recoveryAttempts < 3) {
          this.recoveryAttempts += 1
          this.scheduleResizeRecovery()
        }
        return
      }
      const chapter = this.chapters[this.activeChapterIndex]
      if (!chapter) return
      this.recoveryAttempts = 0
      void this.displayChapter(this.activeChapterIndex)
        .then(() => this.callbacks.onReflow?.())
        .catch(() => {
          this.callbacks.onError?.('窗口调整后正文没有恢复，请返回书架重新进入。')
        })
    }, 350)
  }

  private cancelResizeRecovery(): void {
    if (this.recoveryTimer === null) return
    window.clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }

  private isRenditionDisplaying(): boolean {
    const rendition = this.rendition as unknown as { displaying?: unknown } | null
    return Boolean(rendition?.displaying)
  }

  private handleDisplayError = (): void => {
    if (this.pendingDisplay) {
      const epoch = this.pendingDisplay.epoch
      this.rejectPending(epoch, new Error('这一章加载失败，请重试。'))
    } else {
      this.callbacks.onError?.('页面渲染出错了，请重试。')
    }
  }

  private attachContents(chapterIndex: number, contents: ContentsLike): ChapterRender {
    const chapter = this.chapters[chapterIndex]
    if (!chapter) throw new Error('这一章不存在。')

    if (
      this.highlighter &&
      this.attachedDocument === contents.document &&
      this.attachedChapterIndex === chapterIndex
    ) {
      const result = { chapter, highlighter: this.highlighter }
      this.resolvePending(chapterIndex, result)
      return result
    }

    this.teardownContent()
    this.attachedChapterIndex = chapterIndex
    this.attachedDocument = contents.document

    injectContentPolicy(contents.document)
    applyReaderStyle(contents.document, this.styleSettings)

    const highlighter = new Highlighter(contents.document, chapterIndex)
    this.highlighter = highlighter
    this.bindContentEvents(contents.document)

    const result = { chapter, highlighter }
    this.callbacks.onContentReady?.(result)
    this.resolvePending(chapterIndex, result)
    return result
  }

  private getCurrentContents(): ContentsLike | null {
    if (!this.rendition) return null
    const raw = this.rendition.getContents() as unknown as Contents | Contents[] | null
    const contents = Array.isArray(raw) ? raw[0] : raw
    if (!contents || !(contents as ContentsLike).document) return null
    return contents as ContentsLike
  }

  private resolvePending(chapterIndex: number, result: ChapterRender): void {
    const pending = this.pendingDisplay
    if (!pending || this.activeChapterIndex !== chapterIndex) return
    window.clearTimeout(pending.timer)
    this.pendingDisplay = null
    pending.resolve(result)
  }

  private rejectPending(epoch: number, error: Error): void {
    const pending = this.pendingDisplay
    if (!pending || pending.epoch !== epoch) return
    window.clearTimeout(pending.timer)
    this.pendingDisplay = null
    pending.reject(error)
  }

  private cancelPendingDisplay(): void {
    const pending = this.pendingDisplay
    if (!pending) return
    window.clearTimeout(pending.timer)
    this.pendingDisplay = null
    const error = new Error('章节切换已取消。')
    error.name = 'AbortError'
    pending.reject(error)
  }

  private teardownContent(): void {
    this.contentAbort?.abort()
    this.contentAbort = null
    this.highlighter?.destroy()
    this.highlighter = null
    this.attachedDocument = null
    this.attachedChapterIndex = -1
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
          this.handleAnchorClick(anchor)
          pointerStart = null
          return
        }

        if (pointerStart) {
          const moved = Math.hypot(mouse.clientX - pointerStart.x, mouse.clientY - pointerStart.y)
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

  private handleAnchorClick(anchor: Element): void {
    const href = anchor.getAttribute('href')?.trim()
    if (!href) return

    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase()
    if (scheme) {
      if (!['http', 'https', 'mailto', 'tel'].includes(scheme)) return
      this.callbacks.onExternalLink?.(href)
      return
    }

    if (href.startsWith('//')) {
      this.callbacks.onExternalLink?.(`https:${href}`)
      return
    }

    if (href.startsWith('#')) {
      this.scrollToAnchor(href.slice(1))
      return
    }

    const current = this.chapters[this.attachedChapterIndex]
    if (!current) return

    const resolved = resolveLinkPath(current.href, href)
    if (!resolved) {
      this.callbacks.onError?.('这个链接无法打开。')
      return
    }

    if (resolved.path === normalizeHref(current.href)) {
      if (resolved.anchor) this.scrollToAnchor(resolved.anchor)
      return
    }

    const chapterIndex = this.chapterByHref.get(resolved.path)
    if (chapterIndex === undefined) {
      this.callbacks.onError?.('这个链接指向的内容不在本书中。')
      return
    }

    this.callbacks.onLinkNavigate?.(chapterIndex, resolved.anchor)
  }

  private scheduleReflow(delay: number): void {
    if (this.reflowTimer !== null) window.clearTimeout(this.reflowTimer)
    this.reflowTimer = window.setTimeout(() => {
      this.reflowTimer = null
      this.highlighter?.syncActive({ scroll: false })
      this.callbacks.onReflow?.()
    }, delay)
  }
}
