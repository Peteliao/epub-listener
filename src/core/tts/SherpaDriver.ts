import type { AiEngine, AiPackLang, AiRuntimeConfig } from './AiModel'
import {
  MediaAudioSink,
  type MediaSinkDiagnostics,
} from './MediaAudioSink'

export interface SherpaSynthesisOptions {
  text: string
  rate: number
  lang?: AiPackLang
  volume?: number
  silenceScale?: number
}

export interface SherpaSpeakOptions extends SherpaSynthesisOptions {
  nextChunks?: SherpaSynthesisOptions[]
}

export interface SherpaSpeakHandlers {
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

export interface SherpaReadyInfo {
  sampleRate: number
  numSpeakers: number
  initMs: number
  warmupMs: number
  heapBytes: number
}

export interface SherpaStats extends SherpaReadyInfo {
  lang: AiPackLang
  noiseScale: number | null
  synthCount: number
  lastSynthMs: number | null
  averageSynthMs: number | null
  lastAudioMs: number | null
  /** Audio milliseconds per spoken character at 1× speed. */
  lastAudioMsPerChar: number | null
  lastRtf: number | null
  cacheHits: number
  cacheMisses: number
  pending: number
  cancelled: number
}

interface WorkerReadyMessage extends SherpaReadyInfo {
  type: 'ready'
  lang?: AiPackLang
  initId?: number
  speakerId: number
}

interface WorkerResultMessage {
  type: 'result'
  lang?: AiPackLang
  epoch: number
  jobId: string
  samples: ArrayBuffer
  sampleRate: number
  synthMs: number
}

interface WorkerErrorMessage {
  type: 'error'
  lang?: AiPackLang
  initId?: number
  epoch?: number
  jobId?: string
  code: string
  message: string
  stack?: string | null
}

interface WorkerDisposedMessage {
  type: 'disposed'
  lang?: AiPackLang
}

interface WorkerProgressMessage {
  type: 'progress'
  jobId: string
  count: number
}

type WorkerMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerDisposedMessage
  | WorkerProgressMessage

interface PendingSynth {
  key: string
  lang: AiPackLang
  chars: number
  rate: number
  promise: Promise<AudioBuffer>
  resolve: (buffer: AudioBuffer) => void
  reject: (error: Error) => void
  timer: number
  idle: boolean
}

interface SynthesisRequest {
  key: string
  text: string
  lang: AiPackLang
  engine: AiEngine
  speed: number
  speakerId: number
  silenceScale: number
  volume: number
}

interface PrefetchPlan {
  generation: number
  chunks: SherpaSynthesisOptions[]
  watched: Set<string>
  idle?: boolean
}

interface SynthStats {
  synthCount: number
  totalSynthMs: number
  lastSynthMs: number | null
  lastAudioMs: number | null
  lastAudioMsPerChar: number | null
  lastRtf: number | null
  cacheHits: number
  cacheMisses: number
  cancelledCount: number
}

interface RuntimeSlot {
  engine: AiEngine | null
  readyInfo: SherpaReadyInfo | null
  initPromise: Promise<SherpaReadyInfo> | null
  initId: number | null
  initReject: ((error: Error) => void) | null
  initFinish: ((info: SherpaReadyInfo) => void) | null
  signature: string
  speakerId: number
  noiseScale: number | null
  cache: Map<string, AudioBuffer>
  stats: SynthStats
}

const CACHE_LIMIT = 8
const MAX_PENDING = 3
const INIT_TIMEOUT_MS = 120_000
const HOJO_INIT_TIMEOUT_MS = 180_000
const SYNTH_TIMEOUT_MS = 25_000
const HOJO_SYNTH_TIMEOUT_MS = 120_000
const LANGS: readonly AiPackLang[] = ['zh', 'en']

function emptyStats(): SynthStats {
  return {
    synthCount: 0,
    totalSynthMs: 0,
    lastSynthMs: null,
    lastAudioMs: null,
    lastAudioMsPerChar: null,
    lastRtf: null,
    cacheHits: 0,
    cacheMisses: 0,
    cancelledCount: 0,
  }
}

function createSlot(): RuntimeSlot {
  return {
    engine: null,
    readyInfo: null,
    initPromise: null,
    initId: null,
    initReject: null,
    initFinish: null,
    signature: '',
    speakerId: 0,
    noiseScale: null,
    cache: new Map(),
    stats: emptyStats(),
  }
}

function normalizeLang(lang: AiPackLang | undefined): AiPackLang {
  return lang === 'en' ? 'en' : 'zh'
}

function synthesisKey(
  engine: AiEngine,
  lang: AiPackLang,
  text: string,
  rate: number,
  speakerId: number,
  silenceScale: number,
  volume: number,
): string {
  return `${engine}|${lang}|${speakerId}|${rate.toFixed(2)}|${silenceScale.toFixed(
    2,
  )}|${volume.toFixed(2)}|${text}`
}

/** Hojo generates at 1×; the media element applies the reading rate. */
function synthesisRate(engine: AiEngine, rate: number): number {
  return engine === 'hojo' ? 1 : rate
}

function countSpeakableChars(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
}

function noiseScaleOf(pack: AiRuntimeConfig): number | null {
  const value = pack.model.config.noiseScale
  return typeof value === 'number' ? value : null
}

function workerUrl(engine: AiEngine): string {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI)
  return new URL(
    engine === 'hojo' ? 'workers/hojo-tts.worker.js' : 'workers/sherpa-tts.worker.js',
    base,
  ).href
}

export class SherpaDriver {
  private worker: Worker | null = null
  private workerKind: AiEngine | null = null
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private generation = 0
  private activeLang: AiPackLang | null = null
  private prefetchPlan: PrefetchPlan | null = null
  private initSequence = 0
  private jobSequence = 0
  private readonly pending = new Map<string, PendingSynth>()
  private readonly sink = new MediaAudioSink()
  private readonly slots: Record<AiPackLang, RuntimeSlot> = {
    zh: createSlot(),
    en: createSlot(),
  }

  get initialized(): boolean {
    return Boolean(this.worker && this.slots.zh.readyInfo)
  }

  get englishInitialized(): boolean {
    return Boolean(this.worker && this.slots.en.readyInfo)
  }

  get metrics(): SherpaReadyInfo | null {
    const info = this.slots.zh.readyInfo
    return info ? { ...info } : null
  }

  get englishMetrics(): SherpaReadyInfo | null {
    const info = this.slots.en.readyInfo
    return info ? { ...info } : null
  }

  get sinkDiagnostics(): MediaSinkDiagnostics {
    return this.sink.diagnostics
  }

  get stats(): SherpaStats | null {
    return this.statsFor('zh')
  }

  get englishStats(): SherpaStats | null {
    return this.statsFor('en')
  }

  /** Must be called synchronously from a user gesture on iOS. */
  unlock(): void {
    this.sink.unlock()
    if (!this.context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      if (!Ctor) return
      this.context = new Ctor()
      this.master = this.context.createGain()
      this.master.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') {
      void this.context.resume().catch(() => undefined)
    }
  }

  async init(pack: AiRuntimeConfig): Promise<SherpaReadyInfo> {
    return this.initSlot('zh', pack)
  }

  async initEnglish(pack: AiRuntimeConfig): Promise<SherpaReadyInfo> {
    return this.initSlot('en', pack)
  }

  setSpeaker(speakerId: number): void {
    this.slots.zh.speakerId = Math.max(0, Math.trunc(speakerId))
  }

  speak(options: SherpaSpeakOptions, handlers: SherpaSpeakHandlers): void {
    this.runSpeak(options, handlers)
  }

  preload(chunks: SherpaSynthesisOptions[]): void {
    const plan: PrefetchPlan = {
      generation: this.generation, chunks, watched: new Set(), idle: true,
    }
    this.prefetchPlan = plan
    this.prefetchAll(plan)
  }

  /** Holds the background audio session while the next chapter renders. */
  keepAlive(): void {
    this.sink.startKeepAlive()
  }

  stopGap(): void {
    this.sink.stopGap()
  }

  playGap(ms: number, onEnd: () => void): boolean {
    return this.sink.playGap(ms, onEnd)
  }

  /** Stop old playback before awaiting a voice, without losing useful prefetch. */
  prepareSpeech(): void {
    this.generation += 1
    this.activeLang = null
    this.prefetchPlan = null
    this.stopSource()
    this.sink.prepareSpeech()
  }

  cancel(): void {
    this.prepareSpeech()
    this.sink.stop()
    this.cancelPending()
  }

  releaseEnglish(): void {
    const slot = this.slots.en
    if (this.activeLang === 'en') this.prepareSpeech()
    this.rejectPendingLang('en', new Error('英文音色已释放。'))
    this.postMessage({ type: 'dispose-lang', lang: 'en' })
    const fail = slot.initReject
    slot.initId = null
    slot.initPromise = null
    slot.initReject = null
    slot.initFinish = null
    fail?.(new Error('英文音色已释放。'))
    slot.readyInfo = null
    slot.signature = ''
    slot.noiseScale = null
    slot.engine = null
    slot.cache.clear()
    slot.stats = emptyStats()
  }

  release(): void {
    this.resetRuntime('离线音色已释放。')
    this.sink.release()
    if (this.master) {
      this.master.disconnect()
      this.master = null
    }
    if (this.context) {
      void this.context.close().catch(() => undefined)
      this.context = null
    }
  }

  private statsFor(lang: AiPackLang): SherpaStats | null {
    const slot = this.slots[lang]
    if (!slot.readyInfo) return null
    const stats = slot.stats
    return {
      ...slot.readyInfo,
      lang,
      noiseScale: slot.noiseScale,
      synthCount: stats.synthCount,
      lastSynthMs: stats.lastSynthMs,
      averageSynthMs:
        stats.synthCount > 0
          ? Math.round(stats.totalSynthMs / stats.synthCount)
          : null,
      lastAudioMs: stats.lastAudioMs,
      lastAudioMsPerChar: stats.lastAudioMsPerChar,
      lastRtf: stats.lastRtf,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      pending: this.pending.size,
      cancelled: stats.cancelledCount,
    }
  }

  private async initSlot(
    lang: AiPackLang,
    pack: AiRuntimeConfig,
  ): Promise<SherpaReadyInfo> {
    const slot = this.slots[lang]
    const engine = pack.engine
    const signature = `${engine}|${lang}|${pack.packId}|${pack.variantId}|${
      pack.packVersion
    }|${pack.voiceId}|${noiseScaleOf(pack) ?? ''}`

    if (this.worker && slot.signature === signature) {
      slot.speakerId = pack.speakerId
      if (slot.readyInfo) return slot.readyInfo
      if (slot.initPromise) return slot.initPromise
    }

    if (slot.readyInfo || slot.initPromise) {
      // Supersede, rather than await, an obsolete voice selection. The legacy
      // worker has no init identity, so an in-flight replacement needs a worker.
      if (
        lang === 'zh' || slot.engine !== engine ||
        (slot.initPromise && engine !== 'hojo')
      ) {
        this.resetRuntime()
      } else {
        this.releaseEnglish()
      }
    }

    if (this.worker && this.workerKind !== engine) this.resetRuntime()
    if (!this.worker) this.createWorker(engine)
    slot.engine = engine
    // The worker runs one job at a time; idle lookahead must not delay the
    // initialization that playback is about to wait on.
    this.cancelIdlePending()

    slot.speakerId = pack.speakerId
    slot.signature = signature
    slot.noiseScale = noiseScaleOf(pack)
    const initId = ++this.initSequence
    slot.initId = initId
    const initPromise = new Promise<SherpaReadyInfo>((resolve, reject) => {
      let settled = false
      let timer = 0

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (slot.initId === initId && slot.initReject === fail) {
          slot.initId = null
          slot.initReject = null
          slot.initFinish = null
          slot.readyInfo = null
          slot.signature = ''
        }
        reject(error)
      }
      slot.initReject = fail

      timer = window.setTimeout(
        () => {
          fail(new Error('离线音色初始化超时，请重试。'))
        },
        engine === 'hojo' ? HOJO_INIT_TIMEOUT_MS : INIT_TIMEOUT_MS,
      )

      const finishOk = (info: SherpaReadyInfo) => {
        if (settled || slot.initId !== initId) return
        settled = true
        window.clearTimeout(timer)
        slot.readyInfo = info
        slot.initFinish = null
        slot.initReject = null
        resolve(info)
      }
      slot.initFinish = finishOk

      const message: Record<string, unknown> = {
        type: 'init',
        initId,
        engine,
        lang,
        cacheName: pack.modelCacheName,
        model: pack.model,
        speakerId: pack.speakerId,
        sampleRate: pack.sampleRate,
        lexiconOverlay: pack.lexiconOverlay,
        files: pack.files,
        packId: pack.packId,
        packVersion: pack.packVersion,
        variantId: pack.variantId,
        runtimeBaseUrl: pack.runtimeBaseUrl,
        runtimeVersion: pack.runtimeVersion,
      }
      if (engine === 'hojo') {
        message.runtimeFiles = pack.runtimeFiles
      } else {
        message.glueUrl = pack.glueUrl
        message.apiUrl = pack.apiUrl
        message.wasmUrl = pack.wasmUrl
      }

      try {
        this.worker!.postMessage(message)
      } catch (error) {
        fail(
          error instanceof Error && error.message
            ? error
            : new Error('离线音色初始化失败。'),
        )
      }
    }).finally(() => {
      if (slot.initPromise === initPromise) slot.initPromise = null
    })
    slot.initPromise = initPromise

    return initPromise
  }

  private createWorker(engine: AiEngine): Worker {
    const worker = new Worker(workerUrl(engine))
    this.worker = worker
    this.workerKind = engine

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (this.worker === worker) this.handleMessage(event.data)
    }

    worker.onerror = (event) => {
      event.preventDefault?.()
      if (this.worker === worker) {
        this.failWorker(event.message || '离线音色运行时加载失败。')
      }
    }

    worker.onmessageerror = () => {
      if (this.worker === worker) this.failWorker('离线音色返回了无法解析的数据。')
    }

    return worker
  }

  private failWorker(message: string): void {
    const error = new Error(message)
    const worker = this.worker
    this.worker = null
    this.workerKind = null
    for (const lang of LANGS) {
      const slot = this.slots[lang]
      const fail = slot.initReject
      slot.initId = null
      slot.initPromise = null
      slot.initReject = null
      slot.initFinish = null
      slot.readyInfo = null
      slot.signature = ''
      slot.engine = null
      slot.cache.clear()
      if (fail) fail(error)
    }
    this.rejectPending(error)
    if (worker) {
      try {
        worker.terminate()
      } catch {
        // Already gone.
      }
    }
  }

  private resetRuntime(reason = '离线音色已切换。'): void {
    this.cancel()
    const worker = this.worker
    this.worker = null
    this.workerKind = null
    for (const lang of LANGS) {
      const slot = this.slots[lang]
      const fail = slot.initReject
      slot.initId = null
      slot.initPromise = null
      slot.initReject = null
      slot.initFinish = null
      slot.readyInfo = null
      slot.signature = ''
      slot.noiseScale = null
      slot.engine = null
      slot.cache.clear()
      slot.stats = emptyStats()
      if (fail) fail(new Error(reason))
    }
    this.rejectPending(new Error(reason))
    this.sink.clearClips()
    if (worker) {
      try {
        worker.postMessage({ type: 'dispose' })
      } catch {
        // Ignore a worker that already terminated.
      }
      worker.terminate()
    }
  }

  private runSpeak(
    options: SherpaSpeakOptions,
    handlers: SherpaSpeakHandlers,
  ): void {
    this.prepareSpeech()
    const generation = this.generation
    const request = this.synthesisRequest(options)
    const { lang, engine, key } = request
    const slot = this.slots[lang]
    const plan: PrefetchPlan = {
      generation,
      chunks: (options.nextChunks ?? []).filter((chunk) => Boolean(chunk.text)),
      watched: new Set(),
    }
    const cached = slot.cache.get(key)
    const orderedKeys = new Set([
      key,
      ...plan.chunks.map((chunk) => this.synthesisRequest(chunk).key),
    ])
    // Preserve relevant work in either language, reserving a queue position
    // for a new current request before adding any more lookahead.
    const capacity = MAX_PENDING - (!cached && !this.hasPendingKey(key) ? 1 : 0)
    this.prunePending(
      new Set(
        [...orderedKeys].filter((item) => this.hasPendingKey(item)).slice(0, capacity),
      ),
    )
    // Retained preloads are now part of live playback, not disposable idle work.
    for (const pending of this.pending.values()) pending.idle = false

    if (!slot.readyInfo || !this.worker) {
      handlers.onError?.(
        lang === 'en' ? '英文离线音色尚未初始化。' : '离线音色尚未初始化。',
      )
      return
    }

    this.activeLang = lang
    this.prefetchPlan = plan
    if (cached) {
      slot.stats.cacheHits += 1
      // Stay synchronous inside the previous clip's ended handler on iOS.
      this.playBuffer(cached, generation, handlers, options.rate, engine)
      this.prefetchAll(plan)
      return
    }

    void this.synthesizeAndPlay(request, options.rate, plan, handlers)
  }

  private async synthesizeAndPlay(
    request: SynthesisRequest,
    rate: number,
    plan: PrefetchPlan,
    handlers: SherpaSpeakHandlers,
  ): Promise<void> {
    const { generation } = plan
    this.sink.startKeepAlive()
    try {
      if (this.context?.state === 'suspended') {
        void this.context.resume().catch(() => undefined)
      }
      // Enqueue the current sentence first, then fill spare worker positions
      // while it synthesizes (rather than waiting for playback to begin).
      const pending = this.requestBuffer(request)
      this.prefetchAll(plan)
      const buffer = await pending
      if (generation !== this.generation) return

      this.playBuffer(buffer, generation, handlers, rate, request.engine)
      this.prefetchAll(plan)
    } catch (error) {
      if (generation !== this.generation) return
      this.sink.stop()
      handlers.onError?.(
        error instanceof Error && error.message
          ? error.message
          : '离线音色播放失败。',
      )
    }
  }

  private playBuffer(
    buffer: AudioBuffer,
    generation: number,
    handlers: SherpaSpeakHandlers,
    rate: number,
    engine: AiEngine,
  ): void {
    const playbackRate = engine === 'hojo' ? rate : 1
    const started = this.sink.playBuffer(
      buffer,
      {
        onStart: () => {
          if (generation !== this.generation) return
          handlers.onStart?.()
        },
        onEnd: () => {
          if (generation !== this.generation) return
          handlers.onEnd?.()
        },
        onError: () => {
          if (generation !== this.generation) return
          this.playViaWebAudio(buffer, generation, handlers, playbackRate)
        },
      },
      { rate: playbackRate },
    )
    if (!started) {
      this.playViaWebAudio(buffer, generation, handlers, playbackRate)
    }
  }

  private playViaWebAudio(
    buffer: AudioBuffer,
    generation: number,
    handlers: SherpaSpeakHandlers,
    rate: number,
  ): void {
    const context = this.context
    if (!context) {
      handlers.onError?.('离线音色播放失败。')
      return
    }

    const start = () => {
      if (generation !== this.generation) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = rate
      const pitched = source as AudioBufferSourceNode & {
        preservesPitch?: boolean
        webkitPreservesPitch?: boolean
      }
      if ('preservesPitch' in pitched) pitched.preservesPitch = true
      pitched.webkitPreservesPitch = true
      if (this.master) source.connect(this.master)
      else source.connect(context.destination)

      source.onended = () => {
        if (generation !== this.generation) return
        this.source = null
        handlers.onEnd?.()
      }
      this.source = source
      source.start(context.currentTime + 0.03)
      handlers.onStart?.()
    }

    if (context.state === 'suspended') {
      void context.resume().then(start).catch(() => {
        if (generation !== this.generation) return
        handlers.onError?.('离线音色播放失败。')
      })
      return
    }
    start()
  }

  private prefetchAll(plan: PrefetchPlan): void {
    if (plan.generation !== this.generation || plan !== this.prefetchPlan) return
    for (const chunk of plan.chunks) {
      const request = this.synthesisRequest(chunk)
      const slot = this.slots[request.lang]
      if (!slot.readyInfo || !this.worker) continue
      if (slot.cache.has(request.key) || plan.watched.has(request.key)) continue
      const existing = this.findPendingByKey(request.key)
      if (!existing && this.pending.size >= MAX_PENDING) continue
      plan.watched.add(request.key)
      const pending = existing ?? this.requestBuffer(request, plan.idle)
      // One watcher per key and plan: reused requests resolve once, and old
      // playback generations cannot refill the queue after a seek/voice change.
      void pending.then(
        () => this.prefetchAll(plan),
        () => this.prefetchAll(plan),
      )
    }
  }

  private stopSource(): void {
    const source = this.source
    this.source = null
    if (!source) return
    source.onended = null
    try {
      source.stop()
    } catch {
      // Already ended.
    }
    source.disconnect()
  }

  private synthesisRequest(options: SherpaSynthesisOptions): SynthesisRequest {
    const lang = normalizeLang(options.lang)
    const slot = this.slots[lang]
    const engine = slot.engine ?? 'sherpa'
    const speed = synthesisRate(engine, options.rate)
    const silenceScale = options.silenceScale ?? 1
    const volume = options.volume ?? 1
    return {
      key: synthesisKey(
        engine,
        lang,
        options.text,
        speed,
        slot.speakerId,
        silenceScale,
        volume,
      ),
      text: options.text,
      lang,
      engine,
      speed,
      speakerId: slot.speakerId,
      silenceScale,
      volume,
    }
  }

  private hasPendingKey(key: string): boolean {
    for (const item of this.pending.values()) {
      if (item.key === key) return true
    }
    return false
  }

  private cancelIdlePending(): void {
    if (this.prefetchPlan?.idle) this.prefetchPlan = null
    for (const [jobId, pending] of this.pending) {
      if (!pending.idle) continue
      this.pending.delete(jobId)
      window.clearTimeout(pending.timer)
      pending.reject(new Error('语音合成任务已取消。'))
      this.postCancelJob(jobId)
    }
  }

  private requestBuffer(request: SynthesisRequest, idle = false): Promise<AudioBuffer> {
    const { key, text, lang, engine, speed, speakerId, silenceScale, volume } = request
    const slot = this.slots[lang]
    const cached = slot.cache.get(key)
    if (cached) {
      slot.stats.cacheHits += 1
      return Promise.resolve(cached)
    }

    const existing = this.findPendingByKey(key)
    if (existing) {
      slot.stats.cacheHits += 1
      return existing
    }

    if (!this.worker || !slot.readyInfo) {
      return Promise.reject(new Error('离线音色尚未初始化。'))
    }
    slot.stats.cacheMisses += 1

    let resolve!: (buffer: AudioBuffer) => void
    let reject!: (error: Error) => void
    const promise = new Promise<AudioBuffer>((res, rej) => {
      resolve = res
      reject = rej
    })
    const jobId = `job-${++this.jobSequence}`
    const timer = window.setTimeout(
      () => {
        const pending = this.takePending(jobId)
        if (!pending) return
        this.postCancelJob(jobId)
        pending.reject(new Error('语音合成超时，请重试。'))
      },
      engine === 'hojo' ? HOJO_SYNTH_TIMEOUT_MS : SYNTH_TIMEOUT_MS,
    )
    this.pending.set(jobId, {
      key,
      lang,
      chars: countSpeakableChars(text),
      rate: speed,
      promise,
      resolve,
      reject,
      timer,
      idle,
    })
    try {
      this.worker.postMessage({
        type: 'synth',
        lang,
        epoch: this.generation,
        jobId,
        text,
        speed,
        speakerId,
        silenceScale,
        volume,
      })
    } catch (error) {
      this.takePending(jobId)
      reject(error instanceof Error ? error : new Error('语音合成请求失败。'))
    }
    return promise
  }

  private findPendingByKey(key: string): Promise<AudioBuffer> | null {
    for (const item of this.pending.values()) {
      if (item.key === key) return item.promise
    }
    return null
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      const lang = normalizeLang(message.lang)
      const slot = this.slots[lang]
      if (slot.engine === 'hojo' && message.initId !== slot.initId) return
      const finish = slot.initFinish
      if (!finish) return
      finish({
        sampleRate: message.sampleRate,
        numSpeakers: message.numSpeakers,
        initMs: message.initMs,
        warmupMs: message.warmupMs,
        heapBytes: message.heapBytes,
      })
      if (this.prefetchPlan) this.prefetchAll(this.prefetchPlan)
      return
    }

    if (message.type === 'disposed' || message.type === 'progress') {
      return
    }

    if (message.type === 'error') {
      const lang = normalizeLang(message.lang)
      const slot = this.slots[lang]
      const error = new Error(message.message || '语音合成失败。')
      if (message.jobId) {
        // A cancelled/timed-out job may fail after another voice starts loading.
        // It must never be interpreted as that voice's initialization failure.
        this.takePending(message.jobId)?.reject(error)
        return
      }
      if (message.code === 'init-failed' || message.initId !== undefined) {
        if (slot.engine === 'hojo' && message.initId !== slot.initId) return
        slot.initReject?.(error)
        return
      }
      if (slot.initReject) {
        if (slot.engine !== 'hojo') slot.initReject(error)
        return
      }
      slot.readyInfo = null
      this.rejectPendingLang(lang, error)
      return
    }

    const pending = this.takePending(message.jobId)
    if (!pending) return
    const slot = this.slots[pending.lang]

    const audioMs =
      message.sampleRate > 0
        ? (message.samples.byteLength / 4 / message.sampleRate) * 1000
        : 0
    slot.stats.synthCount += 1
    slot.stats.totalSynthMs += message.synthMs
    slot.stats.lastSynthMs = message.synthMs
    slot.stats.lastAudioMs = Math.round(audioMs)
    slot.stats.lastAudioMsPerChar =
      pending.chars > 0 && audioMs > 0
        ? (audioMs / pending.chars) * pending.rate
        : null
    slot.stats.lastRtf = audioMs > 0 ? message.synthMs / audioMs : null

    const buffer = this.createBuffer(message.samples, message.sampleRate)
    if (!buffer) {
      pending.reject(new Error('离线音色返回了空音频。'))
      return
    }
    this.cacheBuffer(pending.lang, pending.key, buffer)
    pending.resolve(buffer)
  }

  private takePending(jobId: string): PendingSynth | null {
    const pending = this.pending.get(jobId)
    if (!pending) return null
    this.pending.delete(jobId)
    window.clearTimeout(pending.timer)
    return pending
  }

  private createBuffer(
    samples: ArrayBuffer,
    sampleRate: number,
  ): AudioBuffer | null {
    if (!this.context || !samples || samples.byteLength === 0) return null
    const data = new Float32Array(samples)
    if (data.length === 0) return null
    const audio = this.context.createBuffer(1, data.length, sampleRate)
    audio.copyToChannel(data, 0)
    return audio
  }

  private cacheBuffer(
    lang: AiPackLang,
    key: string,
    buffer: AudioBuffer,
  ): void {
    const cache = this.slots[lang].cache
    if (cache.has(key)) cache.delete(key)
    cache.set(key, buffer)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    this.sink.warm(buffer)
  }

  private prunePending(keep: Set<string>): void {
    if (this.pending.size === 0) return
    for (const [jobId, pending] of this.pending) {
      if (keep.has(pending.key)) continue
      this.pending.delete(jobId)
      window.clearTimeout(pending.timer)
      this.slots[pending.lang].stats.cancelledCount += 1
      pending.reject(new Error('语音合成任务已取消。'))
      this.postCancelJob(jobId)
    }
  }

  private cancelPending(): void {
    if (this.pending.size === 0) return
    for (const [jobId, pending] of this.pending) {
      this.pending.delete(jobId)
      window.clearTimeout(pending.timer)
      this.slots[pending.lang].stats.cancelledCount += 1
      pending.reject(new Error('语音播放已取消。'))
      this.postCancelJob(jobId)
    }
  }

  private postCancelJob(jobId: string): void {
    this.postMessage({ type: 'cancel-job', jobId })
  }

  private postMessage(message: Record<string, unknown>): void {
    if (!this.worker) return
    try {
      this.worker.postMessage(message)
    } catch {
      // The worker may already be terminating.
    }
  }

  private rejectPendingLang(lang: AiPackLang, error: Error): void {
    for (const [jobId, pending] of this.pending) {
      if (pending.lang !== lang) continue
      this.pending.delete(jobId)
      window.clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private rejectPending(error: Error): void {
    for (const [jobId, pending] of this.pending) {
      this.pending.delete(jobId)
      window.clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}
