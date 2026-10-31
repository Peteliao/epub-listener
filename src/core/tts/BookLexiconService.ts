import { getBookLexicon, saveBookLexicon, type StoredBookLexicon } from '@/core/db/LibraryDB'
import type { AiLexiconAssets, AiModelManager } from './AiModel'
import {
  BOOK_LEXICON_VERSION,
  type BookLexiconResponse,
} from './bookLexicon'
import curatedOverlay from './polyphones.v1.txt?raw'

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

type CollectText = (signal: AbortSignal) => Promise<string[]>

const curatedHash = hashText(curatedOverlay)

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
      this.overlay = ''
      return ''
    })
    this.pipeline = pipeline
    void pipeline.finally(() => {
      if (this.pipeline === pipeline) this.pipeline = null
    })
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
    if (this.runKey === key && this.overlay) {
      this.setStatus({
        phase: 'ready',
        entries: countEntries(this.overlay),
        message: null,
      })
      return this.overlay
    }
    this.runKey = key
    this.overlay = ''

    const cached = await this.readCache(assets, key)
    if (this.disposed || !this.enabled) return ''
    if (cached) {
      this.overlay = cached.overlay
      this.setStatus({ phase: 'ready', entries: cached.entries, message: null })
      return cached.overlay
    }

    this.setStatus({ phase: 'generating', entries: 0, message: null })
    try {
      const overlay = await this.generate(assets, collect)
      if (this.disposed) return ''
      this.overlay = overlay
      const entries = overlay ? countEntries(overlay) : 0
      this.setStatus({ phase: 'ready', entries, message: null })
      if (overlay) {
        const record: StoredBookLexicon = {
          bookId: this.bookId,
          overlay,
          entries,
          version: BOOK_LEXICON_VERSION,
          packId: assets.packId,
          packVersion: assets.packVersion,
          lexiconName: assets.lexiconName,
          curatedHash,
          createdAt: Date.now(),
        }
        void saveBookLexicon(record).catch(() => undefined)
      }
      return overlay
    } catch (error) {
      if (!this.disposed && this.enabled) {
        this.setStatus({
          phase: 'error',
          entries: 0,
          message:
            error instanceof Error ? error.message : '本书读音生成失败。',
        })
      }
      return ''
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

  private generate(assets: AiLexiconAssets, collect: CollectText): Promise<string> {
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
      const controller = new AbortController()
      this.abort = controller

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

      void collect(controller.signal)
        .then((chunks) => {
          if (settled) return
          if (!chunks.some((chunk) => chunk.trim())) {
            finish(() => resolve(''))
            return
          }
          worker.postMessage({
            type: 'generate',
            jobId,
            chunks,
            cacheName: assets.cacheName,
            lexiconUrl: assets.lexiconUrl,
            tokensUrl: assets.tokensUrl,
            curatedOverlay,
          })
        })
        .catch((error) => {
          finish(() =>
            reject(
              error instanceof Error ? error : new Error('未能读取本书正文。'),
            ),
          )
        })
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
