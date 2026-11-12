import { getBookLexicon, saveBookLexicon, type StoredBookLexicon } from '@/core/db/LibraryDB'
import type { AiLexiconAssets, AiModelManager } from './AiModel'
import {
  BOOK_LEXICON_VERSION,
  type BookLexiconResponse,
} from './bookLexicon'
import curatedOverlay from './polyphones.v1.txt?raw'
import { mergeOverlaySources } from './pinyinTones'
import { mergeRubyOverlays } from '@/core/reader/rubyAnnotations'
import type { BookTextData } from '@/core/reader/ReaderSession'
import phraseReadings from './phraseReadings.v1.txt?raw'
import {
  APPROVED_OVERRIDES,
  APPROVED_OVERRIDES_HASH,
} from './approvedOverrides.v1'

export type BookLexiconPhase =
  | 'idle'
  | 'disabled'
  | 'generating'
  | 'ready'
  | 'error'

export interface BookLexiconStatus {
  phase: BookLexiconPhase
  entries: number
  message: string | null
}

export interface BookLexiconReportInfo {
  curatedHash: string
  version: number
  enabled: boolean
  entries: number
}

type CollectText = (signal: AbortSignal) => Promise<BookTextData>

const curatedHash = hashText(curatedOverlay)
/** Fingerprint of the compiled MIT phrase asset; part of the scan cache key. */
const phraseHash = hashText(phraseReadings)

function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function assetKey(assets: AiLexiconAssets): string {
  return [
    assets.cacheName,
    assets.lexiconName,
    assets.packVersion,
    curatedHash,
    APPROVED_OVERRIDES_HASH,
    phraseHash,
    BOOK_LEXICON_VERSION,
  ].join('|')
}

export class BookLexiconService {
  private readonly ai: AiModelManager
  private readonly bookId: string
  private readonly listeners = new Set<(status: BookLexiconStatus) => void>()
  private status: BookLexiconStatus = {
    phase: 'idle',
    entries: 0,
    message: null,
  }
  /** Overlay produced by the whole-book scan (this is what IndexedDB caches). */
  private baseOverlay = ''
  /** Book-specific ruby annotations; never written to the scan cache. */
  private rubyOverlay = ''
  /** In-memory live corrections; never written to the scan cache. */
  private liveOverlay = ''
  private liveHash = ''
  private overlay = ''
  private enabled = true
  private disposed = false
  private pipeline: Promise<string> | null = null
  private runKey = ''
  private worker: Worker | null = null
  private jobId = 0
  private abort: AbortController | null = null

  constructor(ai: AiModelManager, bookId: string) {
    this.ai = ai
    this.bookId = bookId
  }

  getStatus(): BookLexiconStatus {
    return { ...this.status }
  }

  getOverlay(): string {
    return this.enabled ? this.overlay : ''
  }

  /**
   * Applies runtime listening corrections. The whole-book scan is expensive and
   * its result is independent of feedback, so only the in-memory composed
   * overlay changes — no full re-scan and no cache rewrite. Returns false when
   * the fingerprint is unchanged, which makes the caller's debounce idempotent.
   */
  setLiveOverlay(overlay: string, hash: string): boolean {
    if (this.disposed || (this.liveOverlay === overlay && this.liveHash === hash)) {
      return false
    }
    this.liveOverlay = overlay
    this.liveHash = hash
    this.recompose()
    if (this.enabled) {
      this.setStatus({
        phase: 'ready',
        entries: countEntries(this.overlay),
        message: null,
      })
    }
    return true
  }

  /** Forces the next start() to recompute; keeps the current overlay usable. */
  invalidate(): void {
    this.runKey = ''
  }

  getReportInfo(): BookLexiconReportInfo {
    return {
      curatedHash,
      version: BOOK_LEXICON_VERSION,
      enabled: this.enabled,
      entries: this.status.entries,
    }
  }

  subscribe(listener: (status: BookLexiconStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.cancel()
      this.setStatus({ phase: 'disabled', entries: 0, message: null })
    } else if (this.status.phase === 'disabled') {
      this.setStatus({ phase: 'idle', entries: 0, message: null })
    }
  }

  start(voiceId: string, collect: CollectText): void {
    if (!this.enabled || this.disposed || this.pipeline) return
    const pipeline = this.run(voiceId, collect).catch(() => {
      this.baseOverlay = ''
      this.recompose()
      return this.overlay
    })
    this.pipeline = pipeline
    void pipeline.finally(() => {
      if (this.pipeline === pipeline) this.pipeline = null
    })
  }

  /**
   * Fixed priority chain (later wins, curated is appended by AiModel):
   * static MIT phrase readings < whole-book scan < ruby annotations < live
   * feedback < hand-curated table.
   */
  private recompose(): void {
    this.overlay = mergeOverlaySources(
      this.baseOverlay,
      this.rubyOverlay,
      this.liveOverlay,
    )
  }

  async waitForOverlay(timeoutMs: number): Promise<string> {
    if (!this.enabled) return ''
    const pipeline = this.pipeline
    if (!pipeline) return this.overlay

    let timer: number | null = null
    const timeout = new Promise<string>((resolve) => {
      timer = window.setTimeout(() => resolve(''), timeoutMs)
    })
    const overlay = await Promise.race([pipeline, timeout])
    if (timer !== null) window.clearTimeout(timer)
    return this.enabled ? overlay : ''
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.listeners.clear()
    this.pipeline = null
    this.baseOverlay = ''
    this.rubyOverlay = ''
    this.liveOverlay = ''
    this.overlay = ''
  }

  private async run(voiceId: string, collect: CollectText): Promise<string> {
    const assets = await this.ai.getLexiconAssets(voiceId)
    if (this.disposed || !this.enabled) return ''
    if (!assets) {
      this.setStatus({ phase: 'idle', entries: 0, message: null })
      return ''
    }

    const key = assetKey(assets)
    if (this.runKey === key) {
      this.recompose()
      this.setStatus({
        phase: 'ready',
        entries: countEntries(this.overlay),
        message: null,
      })
      return this.overlay
    }
    this.runKey = key
    this.baseOverlay = ''
    this.rubyOverlay = ''
    this.recompose()

    this.setStatus({ phase: 'generating', entries: 0, message: null })
    const controller = new AbortController()
    this.abort = controller
    try {
      // ONE book traversal yields both plain text and ruby annotations, even
      // when the generated overlay comes from a cache hit. Ruby notes are
      // book-specific, so they must never be served from the scan cache.
      const data = await collect(controller.signal)
      if (this.disposed || !this.enabled) return this.overlay
      const chunks = Array.isArray(data?.chunks) ? data.chunks : []
      this.rubyOverlay = mergeRubyOverlays(data?.rubyOverlays ?? [])

      const cached = await this.readCache(assets, key)
      if (this.disposed || !this.enabled) return this.overlay
      let scanned = cached?.overlay ?? ''
      if (!cached && chunks.some((chunk) => chunk.trim())) {
        scanned = await this.generate(assets, chunks, controller)
      }
      if (this.disposed) return this.overlay
      // Static MIT phrase readings sit below the whole-book scan; the cache
      // only stores the scan result, so both are composed here.
      this.baseOverlay = mergeOverlaySources(phraseReadings, scanned)
      this.recompose()
      this.setStatus({ phase: 'ready', entries: countEntries(this.overlay), message: null })
      if (!cached && scanned) {
        const record: StoredBookLexicon = {
          bookId: this.bookId,
          overlay: scanned,
          entries: countEntries(scanned),
          version: BOOK_LEXICON_VERSION,
          packId: assets.packId,
          packVersion: assets.packVersion,
          lexiconName: assets.lexiconName,
          curatedHash,
          approvedHash: APPROVED_OVERRIDES_HASH,
          createdAt: Date.now(),
        }
        void saveBookLexicon(record).catch(() => undefined)
      }
      return this.overlay
    } catch (error) {
      if (!this.disposed && this.enabled) {
        this.setStatus({
          phase: 'error',
          entries: 0,
          message:
            error instanceof Error ? error.message : '本书读音生成失败。',
        })
      }
      return this.overlay
    } finally {
      if (this.abort === controller) this.abort = null
    }
  }

  private async readCache(
    assets: AiLexiconAssets,
    key: string,
  ): Promise<StoredBookLexicon | null> {
    try {
      const cached = await getBookLexicon(this.bookId)
      if (
        !cached ||
        cached.version !== BOOK_LEXICON_VERSION ||
        cached.packId !== assets.packId ||
        cached.packVersion !== assets.packVersion ||
        cached.lexiconName !== assets.lexiconName ||
        cached.curatedHash !== curatedHash ||
        cached.approvedHash !== APPROVED_OVERRIDES_HASH ||
        typeof cached.overlay !== 'string' ||
        !Number.isFinite(cached.entries) ||
        assetKey(assets) !== key
      ) {
        return null
      }
      return cached
    } catch {
      return null
    }
  }

  /** Runs the per-book scan worker over already-collected chapter text. */
  private generate(
    assets: AiLexiconAssets,
    chunks: string[],
    controller: AbortController,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let worker: Worker
      try {
        worker = new Worker(new URL('./bookLexicon.worker.ts', import.meta.url), {
          type: 'module',
        })
      } catch {
        reject(new Error('当前浏览器无法启动读音生成线程。'))
        return
      }

      this.worker = worker
      const jobId = (this.jobId += 1)

      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        worker.terminate()
        if (this.worker === worker) this.worker = null
        if (this.abort === controller) this.abort = null
        action()
      }

      worker.addEventListener('message', (event: MessageEvent<BookLexiconResponse>) => {
        const data = event.data
        if (!data || data.jobId !== jobId) return
        if (data.type === 'done') {
          finish(() => resolve(data.overlay))
          return
        }
        if (data.type === 'error') {
          finish(() => reject(new Error(data.message || '本书读音生成失败。')))
        }
      })
      worker.addEventListener('error', () => {
        finish(() => reject(new Error('读音生成线程出错。')))
      })
      worker.addEventListener('messageerror', () => {
        finish(() => reject(new Error('读音生成线程通信失败。')))
      })
      try {
        worker.postMessage({
          type: 'generate',
          jobId,
          chunks,
          cacheName: assets.cacheName,
          lexiconUrl: assets.lexiconUrl,
          tokensUrl: assets.tokensUrl,
          curatedOverlay,
          approvedOverrides: APPROVED_OVERRIDES,
        })
      } catch (error) {
        finish(() =>
          reject(error instanceof Error ? error : new Error('读音生成线程通信失败。')),
        )
      }
    })
  }

  private cancel(): void {
    this.abort?.abort()
    this.abort = null
    this.worker?.terminate()
    this.worker = null
  }

  private setStatus(status: BookLexiconStatus): void {
    this.status = status
    for (const listener of this.listeners) listener({ ...status })
  }
}

function countEntries(overlay: string): number {
  let count = 0
  for (const line of overlay.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) count += 1
  }
  return count
}
