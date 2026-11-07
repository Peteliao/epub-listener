import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AiEngine, AiPackLang, AiRuntimeConfig } from '../src/core/tts/AiModel'
import { MediaAudioSink } from '../src/core/tts/MediaAudioSink'
import { SherpaDriver } from '../src/core/tts/SherpaDriver'

type Packet = Record<string, unknown> & {
  type: string
  lang?: AiPackLang
  initId?: number
  jobId?: string
}

class FakeWorker {
  static instances: FakeWorker[] = []
  messages: Packet[] = []
  onmessage: ((event: { data: Packet }) => void) | null = null
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminate = vi.fn()

  constructor(readonly url: string) {
    FakeWorker.instances.push(this)
  }

  postMessage(message: Packet): void {
    this.messages.push(message)
  }

  emit(message: Packet): void {
    this.onmessage?.({ data: message })
  }

  ofType(type: string): Packet[] {
    return this.messages.filter((message) => message.type === type)
  }

  ready(init: Packet): void {
    this.emit({
      type: 'ready', lang: init.lang, initId: init.initId,
      sampleRate: 24000, numSpeakers: 10, initMs: 20, warmupMs: 0, heapBytes: 100,
    })
  }

  result(job: Packet): void {
    this.emit({
      type: 'result', lang: job.lang, jobId: job.jobId, epoch: job.epoch,
      samples: new Float32Array(240).buffer, sampleRate: 24000, synthMs: 5,
    })
  }
}

class FakeAudioContext {
  state = 'running'
  destination = {}
  currentTime = 0
  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createGain = () => ({ connect: vi.fn(), disconnect: vi.fn() })

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const samples = new Float32Array(length)
    return {
      length, sampleRate, duration: length / sampleRate,
      copyToChannel: (data: Float32Array) => samples.set(data),
      getChannelData: () => samples,
    } as unknown as AudioBuffer
  }

  createBufferSource() {
    const source = {
      buffer: null as AudioBuffer | null,
      playbackRate: { value: 1 },
      onended: null as (() => void) | null,
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    }
    return source
  }
}

function pack(lang: AiPackLang, engine: AiEngine = 'hojo', voiceId: string = lang): AiRuntimeConfig {
  return {
    engine, lang, voiceId, speakerId: lang === 'en' ? 3 : 1,
    runtimeBaseUrl: 'https://example.test/runtime/', runtimeVersion: '1',
    modelCacheName: 'models', packId: 'bilingual', packVersion: '1', variantId: 'full',
    sampleRate: 24000, voiceLabel: voiceId,
    model: { type: engine === 'hojo' ? 'hojo' : 'vits', config: {}, ruleFsts: [] },
    files: [],
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

let driver: SherpaDriver
let play: MockInstance<MediaAudioSink['playBuffer']>

async function initialize(engine: AiEngine = 'hojo'): Promise<FakeWorker> {
  const zh = driver.init(pack('zh', engine))
  const worker = FakeWorker.instances.at(-1)!
  worker.ready(worker.ofType('init').at(-1)!)
  await zh
  const en = driver.initEnglish(pack('en', engine))
  worker.ready(worker.ofType('init').at(-1)!)
  await en
  return worker
}

describe('SherpaDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    let urlSequence = 0
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:test-${++urlSequence}`)
      static revokeObjectURL = vi.fn()
    })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    play = vi.spyOn(MediaAudioSink.prototype, 'playBuffer')
    driver = new SherpaDriver()
    driver.unlock()
  })

  afterEach(async () => {
    driver.release()
    await flush()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('queues the current request first and fills ordered cross-language lookahead during synthesis', async () => {
    const worker = await initialize('sherpa')
    driver.speak({
      text: '当前', lang: 'zh', rate: 1.25, volume: 0.8, silenceScale: 0.6,
      nextChunks: [
        { text: 'English', lang: 'en', rate: 0.9, volume: 1.7, silenceScale: 0.2 },
        { text: '后续', lang: 'zh', rate: 1.1 },
        { text: 'Later', lang: 'en', rate: 1.2 },
      ],
    }, {})
    expect(worker.ofType('synth')).toMatchObject([
      { text: '当前', lang: 'zh', speakerId: 1, speed: 1.25, volume: 0.8, silenceScale: 0.6 },
      { text: 'English', lang: 'en', speakerId: 3, speed: 0.9, volume: 1.7, silenceScale: 0.2 },
      { text: '后续', lang: 'zh', speakerId: 1, speed: 1.1, volume: 1, silenceScale: 1 },
    ])
    expect(play).not.toHaveBeenCalled()
    expect(driver.stats?.pending).toBe(3)

    worker.result(worker.ofType('synth')[0]!)
    await flush()
    expect(worker.ofType('synth').map((job) => job.text)).toEqual(['当前', 'English', '后续', 'Later'])
    expect(driver.stats?.pending).toBe(3)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('reuses opposite-language pending work once, with Hojo rate applied only at playback', async () => {
    const worker = await initialize()
    const english = { text: 'English', lang: 'en' as const, rate: 1.2, volume: 1.6 }
    const chinese = { text: '后续', lang: 'zh' as const, rate: 0.8 }
    const obsolete = { onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() }
    driver.speak({ text: '当前', rate: 1.1, nextChunks: [english, chinese] }, obsolete)
    const jobs = worker.ofType('synth')
    driver.speak({ ...english, rate: 1.5, nextChunks: [chinese] }, obsolete)
    const onStart = vi.fn()
    driver.speak({ ...english, rate: 1.6, nextChunks: [chinese] }, { onStart })

    expect(worker.ofType('synth')).toHaveLength(3)
    expect(jobs[1]).toMatchObject({ lang: 'en', speakerId: 3, speed: 1, volume: 1.6 })
    expect(worker.ofType('cancel-job')).toEqual([{ type: 'cancel-job', jobId: jobs[0]!.jobId }])
    worker.result(jobs[1]!)
    worker.result(jobs[1]!)
    await flush()
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(obsolete.onStart).not.toHaveBeenCalled()
    expect(obsolete.onError).not.toHaveBeenCalled()
    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.calls[0]![2]).toEqual({ rate: 1.6 })
    expect(driver.englishStats?.synthCount).toBe(1)
  })

  it.each([false, true])('silently preloads actual text and reuses it on play with completed=%s', async (completed) => {
    const worker = await initialize()
    const chinese = { text: '当前', lang: 'zh' as const, rate: 1 }
    const english = { text: 'English', lang: 'en' as const, rate: 1.2, volume: 0.7 }
    const mediaPlays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    driver.preload([chinese, english])
    const jobs = worker.ofType('synth')
    expect(jobs.map((job) => job.text)).toEqual(['当前', 'English'])
    if (completed) {
      for (const job of jobs) worker.result(job)
      await flush()
    }
    expect(play).not.toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(mediaPlays)
    driver.speak({ ...chinese, nextChunks: [english] }, {})
    if (!completed) {
      for (const job of jobs) worker.result(job)
      await flush()
    }
    expect(worker.ofType('synth')).toHaveLength(2)
    expect(worker.ofType('cancel-job')).toHaveLength(0)
    expect(play).toHaveBeenCalledTimes(1)
    driver.speak(english, {})
    expect(worker.ofType('synth')).toHaveLength(2)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('cancels idle preloads before a replacement init can queue behind them', async () => {
    const worker = await initialize()
    driver.preload([
      { text: 'A', lang: 'zh', rate: 1 },
      { text: 'B', lang: 'en', rate: 1 },
    ])
    const idle = worker.ofType('synth')
    expect(idle.map((job) => job.text)).toEqual(['A', 'B'])
    driver.releaseEnglish()
    const next = driver.initEnglish(pack('en', 'hojo', 'en-02'))
    expect(worker.ofType('cancel-job')).toContainEqual({ type: 'cancel-job', jobId: idle[0]!.jobId })
    worker.ready(worker.ofType('init').at(-1)!)
    await next
    worker.result(idle[0]!)
    worker.result(idle[1]!)
    await flush()
    expect(worker.ofType('synth')).toHaveLength(2)
    expect(play).not.toHaveBeenCalled()
  })

  it('cancels idle synthesis without starting audio or refilling its queue', async () => {
    const worker = await initialize()
    driver.preload(['A', 'B', 'C', 'D'].map((text) => ({ text, rate: 1 })))
    expect(worker.ofType('synth')).toHaveLength(3)
    driver.cancel()
    for (const job of worker.ofType('synth')) worker.result(job)
    await flush()
    expect(worker.ofType('cancel-job')).toHaveLength(3)
    expect(worker.ofType('synth')).toHaveLength(3)
    expect(play).not.toHaveBeenCalled()
    expect(driver.stats?.pending).toBe(0)
  })

  it.each(['rate', 'volume', 'silenceScale'] as const)('keys Sherpa lookahead by its own %s', async (field) => {
    const worker = await initialize('sherpa')
    const english = { text: 'English', lang: 'en' as const, rate: 1, volume: 1, silenceScale: 1 }
    driver.speak({ text: '当前', rate: 1, nextChunks: [english] }, {})
    const old = worker.ofType('synth')[1]!
    driver.speak({ ...english, [field]: 1.5 }, {})
    expect(worker.ofType('synth')).toHaveLength(3)
    expect(worker.ofType('cancel-job')).toContainEqual({ type: 'cancel-job', jobId: old.jobId })
  })

  it('prefetches a future language when its slot becomes ready', async () => {
    const zh = driver.init(pack('zh'))
    const worker = FakeWorker.instances[0]!
    worker.ready(worker.ofType('init')[0]!)
    await zh
    const en = driver.initEnglish(pack('en'))
    driver.speak({ text: '当前', rate: 1, nextChunks: [{ text: 'English', lang: 'en', rate: 1.2 }] }, {})
    expect(worker.ofType('synth')).toHaveLength(1)
    worker.ready(worker.ofType('init')[1]!)
    await en
    expect(worker.ofType('synth').map((job) => job.text)).toEqual(['当前', 'English'])
  })

  it('reserves space for a new current request when three useful futures are pending', async () => {
    const worker = await initialize()
    const nextChunks = ['B', 'C', 'D'].map((text) => ({ text, lang: 'en' as const, rate: 1 }))
    driver.speak({ text: 'A', rate: 1, nextChunks }, {})
    worker.result(worker.ofType('synth')[0]!)
    await flush()
    const furthest = worker.ofType('synth')[3]!
    driver.speak({ text: 'X', rate: 1, nextChunks }, {})
    expect(worker.ofType('synth').at(-1)!.text).toBe('X')
    expect(worker.ofType('cancel-job')).toContainEqual({ type: 'cancel-job', jobId: furthest.jobId })
    expect(driver.stats?.pending).toBe(3)
  })

  it('watches reused jobs behind a full queue so the newest plan can refill it', async () => {
    const worker = await initialize()
    const nextChunks = ['B', 'C', 'D'].map((text) => ({ text, lang: 'en' as const, rate: 1 }))
    driver.speak({ text: 'A', rate: 1, nextChunks }, {})
    worker.result(worker.ofType('synth')[0]!)
    await flush()
    driver.speak({
      text: 'A', rate: 1,
      nextChunks: [{ text: 'new lookahead', lang: 'en', rate: 1 }, ...nextChunks],
    }, {})
    expect(worker.ofType('cancel-job')).toHaveLength(0)
    expect(worker.ofType('synth')).toHaveLength(4)
    worker.result(worker.ofType('synth')[1]!)
    await flush()
    expect(worker.ofType('synth').at(-1)!.text).toBe('new lookahead')
    expect(driver.stats?.pending).toBe(3)
  })

  it('does not consume pending synthesis when the worker reports progress', async () => {
    const worker = await initialize()
    const onError = vi.fn()
    driver.speak({ text: 'A', rate: 1 }, { onError })
    const job = worker.ofType('synth')[0]!
    worker.emit({ type: 'progress', jobId: job.jobId, count: 66 })
    await flush()
    expect(driver.stats?.pending).toBe(1)
    expect(driver.stats?.synthCount).toBe(0)
    expect(onError).not.toHaveBeenCalled()
    worker.result(job)
    await flush()
    expect(play).toHaveBeenCalledTimes(1)
    expect(driver.stats?.synthCount).toBe(1)
  })

  it('invalidates old synthesis callbacks without cancelling useful prefetch or the keepalive', async () => {
    const worker = await initialize()
    const handlers = { onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() }
    driver.speak({
      text: 'A', rate: 1,
      nextChunks: ['B', 'C', 'D'].map((text) => ({ text, lang: 'en', rate: 1 })),
    }, handlers)
    const jobs = worker.ofType('synth')
    driver.prepareSpeech()
    expect(driver.sinkDiagnostics.state).toBe('keepalive')
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
    expect(worker.ofType('cancel-job')).toHaveLength(0)
    for (const job of jobs) worker.result(job)
    await flush()
    expect(worker.ofType('synth')).toHaveLength(3)
    expect(play).not.toHaveBeenCalled()
    expect(handlers.onStart).not.toHaveBeenCalled()
    driver.speak({ text: 'B', lang: 'en', rate: 1 }, {})
    expect(play).toHaveBeenCalledTimes(1)
    expect(worker.ofType('synth')).toHaveLength(3)
  })

  it('stops active media and rejects callbacks synchronously in prepareSpeech', async () => {
    const worker = await initialize()
    const handlers = { onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() }
    driver.speak({ text: 'A', rate: 1 }, handlers)
    worker.result(worker.ofType('synth')[0]!)
    await flush()
    const stale = play.mock.calls[0]![1]
    driver.prepareSpeech()
    expect(driver.sinkDiagnostics.state).toBe('idle')
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    stale.onStart?.()
    stale.onEnd?.()
    stale.onError?.('late media failure')
    expect(handlers.onStart).toHaveBeenCalledTimes(1)
    expect(handlers.onEnd).not.toHaveBeenCalled()
    expect(handlers.onError).not.toHaveBeenCalled()
  })

  it('stops an active WebAudio fallback in prepareSpeech', async () => {
    const worker = await initialize()
    play.mockReturnValue(false)
    const createSource = vi.spyOn(FakeAudioContext.prototype, 'createBufferSource')
    driver.speak({ text: 'A', rate: 1 }, {})
    worker.result(worker.ofType('synth')[0]!)
    await flush()
    const source = createSource.mock.results[0]!.value
    driver.prepareSpeech()
    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(source.onended).toBeNull()
  })

  it('cancel still cancels every synthesis job after prepareSpeech', async () => {
    const worker = await initialize()
    driver.speak({ text: 'A', rate: 1, nextChunks: [{ text: 'B', lang: 'en', rate: 1 }] }, {})
    driver.prepareSpeech()
    driver.cancel()
    expect(worker.ofType('cancel-job')).toHaveLength(2)
    expect(driver.stats?.pending).toBe(0)
    for (const job of worker.ofType('synth')) worker.result(job)
    await flush()
    expect(play).not.toHaveBeenCalled()
  })

  it('ignores stale init/job errors and preserves a replacement init promise through old finally', async () => {
    const worker = await initialize()
    driver.releaseEnglish()
    const old = driver.initEnglish(pack('en', 'hojo', 'old')).catch((error: Error) => error)
    const oldInit = worker.ofType('init').at(-1)!
    const currentPack = pack('en', 'hojo', 'new')
    const current = driver.initEnglish(currentPack)
    const currentInit = worker.ofType('init').at(-1)!
    expect(currentInit.initId).toBeGreaterThan(oldInit.initId!)
    expect(await old).toBeInstanceOf(Error)
    await flush()
    worker.ready(oldInit)
    worker.emit({ type: 'error', lang: 'en', initId: oldInit.initId, code: 'init-failed', message: 'old init' })
    worker.emit({ type: 'error', lang: 'en', jobId: 'old-job', message: 'old job' })
    expect(driver.englishInitialized).toBe(false)
    const joined = driver.initEnglish(currentPack)
    expect(worker.ofType('init')).toHaveLength(4)
    worker.ready(currentInit)
    await Promise.all([current, joined])
    expect(driver.englishInitialized).toBe(true)
    worker.emit({ type: 'error', lang: 'en', jobId: 'old-job', message: 'late job' })
    expect(driver.englishInitialized).toBe(true)
    driver.releaseEnglish()
    worker.ready(currentInit)
    expect(driver.englishInitialized).toBe(false)
  })

  it('ignores messages and errors from a replaced worker', async () => {
    const old = driver.init(pack('zh', 'hojo', 'old')).catch((error: Error) => error)
    const oldWorker = FakeWorker.instances[0]!
    const current = driver.init(pack('zh', 'hojo', 'new'))
    const worker = FakeWorker.instances[1]!
    const init = worker.ofType('init')[0]!
    await old
    oldWorker.ready(init)
    oldWorker.onerror?.({ message: 'obsolete worker', preventDefault: vi.fn() })
    oldWorker.onmessageerror?.()
    expect(driver.initialized).toBe(false)
    worker.ready(init)
    await current
    expect(driver.initialized).toBe(true)
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('retries timed-out Hojo init without accepting its late ready or error', async () => {
    const first = driver.init(pack('zh')).catch((error: Error) => error)
    const worker = FakeWorker.instances[0]!
    const oldInit = worker.ofType('init')[0]!
    await vi.advanceTimersByTimeAsync(180_000)
    expect(await first).toBeInstanceOf(Error)
    const current = driver.init(pack('zh'))
    worker.ready(oldInit)
    worker.emit({ type: 'error', lang: 'zh', initId: oldInit.initId, code: 'init-failed', message: 'late' })
    expect(driver.initialized).toBe(false)
    worker.ready(worker.ofType('init')[1]!)
    await current
    expect(driver.initialized).toBe(true)
  })

  it('reuses same-signature loading and ready slots without losing the selected speaker', async () => {
    const config = pack('zh')
    const first = driver.init(config)
    const second = driver.init({ ...config, speakerId: 5 })
    const worker = FakeWorker.instances[0]!
    expect(worker.ofType('init')).toHaveLength(1)
    worker.ready(worker.ofType('init')[0]!)
    await Promise.all([first, second])
    await driver.init({ ...config, speakerId: 6 })
    expect(worker.ofType('init')).toHaveLength(1)
    driver.speak({ text: '当前', rate: 1 }, {})
    expect(worker.ofType('synth')[0]!.speakerId).toBe(6)
  })

  it('releasing English stops its active clip before loading another voice', async () => {
    const worker = await initialize()
    driver.speak({ text: 'English', lang: 'en', rate: 1 }, {})
    worker.result(worker.ofType('synth')[0]!)
    await flush()
    driver.releaseEnglish()
    expect(driver.sinkDiagnostics.state).toBe('idle')
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    expect(driver.initialized).toBe(true)
    expect(driver.englishInitialized).toBe(false)
  })

  it('touches the synthesis cache on a hit so hot sentences survive LRU', async () => {
    const internal = driver as unknown as {
      slots: {
        zh: { cache: Map<string, AudioBuffer>; stats: { cacheHits: number } }
      }
      requestBuffer: (request: Record<string, unknown>) => Promise<AudioBuffer>
    }
    const hot = { length: 1 } as unknown as AudioBuffer
    const cold = { length: 1 } as unknown as AudioBuffer
    const cache = internal.slots.zh.cache
    cache.set('hot', hot)
    cache.set('cold', cold)

    const request = {
      key: 'hot',
      text: '热句',
      lang: 'zh',
      engine: 'sherpa',
      speed: 1,
      speakerId: 0,
      silenceScale: 1,
      volume: 1,
      chars: 2,
    }
    expect(await internal.requestBuffer(request)).toBe(hot)
    expect([...cache.keys()]).toEqual(['cold', 'hot'])
    expect(internal.slots.zh.stats.cacheHits).toBeGreaterThan(0)
  })
})
