import type { AiPackLang, AiRuntimeConfig } from './AiModel'
import {
  MediaAudioSink,
  type MediaSinkDiagnostics,
} from './MediaAudioSink'

export interface SherpaSpeakOptions {
  text: string
  rate: number
  lang?: AiPackLang
  volume?: number
  silenceScale?: number
  nextTexts?: (string | null)[] | null
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

type WorkerMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerDisposedMessage

interface PendingSynth {
  key: string
  lang: AiPackLang
  chars: number
  rate: number
  resolve: (buffer: AudioBuffer) => void
  reject: (error: Error) => void
  timer: number
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
  readyInfo: SherpaReadyInfo | null
  initPromise: Promise<SherpaReadyInfo> | null
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
const SYNTH_TIMEOUT_MS = 25_000
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
    readyInfo: null,
    initPromise: null,
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
  lang: AiPackLang,
  text: string,
  rate: number,
  speakerId: number,
  silenceScale: number,
  volume: number,
): string {
  return `${lang}|${speakerId}|${rate.toFixed(2)}|${silenceScale.toFixed(
    2,
  )}|${volume.toFixed(2)}|${text}`
}

function countSpeakableChars(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
}

function noiseScaleOf(pack: AiRuntimeConfig): number | null {
  const value = pack.model.config.noiseScale
  return typeof value === 'number' ? value : null
}

function workerUrl(): string {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI)
  return new URL('workers/sherpa-tts.worker.js', base).href
}

export class SherpaDriver {
  private worker: Worker | null = null
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private source: AudioBufferSourceNode | null = null
  private generation = 0
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

  cancel(): void {
    this.generation += 1
    this.stopSource()
    this.sink.stop()
    this.cancelPending()
  }

  releaseEnglish(): void {
    const slot = this.slots.en
    if (!this.worker && !slot.readyInfo) return
    this.rejectPendingLang('en', new Error('英文音色已释放。'))
    this.postMessage({ type: 'dispose-lang', lang: 'en' })
    slot.initReject?.(new Error('英文音色已释放。'))
    slot.initReject = null
    slot.initFinish = null
    slot.readyInfo = null
    slot.signature = ''
    slot.noiseScale = null
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
    const signature = `${lang}|${pack.packId}|${pack.voiceId}|${
      noiseScaleOf(pack) ?? ''
    }`

    if (slot.readyInfo && this.worker) {
      if (slot.signature === signature) {
        slot.speakerId = pack.speakerId
        return slot.readyInfo
      }
      // A loaded Chinese voice still owns the single pre-2.0 style reset; an
      // English voice can be freed in place, leaving Chinese untouched.
      if (lang === 'zh') this.resetRuntime()
      else this.releaseEnglish()
    }

    if (slot.initPromise) {
      try {
        await slot.initPromise
      } catch {
        // The original caller receives the failure; try the new pack anyway.
      }
      if (this.worker && slot.readyInfo && slot.signature === signature) {
        slot.speakerId = pack.speakerId
        return slot.readyInfo
      }
      if (lang === 'zh') this.resetRuntime()
      else this.releaseEnglish()
    }

    if (!this.worker) this.createWorker()

    slot.speakerId = pack.speakerId
    slot.signature = signature
    slot.noiseScale = noiseScaleOf(pack)
    slot.initPromise = new Promise<SherpaReadyInfo>((resolve, reject) => {
      let settled = false
      let timer = 0

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (slot.initReject === fail) {
          slot.initReject = null
          slot.initFinish = null
        }
        slot.readyInfo = null
        slot.signature = ''
        reject(error)
      }
      slot.initReject = fail

      timer = window.setTimeout(() => {
        fail(new Error('离线音色初始化超时，请重试。'))
      }, INIT_TIMEOUT_MS)

      const finishOk = (info: SherpaReadyInfo) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        slot.readyInfo = info
        slot.initFinish = null
        slot.initReject = null
        resolve(info)
      }
      slot.initFinish = finishOk

      try {
        this.worker!.postMessage({
          type: 'init',
          lang,
          glueUrl: pack.glueUrl,
          apiUrl: pack.apiUrl,
          wasmUrl: pack.wasmUrl,
          cacheName: pack.modelCacheName,
          model: pack.model,
          speakerId: pack.speakerId,
          sampleRate: pack.sampleRate,
          lexiconOverlay: pack.lexiconOverlay,
          files: pack.files,
        })
      } catch (error) {
        fail(
          error instanceof Error && error.message
            ? error
            : new Error('离线音色初始化失败。'),
        )
      }
    }).finally(() => {
      slot.initPromise = null
    })

    return slot.initPromise
  }

  private createWorker(): Worker {
    const worker = new Worker(workerUrl())
    this.worker = worker

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.handleMessage(event.data)
    }

    worker.onerror = (event) => {
      event.preventDefault?.()
      this.failWorker(event.message || '离线音色运行时加载失败。')
    }

    worker.onmessageerror = () => {
      this.failWorker('离线音色返回了无法解析的数据。')
    }

    return worker
  }

  private failWorker(message: string): void {
    const error = new Error(message)
    const worker = this.worker
    this.worker = null
    for (const lang of LANGS) {
      const slot = this.slots[lang]
      const fail = slot.initReject
      slot.initReject = null
      slot.initFinish = null
      slot.readyInfo = null
      slot.signature = ''
      slot.initPromise = null
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
    for (const lang of LANGS) {
      const slot = this.slots[lang]
      const fail = slot.initReject
      slot.initReject = null
      slot.initFinish = null
      slot.readyInfo = null
      slot.signature = ''
      slot.noiseScale = null
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
    const generation = ++this.generation
    this.stopSource()
    this.sink.prepareSpeech()

    const lang = normalizeLang(options.lang)
    const slot = this.slots[lang]
    const volume = lang === 'en' ? (options.volume ?? 1) : 1
    const silenceScale = options.silenceScale ?? 1
    const nextTexts = (options.nextTexts ?? []).filter(
      (text): text is string => Boolean(text),
    )
    const keyOf = (text: string) =>
      synthesisKey(
        lang,
        text,
        options.rate,
        slot.speakerId,
        silenceScale,
        volume,
      )
    const keepKeys = new Set([options.text, ...nextTexts].map(keyOf))
    // Seeks and voice changes leave prefetches for text that will never be
    // spoken. Dropping them frees the single worker for the current sentence.
    this.prunePending(keepKeys)

    if (!slot.readyInfo || !this.worker) {
      handlers.onError?.(
        lang === 'en' ? '英文离线音色尚未初始化。' : '离线音色尚未初始化。',
      )
      return
    }

    const key = keyOf(options.text)
    const cached = slot.cache.get(key)
    if (cached) {
      slot.stats.cacheHits += 1
      // Still inside the previous clip's ended handler: playing from the
      // cache here keeps the iOS media chain uninterrupted.
      this.playBuffer(cached, generation, handlers)
      this.prefetchAll(nextTexts, options.rate, silenceScale, lang, volume)
      return
    }

    void this.synthesizeAndPlay(
      options,
      lang,
      volume,
      silenceScale,
      nextTexts,
      handlers,
      generation,
    )
  }

  private async synthesizeAndPlay(
    options: SherpaSpeakOptions,
    lang: AiPackLang,
    volume: number,
    silenceScale: number,
    nextTexts: string[],
    handlers: SherpaSpeakHandlers,
    generation: number,
  ): Promise<void> {
    this.sink.startKeepAlive()
    try {
      if (this.context?.state === 'suspended') {
        void this.context.resume().catch(() => undefined)
      }
      const buffer = await this.requestBuffer(
        options.text,
        options.rate,
        silenceScale,
        lang,
        volume,
      )
      if (generation !== this.generation) return

      this.playBuffer(buffer, generation, handlers)
      this.prefetchAll(nextTexts, options.rate, silenceScale, lang, volume)
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
  ): void {
    const started = this.sink.playBuffer(buffer, {
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
        this.playViaWebAudio(buffer, generation, handlers)
      },
    })
    if (!started) this.playViaWebAudio(buffer, generation, handlers)
  }

  private playViaWebAudio(
    buffer: AudioBuffer,
    generation: number,
    handlers: SherpaSpeakHandlers,
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

  private prefetchAll(
    texts: string[],
    rate: number,
    silenceScale: number,
    lang: AiPackLang,
    volume: number,
  ): void {
    for (const text of texts) {
      this.prefetch(text, rate, silenceScale, lang, volume)
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

  private prefetch(
    text: string,
    rate: number,
    silenceScale: number,
    lang: AiPackLang,
    volume: number,
  ): void {
    if (!text) return
    const slot = this.slots[lang]
    const key = synthesisKey(
      lang,
      text,
      rate,
      slot.speakerId,
      silenceScale,
      volume,
    )
    if (slot.cache.has(key) || this.hasPendingKey(key)) return
    if (this.pending.size >= MAX_PENDING) return
    void this.requestBuffer(text, rate, silenceScale, lang, volume).catch(
      () => undefined,
    )
  }

  private hasPendingKey(key: string): boolean {
    for (const item of this.pending.values()) {
      if (item.key === key) return true
    }
    return false
  }

  private requestBuffer(
    text: string,
    rate: number,
    silenceScale: number,
    lang: AiPackLang,
    volume: number,
  ): Promise<AudioBuffer> {
    const slot = this.slots[lang]
    const key = synthesisKey(
      lang,
      text,
      rate,
      slot.speakerId,
      silenceScale,
      volume,
    )
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

    if (!this.worker) return Promise.reject(new Error('离线音色尚未初始化。'))
    slot.stats.cacheMisses += 1

    return new Promise<AudioBuffer>((resolve, reject) => {
      const jobId = `job-${++this.jobSequence}`
      const timer = window.setTimeout(() => {
        const pending = this.pending.get(jobId)
        if (!pending) return
        this.pending.delete(jobId)
        pending.reject(new Error('语音合成超时，请重试。'))
      }, SYNTH_TIMEOUT_MS)
      this.pending.set(jobId, {
        key,
        lang,
        chars: countSpeakableChars(text),
        rate,
        resolve,
        reject,
        timer,
      })
      try {
        this.worker!.postMessage({
          type: 'synth',
          lang,
          epoch: this.generation,
          jobId,
          text,
          speed: rate,
          speakerId: slot.speakerId,
          silenceScale,
          volume,
        })
      } catch (error) {
        const pending = this.pending.get(jobId)
        if (pending) {
          window.clearTimeout(pending.timer)
          this.pending.delete(jobId)
        }
        reject(error instanceof Error ? error : new Error('语音合成请求失败。'))
      }
    })
  }

  private findPendingByKey(key: string): Promise<AudioBuffer> | null {
    for (const item of this.pending.values()) {
      if (item.key === key) {
        return new Promise<AudioBuffer>((resolve, reject) => {
          const original = item.resolve
          item.resolve = (buffer) => {
            original(buffer)
            resolve(buffer)
          }
          const originalReject = item.reject
          item.reject = (error) => {
            originalReject(error)
            reject(error)
          }
        })
      }
    }
    return null
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.type === 'ready') {
      const lang = normalizeLang(message.lang)
      const slot = this.slots[lang]
      const finish = slot.initFinish
      if (finish) {
        finish({
          sampleRate: message.sampleRate,
          numSpeakers: message.numSpeakers,
          initMs: message.initMs,
          warmupMs: message.warmupMs,
          heapBytes: message.heapBytes,
        })
        return
      }
      slot.readyInfo = {
        sampleRate: message.sampleRate,
        numSpeakers: message.numSpeakers,
        initMs: message.initMs,
        warmupMs: message.warmupMs,
        heapBytes: message.heapBytes,
      }
      return
    }

    if (message.type === 'disposed') {
      return
    }

    if (message.type === 'error') {
      const lang = normalizeLang(message.lang)
      const slot = this.slots[lang]
      const error = new Error(message.message || '语音合成失败。')
      if (message.jobId) {
        const pending = this.takePending(message.jobId)
        if (pending) {
          pending.reject(error)
          return
        }
      }
      if (slot.initReject) {
        slot.initReject(error)
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
