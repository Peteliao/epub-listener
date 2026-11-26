import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BookLexiconService,
  bookLexiconFingerprint,
} from '@/core/tts/BookLexiconService'

const db = vi.hoisted(() => ({
  getBookLexicon: vi.fn(),
  saveBookLexicon: vi.fn(),
}))

vi.mock('@/core/db/LibraryDB', () => ({
  getBookLexicon: db.getBookLexicon,
  saveBookLexicon: db.saveBookLexicon,
}))

class FakeScanWorker {
  static instances: FakeScanWorker[] = []
  static truncated = 0
  listeners = new Map<string, Array<(event: any) => void>>()
  terminate = vi.fn()

  constructor() {
    FakeScanWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  postMessage(message: any): void {
    queueMicrotask(() => {
      for (const listener of this.listeners.get('message') ?? []) {
        listener({
          data: {
            type: 'done',
            jobId: message.jobId,
            overlay: '铺开 pu1 kai1',
            entries: 1,
            stats: { truncated: FakeScanWorker.truncated },
          },
        })
      }
    })
  }
}

const baseAssets: any = {
  voiceId: 'shanlan',
  cacheName: 'models',
  lexiconUrl: 'https://example.test/lexicon.txt',
  tokensUrl: 'https://example.test/tokens.txt',
  lexiconName: 'lexicon.txt',
  packId: 'matcha-baker',
  packVersion: '1',
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

async function start(service: BookLexiconService, chunks: string[]): Promise<void> {
  service.start('shanlan', async () => ({ chunks, rubyOverlays: [] }))
  await service.waitForOverlay(1000)
  await flush()
}

describe('2026-11-23 第十六轮：整书词典缓存指纹与生命周期', () => {
  let currentAssets: any
  let saved: any

  beforeEach(() => {
    FakeScanWorker.instances = []
    FakeScanWorker.truncated = 0
    vi.clearAllMocks()
    vi.stubGlobal('Worker', FakeScanWorker)
    currentAssets = { ...baseAssets }
    saved = undefined
    db.getBookLexicon.mockImplementation(async () => saved)
    db.saveBookLexicon.mockImplementation(async (record: any) => {
      saved = record
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function service(bookId: string): BookLexiconService {
    const ai = { getLexiconAssets: vi.fn(async () => currentAssets) }
    return new BookLexiconService(ai as never, bookId)
  }

  it('统一指纹覆盖书籍、内容、注音、音色包和规则版本', () => {
    const a = bookLexiconFingerprint(baseAssets, 'book-a', ['内容'], ['注音'])
    expect(bookLexiconFingerprint(baseAssets, 'book-a', ['内容'], ['注音'])).toBe(a)
    expect(bookLexiconFingerprint(baseAssets, 'book-b', ['内容'], ['注音'])).not.toBe(a)
    expect(bookLexiconFingerprint(baseAssets, 'book-a', ['改动'], ['注音'])).not.toBe(a)
    expect(bookLexiconFingerprint(baseAssets, 'book-a', ['内容'], [])).not.toBe(a)
    expect(bookLexiconFingerprint({ ...baseAssets, packVersion: '2' }, 'book-a', ['内容'], ['注音']))
      .not.toBe(a)
    expect(bookLexiconFingerprint({ ...baseAssets, voiceId: 'xiaoya' }, 'book-a', ['内容'], ['注音']))
      .not.toBe(a)
  })

  it('A/B 书互不残留即时纠错，dispose 清空 A 但不影响 B', async () => {
    const a = service('book-a')
    const b = service('book-b')
    await start(a, ['他把信纸铺开。'])
    await start(b, ['他把信纸铺开。'])

    a.setLiveOverlay('A词 a1', 'hash-a')
    expect(a.getOverlay()).toContain('A词 a1')
    expect(b.getOverlay()).not.toContain('A词 a1')

    a.dispose()
    expect(a.getOverlay()).toBe('')
    expect(b.getOverlay()).toContain('铺开 pu1 kai1')
    b.dispose()
  })

  it('相同内容命中统一指纹缓存；内容或音色包变化都会重新扫描', async () => {
    const instance = service('book-a')
    const chunks = ['他把信纸铺开。']
    await start(instance, chunks)
    expect(FakeScanWorker.instances).toHaveLength(1)
    expect(saved?.fingerprint).toBeTruthy()
    const firstKey = saved.fingerprint

    instance.invalidate()
    await start(instance, chunks)
    expect(FakeScanWorker.instances).toHaveLength(1)
    expect(saved.fingerprint).toBe(firstKey)

    await start(instance, ['内容更新后又有新的句子。'])
    expect(FakeScanWorker.instances).toHaveLength(2)
    expect(saved.fingerprint).not.toBe(firstKey)
    const secondKey = saved.fingerprint

    currentAssets = { ...currentAssets, packVersion: '2' }
    await start(instance, ['内容更新后又有新的句子。'])
    expect(FakeScanWorker.instances).toHaveLength(3)
    expect(saved.fingerprint).not.toBe(secondKey)
    instance.dispose()
  })

  it('保留 overlay 截断数，并在缓存命中与即时纠错后继续报告', async () => {
    FakeScanWorker.truncated = 4
    const instance = service('book-a')
    await start(instance, ['他把信纸铺开。'])

    expect(instance.getStatus().truncated).toBe(4)
    expect(instance.getReportInfo().truncated).toBe(4)
    expect(saved.truncated).toBe(4)

    instance.invalidate()
    await start(instance, ['他把信纸铺开。'])
    expect(FakeScanWorker.instances).toHaveLength(1)
    expect(instance.getStatus().truncated).toBe(4)

    instance.setLiveOverlay('乙 yi3', 'hash-b')
    expect(instance.getStatus().truncated).toBe(4)
    instance.dispose()
  })

  it('删除即时纠错后恢复扫描结果，不重写扫描缓存', async () => {
    const instance = service('book-a')
    await start(instance, ['他把信纸铺开。'])
    const before = db.saveBookLexicon.mock.calls.length

    expect(instance.setLiveOverlay('乙 yi3', 'hash-b')).toBe(true)
    expect(instance.getOverlay()).toContain('乙 yi3')
    expect(instance.setLiveOverlay('', '')).toBe(true)
    expect(instance.getOverlay()).not.toContain('乙 yi3')
    expect(instance.getOverlay()).toContain('铺开 pu1 kai1')
    expect(db.saveBookLexicon.mock.calls.length).toBe(before)
    instance.dispose()
  })
})
