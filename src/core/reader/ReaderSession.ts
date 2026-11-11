import type { ChapterInfo, ReaderSettings } from '@/types'
import type { Highlighter } from './Highlighter'

export interface ChapterRender {
  chapter: ChapterInfo
  highlighter: Highlighter
}

export interface OpenedBook {
  title: string
  author: string
  chapters: ChapterInfo[]
}

export interface SessionCallbacks {
  onContentReady?: (result: ChapterRender) => void
  onSentenceTap?: (sentenceIndex: number) => void
  onContentTap?: () => void
  onPageSwipe?: (direction: 'next' | 'previous') => void
  onLinkNavigate?: (chapterIndex: number, anchor: string | null) => void
  onExternalLink?: (url: string) => void
  onError?: (message: string) => void
  onReflow?: () => void
}

/**
 * One open book's rendering surface. `anchor` is opaque to callers: EPUB uses
 * element ids, foliate/TXT use the format's own href tokens.
 */
export interface ReaderSession {
  chapters: ChapterInfo[]
  readonly currentHighlighter: Highlighter | null
  open(source: ArrayBuffer): Promise<OpenedBook>
  setStyle(settings: ReaderSettings): void
  displayChapter(
    index: number,
    options?: { anchor?: string | null },
  ): Promise<ChapterRender>
  scrollToAnchor(anchor: string): boolean
  /** Dispatches a stage tap given in page coordinates to the rendered text. */
  tapAt(clientX: number, clientY: number): void
  /** Plain text per chapter, used by the per-book pronunciation pass. */
  collectPlainText(signal?: AbortSignal): Promise<string[]>
  destroy(): void
}

export function cleanLabel(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
