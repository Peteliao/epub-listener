import type {
  ChapterInfo,
  ReaderSettings,
  StoredBook,
  StoredProgress,
  TtsEngine,
  VoiceOption,
} from '@/types'
import { PAUSE_PRESET_SCALES } from '@/types'
import { createReaderSession } from '@/core/reader/createSession'
import type { ChapterRender, ReaderSession } from '@/core/reader/ReaderSession'
import type {
  HighlightOptions,
  Highlighter,
} from '@/core/reader/Highlighter'
import { WebSpeechDriver } from '@/core/tts/WebSpeechDriver'
import { AiModelManager, type AiModelStatus } from '@/core/tts/AiModel'
import { BookLexiconService, type BookLexiconStatus } from '@/core/tts/BookLexiconService'
import { SherpaDriver, type SherpaStats } from '@/core/tts/SherpaDriver'
import type { MediaSinkDiagnostics } from '@/core/tts/MediaAudioSink'
import {
  buildSpeechUnits,
  type SpeechUnit,
} from '@/core/text/speechGroups'
import { MediaSessionController } from '@/core/system/MediaSession'
import { ScreenWakeLock } from '@/core/system/ScreenWakeLock'
import { saveProgress } from '@/core/db/LibraryDB'
import { canPrewarmAi, readPrewarmEnvironment } from '@/core/tts/prewarm'
import {
  splitLanguageSegments,
  type LanguageSegment,
} from '@/core/text/LanguageSegments'
import { ensureSpeechEnd, sentenceGapMs } from '@/core/text/speechPause'
import { bindStageTaps } from '@/core/reader/stageTap'
import { normalizeEnglishSpeech } from '@/core/text/englishText'
import { shouldSkipEnglishChunk } from '@/core/text/englishSkip'
import { isIOSDevice } from '@/core/tts/systemVoice'
import { estimateRemainingMs } from './listenTime'

type ChunkEngine = 'ai' | 'system'

interface SpeechChunk extends LanguageSegment {
  engine: ChunkEngine
  nextTexts: string[]
}

const PREFETCH_CHUNKS = 3
const PREWARM_DELAY_MS = 3000
const SLOW_RTF_THRESHOLD = 0.8
const SLOW_RTF_STREAK = 3

const HAN_LETTER = /\p{Script=Han}/gu
const LATIN_LETTER = /\p{Script=Latin}/gu

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

export interface ReaderState {
  isPlaying: boolean
  isLoading: boolean
  /** First sentence of the unit being read. */
  sentenceIndex: number
  /** Last sentence of the unit being read; equals sentenceIndex when ungrouped. */
  sentenceEndIndex: number
  sentenceCount: number
  /** Estimated audio left in the current chapter, in milliseconds. */
  remainingMs: number | null
  chapterIndex: number
  chapterLabel: string
  chapterCount: number
  canSpeak: boolean
  activeEngine: TtsEngine | null
  /** Language of the chunk currently being spoken. */
  activeLang: 'zh' | 'en' | null
}

export interface ReaderControllerOptions {
  book: StoredBook
  container: HTMLElement
  settings: ReaderSettings
  progress?: StoredProgress
  onState: (state: ReaderState) => void
  onToast: (message: string) => void
  onVoicesChanged?: (voices: VoiceOption[]) => void
  onEnglishVoicesChanged?: (voices: VoiceOption[]) => void
  onAiStatus?: (status: AiModelStatus) => void
  onBookLexiconStatus?: (status: BookLexiconStatus) => void
  onExternalLink?: (url: string) => void
  onContentTap?: () => void
}

export interface ReaderDiagnostics {
  engine: TtsEngine
  activeEngine: TtsEngine | null
  activeLang: 'zh' | 'en' | null
  voiceLabel: string
  packId: string | null
  aiPhase: AiModelStatus['phase']
  units: number
  sentences: number
  stats: SherpaStats | null
  englishStats: SherpaStats | null
  sink: MediaSinkDiagnostics
  noiseScale: number | null
  silenceScale: number
}

interface LoadChapterOptions {
  target?: number | 'end'
  anchor?: string | null
  autoplay: boolean
  attempt?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export class ReaderController {
  private readonly options: ReaderControllerOptions
  private readonly speech = new WebSpeechDriver()
  private readonly ai: AiModelManager
  private readonly bookLexicon: BookLexiconService
  private readonly aiSpeech = new SherpaDriver()
  private readonly mediaSession: MediaSessionController
  private readonly wakeLock: ScreenWakeLock
  private session: ReaderSession | null = null
  private highlighter: Highlighter | null = null
  private chapters: ChapterInfo[] = []
  private settings: ReaderSettings
  private isPlaying = false
  private isLoading = false
  private chapterLoading = false
  private initialized = false
  private destroyed = false
  private displayInFlight = false
  private pocketActive = false
  private units: SpeechUnit[] = []
  private sentenceIndex = 0
  private sentenceEndIndex = 0
  private sentenceCount = 0
  private chapterIndex = -1
  private chapterLabel = ''
  private playbackGeneration = 0
  private chapterToken = 0
  private saveTimer: number | null = null
  private sentenceGapTimer: number | null = null
  private chunkGapTimer: number | null = null
  private sentenceGapActive = false
  private activePlan: SpeechChunk[] | null = null
  private activePlanIndex = 0
  private activePlanGeneration = 0
  private activeChunk: SpeechChunk | null = null
  private readonly iosDevice = isIOSDevice()
  private englishSkipped = 0
  private englishSkipNoticed = false
  private progressWriteChain: Promise<void> = Promise.resolve()
  private progressErrorShown = false
  private wakeLockNoticeShown = false
  private englishVoiceNoticeShown = false
  private unsubscribeVoices: (() => void) | null = null
  private unsubscribeEnglishVoices: (() => void) | null = null
  private unsubscribeAi: (() => void) | null = null
  private unsubscribeBookLexicon: (() => void) | null = null
  private aiStatus: AiModelStatus
  private aiInitPromise: Promise<void> | null = null
  private aiFallback = false
  private aiLoadedPackId: string | null = null
  private aiLoadedVoiceId: string | null = null
  private aiLoadedOverlay = ''
  private aiLoadedEnglishPackId: string | null = null
  private englishAiInitPromise: Promise<void> | null = null
  private englishAiFallback = false
  private activeEngine: TtsEngine | null = null
  private activeLang: 'zh' | 'en' | null = null
  private measuredZhMsPerChar: number | null = null
  private lastSampledAudioMs: number | null = null
  private prewarmTimer: number | null = null
  private prewarmStarted = false
  private slowRtfStreak = 0
  private slowAiNoticeShown = false
  private lastRtfSynthMs: number | null = null
  private stageTapAbort: AbortController | null = null

  private readonly handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      void this.saveNow()
      this.skipActiveEnglish()
      return
    }
    this.showEnglishSkipNotice()
  }

  private readonly handlePageHide = () => {
    void this.saveNow()
  }

  constructor(options: ReaderControllerOptions) {
    this.options = options
    this.settings = { ...options.settings }
    this.ai = new AiModelManager(this.settings.aiVoiceId)
    this.aiStatus = this.ai.getStatus()
    this.bookLexicon = new BookLexiconService(this.ai, options.book.id)
    this.bookLexicon.setEnabled(this.settings.autoBookPolyphones)
    this.unsubscribeBookLexicon = this.bookLexicon.subscribe((status) => {
      this.options.onBookLexiconStatus?.(status)
    })
    this.mediaSession = new MediaSessionController(
      options.book.title,
      options.book.author,
    )
    this.wakeLock = new ScreenWakeLock(() => {
      if (this.isPlaying) {
        this.options.onToast('系统未允许屏幕常亮，请调高自动锁屏时间。')
      }
    })
    this.mediaSession.bind({
      play: () => this.play(),
      pause: () => this.pause(),
      next: () => this.nextSentence(),
      previous: () => this.previousSentence(),
    })
    document.addEventListener('visibilitychange', this.handleVisibility)
    window.addEventListener('pagehide', this.handlePageHide)
    this.attachStageTaps()
  }

  get canSpeak(): boolean {
    return this.speech.supported || this.aiStatus.supported
  }

  getAiStatus(): AiModelStatus {
    return this.ai.getStatus()
  }

  getBookLexiconStatus(): BookLexiconStatus {
    return this.bookLexicon.getStatus()
  }

  async init(): Promise<ChapterInfo[]> {
    this.session = await createReaderSession(
      this.options.book,
      this.options.container,
      {
        onContentReady: this.handleContentReady,
        onSentenceTap: (index) => this.seekToSentence(index),
        onContentTap: () => this.options.onContentTap?.(),
        onPageSwipe: (direction) => this.turnPage(direction),
        onLinkNavigate: (chapterIndex, anchor) => {
          void this.jumpToChapter(chapterIndex, anchor)
        },
        onExternalLink: (url) => this.openExternal(url),
        onError: (message) => this.options.onToast(message),
        onReflow: this.handleReflow,
      },
    )
    this.session.setStyle(this.settings)

    this.unsubscribeAi = this.ai.subscribe((status) => {
      this.aiStatus = status
      if (status.englishPack?.phase === 'ready') this.englishAiFallback = false
      this.options.onAiStatus?.(status)
      this.emitState()
      this.maybeStartBookLexicon()
      this.schedulePrewarm()
    })

    const [opened] = await Promise.all([
      this.session.open(this.options.book.file),
      this.ai.refresh().catch(() => undefined),
    ])
    this.chapters = opened.chapters

    const saved = this.options.progress
    const initialChapter = clamp(
      saved?.bookId === this.options.book.id ? (saved?.chapterIndex ?? 0) : 0,
      0,
      Math.max(this.chapters.length - 1, 0),
    )
    const initialSentence =
      saved?.bookId === this.options.book.id ? Math.max(0, saved.sentenceIndex) : 0

    this.chapterLoading = true
    this.isLoading = true
    this.emitState()

    let render: ChapterRender
    try {
      render = await this.session.displayChapter(initialChapter)
    } catch (error) {
      this.chapterLoading = false
      this.isLoading = false
      this.emitState()
      throw error
    }

    this.chapterLoading = false
    this.adoptRender(render, {
      target: initialSentence,
      scroll: initialSentence > 0,
      forceScroll: initialSentence > 0,
      behavior: 'auto',
    })
    this.initialized = true
    this.isLoading = false
    this.emitState()
    void this.saveNow()
    this.maybeStartBookLexicon()
    this.schedulePrewarm()

    if (this.options.onVoicesChanged) {
      this.unsubscribeVoices = this.speech.subscribeVoices(this.options.onVoicesChanged)
    }
    if (this.options.onEnglishVoicesChanged) {
      this.unsubscribeEnglishVoices = this.speech.subscribeEnglishVoices(
        this.options.onEnglishVoicesChanged,
      )
    }

    return this.chapters
  }

  getVoices(): VoiceOption[] {
    return this.speech.getVoices()
  }

  getEnglishVoices(): VoiceOption[] {
    return this.speech.getEnglishVoices()
  }

  refreshSystemVoices(): VoiceOption[] {
    return this.speech.refreshVoices()
  }

  refreshEnglishVoices(): VoiceOption[] {
    return this.speech.refreshEnglishVoices()
  }

  previewSystemVoice(voiceURI: string | null): void {
    if (this.destroyed || this.isPlaying) return
    if (!this.speech.supported) {
      this.options.onToast('当前浏览器不支持系统语音试听。')
      return
    }
    const started = this.speech.preview(
      voiceURI,
      '你好，欢迎收听，这是当前系统音色的试听。',
      this.settings.rate,
    )
    if (!started) this.options.onToast('系统音色试听失败，请稍后重试。')
  }

  previewEnglishVoice(voiceURI: string | null): void {
    if (this.destroyed || this.isPlaying) return
    if (!this.speech.supported) {
      this.options.onToast('当前浏览器不支持系统语音试听。')
      return
    }
    const started = this.speech.preview(
      voiceURI,
      'Hello, this is a preview of the English voice.',
      this.settings.rate * this.settings.englishRate,
      'en',
      this.settings.englishVolume,
    )
    if (!started) this.options.onToast('英文音色试听失败，请稍后重试。')
  }

  getDiagnostics(): ReaderDiagnostics {
    const voice = this.ai.getVoice(this.settings.aiVoiceId)
    const stats = this.aiSpeech.stats
    return {
      engine: this.settings.engine,
      activeEngine: this.activeEngine,
      activeLang: this.activeLang,
      voiceLabel: voice?.label ?? '山岚',
      packId: this.aiLoadedPackId,
      aiPhase: this.aiStatus.phase,
      units: this.units.length,
      sentences: this.sentenceCount,
      stats,
      englishStats: this.aiSpeech.englishStats,
      sink: this.aiSpeech.sinkDiagnostics,
      noiseScale: stats?.noiseScale ?? this.settings.labNoiseScale,
      silenceScale: this.settings.labSilenceScale,
    }
  }

  cancelVoicePreview(): void {
    if (!this.isPlaying) this.speech.cancel()
  }

  setSettings(next: ReaderSettings): void {
    const previous = this.settings
    const styleChanged =
      next.theme !== previous.theme || next.fontSize !== previous.fontSize
    const engineChanged = next.engine !== previous.engine
    const rateChanged = next.rate !== previous.rate
    const voiceChanged = next.voiceURI !== previous.voiceURI
    const englishVoiceChanged = next.englishVoiceURI !== previous.englishVoiceURI
    const englishToneChanged =
      next.englishVolume !== previous.englishVolume ||
      next.englishRate !== previous.englishRate
    const aiVoiceChanged = next.aiVoiceId !== previous.aiVoiceId
    const groupingChanged = next.groupSentences !== previous.groupSentences
    const labNoiseChanged = next.labNoiseScale !== previous.labNoiseScale
    const labSilenceChanged = next.labSilenceScale !== previous.labSilenceScale
    const englishAiChanged = next.englishAi !== previous.englishAi

    this.settings = { ...next }
    if (!this.isPlaying && (rateChanged || englishToneChanged)) this.emitState()
    if (styleChanged) this.session?.setStyle(this.settings)
    if (aiVoiceChanged) {
      this.handleAiVoiceChange(previous.aiVoiceId, next.aiVoiceId)
    }
    if (englishAiChanged) {
      this.englishAiFallback = false
      if (!next.englishAi) {
        this.aiSpeech.releaseEnglish()
        this.aiLoadedEnglishPackId = null
      }
    }
    if (next.autoBookPolyphones !== previous.autoBookPolyphones) {
      this.bookLexicon.setEnabled(next.autoBookPolyphones)
    }
    this.maybeStartBookLexicon()

    if (labNoiseChanged) this.releaseAiRuntime()

    if (groupingChanged) {
      this.rebuildUnits()
      this.clearSentenceGap()
      this.clearChunkGap()
      if (!this.pocketActive) {
        this.highlightCurrent({ scroll: true, behavior: 'smooth' })
      }
      this.emitState()
      void this.saveNow()
    }

    if (engineChanged) {
      this.aiFallback = false
      if (next.engine === 'system') {
        this.aiSpeech.cancel()
        this.releaseAiRuntime()
        this.activeEngine = this.isPlaying ? 'system' : null
      } else {
        this.aiSpeech.unlock()
        if (!this.isPlaying) this.speech.cancel()
      }
      if (this.isPlaying) this.speakCurrent()
      return
    }

    if (!this.isPlaying) {
      if (voiceChanged || englishVoiceChanged) this.speech.cancel()
      return
    }

    if (next.engine === 'sherpa') {
      if (
        rateChanged ||
        aiVoiceChanged ||
        groupingChanged ||
        labNoiseChanged ||
        labSilenceChanged ||
        englishVoiceChanged ||
        englishToneChanged ||
        englishAiChanged
      ) {
        this.speakCurrent()
      }
      return
    }

    if (
      rateChanged ||
      voiceChanged ||
      englishVoiceChanged ||
      englishToneChanged ||
      groupingChanged
    ) {
      this.speakCurrent()
    }
  }

  private handleAiVoiceChange(previousId: string, nextId: string): void {
    const nextVoice = this.ai.getVoice(nextId)
    if (!nextVoice) return

    const previousVoice = this.ai.getVoice(previousId)
    this.ai.selectVoice(nextId)
    this.aiFallback = false

    if (
      this.aiSpeech.initialized &&
      previousVoice?.packId === nextVoice.packId
    ) {
      this.aiSpeech.setSpeaker(nextVoice.speakerId)
      this.aiLoadedVoiceId = nextVoice.id
    }

    if (this.isPlaying && this.settings.engine === 'sherpa') {
      this.aiSpeech.cancel()
    }
  }

  prepareAiEngine(): void {
    if (!this.destroyed) this.aiSpeech.unlock()
  }

  async downloadAiModel(packId: string): Promise<void> {
    if (this.destroyed) throw new Error('阅读器已关闭。')
    await this.ai.download(packId)
  }

  async removeAiModel(packId: string): Promise<void> {
    const englishPack =
      this.aiStatus.englishPack?.id === packId
        ? this.aiStatus.englishPack
        : null
    const pack =
      englishPack ?? this.aiStatus.packs.find((item) => item.id === packId)
    if (!pack) throw new Error('找不到要删除的音色包。')
    if (pack.phase === 'downloading') {
      throw new Error('音色包正在下载，请稍后再删除。')
    }

    if (englishPack) {
      if (
        this.isPlaying &&
        this.activeEngine === 'sherpa' &&
        this.activeChunk?.lang === 'en'
      ) {
        this.pause()
      }
      this.aiSpeech.releaseEnglish()
      this.aiLoadedEnglishPackId = null
      this.englishAiFallback = false
      await this.ai.remove(packId)
      return
    }

    const removesSelected = pack.voices.some(
      (voice) => voice.id === this.settings.aiVoiceId,
    )
    const removesLoaded = this.aiLoadedPackId === pack.id
    if (
      this.isPlaying &&
      this.activeEngine === 'sherpa' &&
      (removesSelected || removesLoaded)
    ) {
      this.pause()
    }

    this.aiFallback = false
    if (removesLoaded) this.releaseAiRuntime()
    await this.ai.remove(packId)
  }

  setPocketActive(active: boolean): void {
    if (this.pocketActive === active) return
    this.pocketActive = active

    if (!active && this.sentenceCount > 0) {
      this.highlightCurrent({
        scroll: true,
        behavior: 'smooth',
        forceScroll: true,
      })
    }
  }

  play(): void {
    if (this.destroyed || !this.initialized || this.isPlaying) return

    if (!this.canSpeak) {
      this.options.onToast('当前浏览器不支持语音朗读，请更换浏览器。')
      return
    }

    const wantsAi =
      this.settings.engine === 'sherpa' || !this.speech.supported
    if (wantsAi) this.refreshAiOverlayIfNeeded()
    // iOS only trusts speech synthesis started from this gesture; AI mode
    // speaks English through the system voice long after the tap.
    if (wantsAi) this.speech.unlock()
    if (wantsAi) {
      if (!this.aiStatus.supported) {
        if (!this.speech.supported) {
          this.options.onToast('当前浏览器不支持语音朗读，请更换浏览器。')
          return
        }
        this.aiFallback = true
        this.options.onToast('当前浏览器不支持离线 AI 音色，已使用系统语音。')
      } else if (!this.aiPackReadyForChapter()) {
        if (!this.speech.supported) {
          this.options.onToast('请先在阅读设置中下载离线音色包。')
          return
        }
        this.aiFallback = true
        this.options.onToast('离线音色包尚未就绪，本次使用系统语音。')
      } else {
        this.aiFallback = false
        this.aiSpeech.unlock()
      }
    } else {
      this.aiFallback = false
    }

    if (this.chapterLoading) {
      this.isPlaying = true
      this.isLoading = true
      this.enableWakeLock()
      this.emitState()
      return
    }

    if (this.sentenceCount === 0) {
      if (this.chapterIndex < this.chapters.length - 1) {
        void this.loadChapter(this.chapterIndex + 1, { target: 0, autoplay: true })
      } else {
        this.options.onToast('这一章没有可朗读的文字。')
      }
      return
    }

    this.isPlaying = true
    this.isLoading = true
    this.enableWakeLock()
    this.emitState()
    this.speakCurrent()
  }

  pause(): void {
    if (this.destroyed) return
    this.isPlaying = false
    this.playbackGeneration += 1
    this.clearSentenceGap()
    this.clearChunkGap()
    this.resetActivePlan()
    this.speech.cancel()
    this.aiSpeech.cancel()
    this.activeEngine = null
    this.activeLang = null
    this.isLoading = this.chapterLoading
    this.disableWakeLock()
    this.emitState()
    void this.saveNow()
  }

  toggle(): void {
    if (this.isPlaying) this.pause()
    else this.play()
  }

  nextSentence(): void {
    if (this.destroyed || !this.initialized || this.chapterLoading) return

    const next = this.nextUnit()
    if (next) {
      this.seekToSentence(next.start)
      return
    }

    if (this.chapterIndex < this.chapters.length - 1) {
      void this.loadChapter(this.chapterIndex + 1, {
        target: 0,
        autoplay: this.isPlaying,
      })
      return
    }

    if (this.isPlaying) {
      this.finishBook('已经读完最后一章。')
    } else {
      this.options.onToast('已经是最后一章了。')
    }
  }

  previousSentence(): void {
    if (this.destroyed || !this.initialized || this.chapterLoading) return

    const previous = this.previousUnit()
    if (previous) {
      this.seekToSentence(previous.start)
      return
    }

    if (this.chapterIndex > 0) {
      void this.loadChapter(this.chapterIndex - 1, {
        target: 'end',
        autoplay: this.isPlaying,
      })
      return
    }

    this.options.onToast('已经是第一句了。')
  }

  seekToSentence(index: number): void {
    if (this.destroyed || !this.initialized || !this.highlighter || this.sentenceCount === 0) {
      return
    }

    const target = clamp(index, 0, this.sentenceCount - 1)
    this.setPositionFromSentence(target)
    this.clearSentenceGap()
    this.clearChunkGap()
    this.resetActivePlan()

    if (this.isPlaying) {
      this.speakCurrent()
      return
    }

    this.playbackGeneration += 1
    if (!this.pocketActive) {
      this.highlightCurrent({
        scroll: true,
        behavior: 'smooth',
        forceScroll: true,
      })
    }
    this.emitState()
    void this.saveNow()
  }

  turnPage(direction: 'next' | 'previous'): void {
    if (this.destroyed || !this.initialized || this.chapterLoading || this.isPlaying) {
      return
    }

    const step = direction === 'next' ? 1 : -1
    if (this.highlighter?.pageBy(step)) return

    if (direction === 'next') {
      if (this.chapterIndex < this.chapters.length - 1) {
        void this.loadChapter(this.chapterIndex + 1, {
          target: 0,
          autoplay: false,
        })
      }
      return
    }

    if (this.chapterIndex > 0) {
      void this.loadChapter(this.chapterIndex - 1, {
        target: 'end',
        autoplay: false,
      })
    }
  }

  jumpToChapter(index: number, anchor: string | null = null): void {
    if (
      this.destroyed ||
      !this.initialized ||
      index < 0 ||
      index >= this.chapters.length
    ) {
      return
    }

    if (index === this.chapterIndex) {
      if (anchor) this.session?.scrollToAnchor(anchor)
      return
    }

    void this.loadChapter(index, {
      target: 0,
      anchor,
      autoplay: this.isPlaying,
    })
  }

  saveNow(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.persistProgress()
    return this.progressWriteChain.catch(() => undefined)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.isPlaying = false
    this.playbackGeneration += 1
    this.clearSentenceGap()
    this.clearChunkGap()
    if (this.prewarmTimer !== null) {
      window.clearTimeout(this.prewarmTimer)
      this.prewarmTimer = null
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.persistProgress()

    this.unsubscribeVoices?.()
    this.unsubscribeVoices = null
    this.unsubscribeEnglishVoices?.()
    this.unsubscribeEnglishVoices = null
    this.unsubscribeAi?.()
    this.unsubscribeAi = null
    this.unsubscribeBookLexicon?.()
    this.unsubscribeBookLexicon = null
    this.bookLexicon.dispose()
    this.speech.destroy()
    this.aiSpeech.release()
    this.mediaSession.clear()
    this.wakeLock.destroy()
    this.session?.destroy()
    this.session = null
    this.highlighter = null

    this.stageTapAbort?.abort()
    this.stageTapAbort = null

    document.removeEventListener('visibilitychange', this.handleVisibility)
    window.removeEventListener('pagehide', this.handlePageHide)
  }

  private attachStageTaps(): void {
    const controller = new AbortController()
    this.stageTapAbort = controller
    bindStageTaps(
      this.options.container,
      (clientX, clientY) => {
        if (this.destroyed || !this.initialized || this.chapterLoading) return
        this.session?.tapAt(clientX, clientY)
      },
      controller.signal,
    )
  }

  private async loadChapter(index: number, options: LoadChapterOptions): Promise<boolean> {
    if (
      this.destroyed ||
      !this.session ||
      index < 0 ||
      index >= this.chapters.length
    ) {
      return false
    }

    const token = ++this.chapterToken
    this.playbackGeneration += 1
    this.clearSentenceGap()
    this.clearChunkGap()
    this.resetActivePlan()
    this.speech.cancel()
    this.aiSpeech.cancel()
    // Chapter parsing can take a moment; keep the iOS audio session alive so
    // the next clip is allowed to start once the text is ready. Checked by
    // mode rather than the previous chunk so a chapter ending on a different
    // engine still holds the session.
    if (options.autoplay && this.aiModeActive) {
      this.aiSpeech.keepAlive()
    }
    this.displayInFlight = true
    this.chapterLoading = true
    this.isLoading = true
    this.isPlaying = options.autoplay
    this.emitState()

    if (options.autoplay) this.enableWakeLock()

    try {
      const render = await this.session.displayChapter(index, {
        anchor: options.anchor ?? null,
      })
      if (token !== this.chapterToken || this.destroyed) return false

      this.displayInFlight = false
      this.chapterLoading = false

      const requested =
        options.target === 'end'
          ? render.highlighter.sentences.length - 1
          : (options.target ?? 0)
      const hasAnchor = Boolean(options.anchor)

      this.adoptRender(render, {
        target: requested,
        scroll: !hasAnchor && requested > 0,
        forceScroll: !hasAnchor && requested > 0,
        behavior: 'smooth',
      })
      void this.saveNow()
      if (!options.autoplay) {
        // A jump while paused may land on a chapter that needs the other
        // language runtime; the initial prewarm only covered the old chapter.
        this.prewarmStarted = false
        this.schedulePrewarm()
      }

      if (this.isPlaying) {
        if (this.sentenceCount === 0) {
          const attempt = options.attempt ?? 0
          if (index < this.chapters.length - 1 && attempt < this.chapters.length) {
            this.chapterLoading = true
            return this.loadChapter(index + 1, {
              target: 0,
              autoplay: true,
              attempt: attempt + 1,
            })
          }
          this.finishBook('后面的章节没有可朗读的文字。')
          return false
        }

        this.speakCurrent()
      } else {
        this.isLoading = false
        this.chapterLoading = false
        this.emitState()
      }

      return true
    } catch (error) {
      if (token !== this.chapterToken || this.destroyed) return false

      this.displayInFlight = false
      this.chapterLoading = false
      if (error instanceof Error && error.name === 'AbortError') return false

      this.aiSpeech.cancel()
      this.isPlaying = false
      this.isLoading = false
      this.disableWakeLock()
      this.options.onToast(
        error instanceof Error ? error.message : '章节加载失败，请重试。',
      )
      this.emitState()
      return false
    }
  }

  private adoptRender(
    render: ChapterRender,
    options: {
      target: number
      scroll: boolean
      forceScroll: boolean
      behavior: ScrollBehavior
    },
  ): void {
    this.highlighter = render.highlighter
    this.chapterIndex = render.chapter.index
    this.chapterLabel = render.chapter.label
    this.sentenceCount = render.highlighter.sentences.length
    this.rebuildUnits()
    if (this.sentenceCount > 0) {
      this.setPositionFromSentence(
        clamp(options.target, 0, this.sentenceCount - 1),
      )
    } else {
      this.sentenceIndex = 0
      this.sentenceEndIndex = 0
    }

    if (this.sentenceCount > 0 && !this.pocketActive) {
      this.highlightCurrent({
        scroll: options.scroll,
        forceScroll: options.forceScroll,
        behavior: options.behavior,
      })
    }
  }

  private rebuildUnits(): void {
    this.units = buildSpeechUnits(this.highlighter?.sentences ?? [], {
      enabled: this.settings.groupSentences,
    })
    if (this.units.length === 0) {
      this.sentenceIndex = 0
      this.sentenceEndIndex = 0
      return
    }
    this.setPositionFromSentence(this.sentenceIndex)
  }

  private setPositionFromSentence(index: number): void {
    if (this.units.length === 0 || this.sentenceCount === 0) {
      this.sentenceIndex = 0
      this.sentenceEndIndex = 0
      return
    }

    const target = clamp(index, 0, this.sentenceCount - 1)
    let low = 0
    let high = this.units.length - 1
    let found = this.units[high]!

    while (low <= high) {
      const middle = (low + high) >> 1
      const unit = this.units[middle]!
      if (target < unit.start) high = middle - 1
      else if (target > unit.end) low = middle + 1
      else {
        found = unit
        break
      }
    }

    this.sentenceIndex = found.start
    this.sentenceEndIndex = found.end
  }

  private unitPosition(): number {
    return this.units.findIndex((unit) => unit.start === this.sentenceIndex)
  }

  private currentUnit(): SpeechUnit | null {
    const position = this.unitPosition()
    return position >= 0 ? (this.units[position] ?? null) : null
  }

  private nextUnit(): SpeechUnit | null {
    const position = this.unitPosition()
    return position >= 0 ? (this.units[position + 1] ?? null) : null
  }

  private previousUnit(): SpeechUnit | null {
    const position = this.unitPosition()
    return position > 0 ? (this.units[position - 1] ?? null) : null
  }

  private highlightCurrent(options: HighlightOptions = {}): void {
    const unit = this.currentUnit()
    if (!unit) return
    this.highlighter?.setActiveRange(unit.start, unit.end, options)
  }

  private speakCurrent(): void {
    if (!this.isPlaying || this.destroyed) return

    const unit = this.currentUnit()
    if (!unit) {
      void this.advanceAfterSentenceEnd()
      return
    }

    const useAi =
      (this.settings.engine === 'sherpa' || !this.speech.supported) &&
      !this.aiFallback
    const segments = splitLanguageSegments(unit.speechText)
    const plan = this.buildSpeechPlan(
      segments.length ? segments : [{ text: unit.speechText, lang: 'zh' }],
      useAi,
    )
    const hasAiChunks = plan.some((chunk) => chunk.engine === 'ai')
    this.activeEngine = hasAiChunks ? 'sherpa' : 'system'
    this.activeLang = plan[0]?.lang ?? null

    const generation = ++this.playbackGeneration
    this.clearSentenceGap()
    this.clearChunkGap()
    this.resetActivePlan()
    this.isLoading = true

    if (!this.pocketActive) {
      this.highlightCurrent({
        scroll: this.settings.autoScroll,
        behavior: 'smooth',
      })
    }

    if (useAi) this.speech.cancelActive()
    else this.aiSpeech.cancel()

    if (useAi) this.warmEnglishIfNeeded(plan, unit.speechText)
    this.scheduleProgressSave()
    this.emitState()

    if (hasAiChunks) {
      void this.speakWithAi(plan, generation)
    } else {
      this.runSpeechPlan(plan, 0, generation)
    }
  }

  private buildSpeechPlan(
    segments: LanguageSegment[],
    useAi: boolean,
  ): SpeechChunk[] {
    const plan = this.prepareSpeechChunks(segments, useAi)

    for (let i = 0; i < plan.length; i += 1) {
      const chunk = plan[i]!
      if (chunk.engine !== 'ai') continue
      // Each runtime slot only accepts its own language, so prefetching is
      // planned per language.
      const upcoming = plan
        .slice(i + 1)
        .filter((item) => item.engine === 'ai' && item.lang === chunk.lang)
        .map((item) => item.text)
      const tail = this.upcomingAiTexts(
        useAi,
        chunk.lang,
        PREFETCH_CHUNKS - upcoming.length,
      )
      chunk.nextTexts = [...upcoming, ...tail].slice(0, PREFETCH_CHUNKS)
    }

    return plan
  }

  private prepareSpeechChunks(
    segments: LanguageSegment[],
    useAi: boolean,
  ): SpeechChunk[] {
    const englishAi =
      this.settings.englishAi &&
      !this.englishAiFallback &&
      this.englishPackReady()

    const plan: SpeechChunk[] = segments.map((segment) => ({
      ...segment,
      engine:
        useAi && (segment.lang === 'zh' || englishAi || !this.speech.supported)
          ? 'ai'
          : 'system',
      nextTexts: [],
    }))

    for (let i = 0; i < plan.length; i += 1) {
      const chunk = plan[i]!
      if (chunk.engine === 'ai') {
        if (chunk.lang === 'zh') {
          // Matcha voices any space it receives as a separate "a"-like
          // syllable, so a Chinese run must not carry the gaps left by source
          // markup.
          chunk.text = chunk.text.replace(/\s+/g, '')
        } else {
          chunk.text = normalizeEnglishSpeech(chunk.text)
        }
        chunk.text = ensureSpeechEnd(chunk.text, i === plan.length - 1, chunk.lang)
      }
    }
    return plan
  }

  private upcomingAiTexts(
    useAi: boolean,
    lang: 'zh' | 'en',
    limit: number,
  ): string[] {
    const texts: string[] = []
    if (limit <= 0) return texts

    const position = this.units.findIndex(
      (unit) => unit.start === this.sentenceIndex,
    )
    const from = position >= 0 ? position + 1 : this.units.length

    for (
      let i = from;
      i < this.units.length && texts.length < limit && i < from + 4;
      i += 1
    ) {
      const unit = this.units[i]!
      const segments = splitLanguageSegments(unit.speechText)
      const plan = this.prepareSpeechChunks(
        segments.length ? segments : [{ text: unit.speechText, lang: 'zh' }],
        useAi,
      )
      for (const chunk of plan) {
        if (chunk.engine !== 'ai' || chunk.lang !== lang) continue
        if (texts.includes(chunk.text)) continue
        texts.push(chunk.text)
        if (texts.length >= limit) break
      }
    }

    return texts
  }

  private async speakWithAi(
    plan: SpeechChunk[],
    generation: number,
  ): Promise<void> {
    const needsChinese = plan.some(
      (chunk) => chunk.engine === 'ai' && chunk.lang === 'zh',
    )
    const needsEnglish = plan.some(
      (chunk) => chunk.engine === 'ai' && chunk.lang === 'en',
    )

    try {
      if (needsChinese) await this.ensureAiReady()
      if (
        generation !== this.playbackGeneration ||
        !this.isPlaying ||
        this.destroyed
      ) {
        return
      }

      if (needsEnglish) {
        try {
          await this.ensureEnglishAiReady()
        } catch (error) {
          if (
            generation !== this.playbackGeneration ||
            !this.isPlaying ||
            this.destroyed
          ) {
            return
          }
          if (this.speech.supported) {
            // The rest of the book can still play; only English needs the
            // system voice fallback.
            this.englishAiFallback = true
            this.options.onToast('英文离线音色不可用，已改用系统英文音色。')
            this.speakCurrent()
            return
          }
          throw error
        }
        if (
          generation !== this.playbackGeneration ||
          !this.isPlaying ||
          this.destroyed
        ) {
          return
        }
      }

      this.runSpeechPlan(plan, 0, generation)
    } catch (error) {
      if (
        generation !== this.playbackGeneration ||
        !this.isPlaying ||
        this.destroyed
      ) {
        return
      }
      this.fallbackFromAi(
        error instanceof Error && error.message
          ? error.message
          : '离线音色启动失败。',
      )
    }
  }

  private runSpeechPlan(
    plan: SpeechChunk[],
    index: number,
    generation: number,
  ): void {
    if (generation !== this.playbackGeneration || !this.isPlaying || this.destroyed) {
      return
    }
    if (index >= plan.length) {
      this.handleSentenceEnd()
      return
    }

    const chunk = plan[index]!
    if (this.shouldSkipChunk(chunk)) {
      this.englishSkipped += 1
      this.runSpeechPlan(plan, index + 1, generation)
      return
    }

    // Switching between the offline model and the system voice (or between
    // Chinese and English) otherwise butts the two audio clips together.
    let previous: SpeechChunk | null = null
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = plan[i]!
      if (this.shouldSkipChunk(candidate)) continue
      previous = candidate
      break
    }
    const needsTransition =
      previous !== null &&
      (previous.engine !== chunk.engine || previous.lang !== chunk.lang)

    const start = () => {
      if (
        generation !== this.playbackGeneration ||
        !this.isPlaying ||
        this.destroyed
      ) {
        return
      }
      // Visibility can change during the 70ms transition wait.
      if (this.shouldSkipChunk(chunk)) {
        this.englishSkipped += 1
        this.runSpeechPlan(plan, index + 1, generation)
        return
      }

      this.activePlan = plan
      this.activePlanIndex = index
      this.activePlanGeneration = generation
      this.activeChunk = chunk
      this.activeLang = chunk.lang

      const advance = () => this.runSpeechPlan(plan, index + 1, generation)
      const onStart = () => {
        if (generation !== this.playbackGeneration || !this.isPlaying) return
        if (chunk.engine === 'ai') this.noteAiSpeed(chunk.lang)
        this.isLoading = false
        this.emitState()
      }

      if (chunk.engine === 'ai') {
        this.aiSpeech.speak(
          {
            text: chunk.text,
            rate:
              chunk.lang === 'en'
                ? this.settings.rate * this.settings.englishRate
                : this.settings.rate,
            silenceScale: this.settings.labSilenceScale,
            nextTexts: chunk.nextTexts,
            lang: chunk.lang,
            volume:
              chunk.lang === 'en' ? this.settings.englishVolume : 1,
          },
          {
            onStart,
            onEnd: () => {
              if (generation !== this.playbackGeneration || !this.isPlaying) return
              advance()
            },
            onError: (message) => {
              if (generation !== this.playbackGeneration) return
              this.fallbackFromAi(message)
            },
          },
        )
        return
      }

      if (
        chunk.lang === 'en' &&
        !this.englishVoiceNoticeShown &&
        this.speech.voiceCount > 0 &&
        !this.speech.hasEnglishVoice()
      ) {
        this.englishVoiceNoticeShown = true
        this.options.onToast(
          '未检测到可用的英文系统音色，英文部分可能无声或音色异常；请在系统设置中安装英文语音。',
        )
      }

      this.speech.speak(
        {
          text: chunk.text,
          rate:
            chunk.lang === 'en'
              ? this.settings.rate * this.settings.englishRate
              : this.settings.rate,
          voiceURI:
            chunk.lang === 'en'
              ? this.settings.englishVoiceURI
              : this.settings.voiceURI,
          lang: chunk.lang,
          volume:
            chunk.lang === 'en' ? this.settings.englishVolume : 1,
        },
        {
          onStart,
          onEnd: () => {
            if (generation !== this.playbackGeneration || !this.isPlaying) return
            advance()
          },
          onError: (message) => {
            if (generation !== this.playbackGeneration) return
            this.stopForError(message)
          },
        },
      )
    }

    if (!needsTransition) {
      start()
      return
    }

    this.clearChunkGap()
    this.chunkGapTimer = window.setTimeout(() => {
      this.chunkGapTimer = null
      start()
    }, 70)
  }

  private stopForError(message: string): void {
    this.clearSentenceGap()
    this.clearChunkGap()
    this.resetActivePlan()
    this.isPlaying = false
    this.isLoading = false
    this.disableWakeLock()
    void this.saveNow()
    this.options.onToast(message)
    this.emitState()
  }

  private maybeStartBookLexicon(): void {
    if (this.destroyed || !this.initialized) return
    this.bookLexicon.setEnabled(this.settings.autoBookPolyphones)
    if (!this.settings.autoBookPolyphones) return
    // Generate the overlay even while the system engine is selected: the
    // reader usually opens well before the first tap on AI playback, and this
    // keeps the first sentence from waiting on pronunciation analysis.
    const voice = this.ai.getVoice(this.settings.aiVoiceId)
    if (!voice) return
    const pack = this.aiStatus.packs.find((item) => item.id === voice.packId)
    if (!pack || pack.phase !== 'ready') return
    this.bookLexicon.start(this.settings.aiVoiceId, (signal) =>
      this.collectBookText(signal),
    )
  }

  /**
   * After the chapter is on screen, quietly initialise the offline voice so the
   * first tap on play does not pay the multi-second model load. Best effort:
   * failures stay silent and playback reports real errors later.
   */
  private schedulePrewarm(): void {
    if (
      this.destroyed ||
      !this.initialized ||
      this.prewarmStarted ||
      this.prewarmTimer !== null
    ) {
      return
    }
    if (!this.aiStatus.supported) return

    const voice = this.ai.getVoice(this.settings.aiVoiceId)
    const pack = voice
      ? this.aiStatus.packs.find((item) => item.id === voice.packId)
      : null
    const chineseReady = pack?.phase === 'ready'
    const englishReady = this.englishPackReady()
    if (!chineseReady && !englishReady) return
    if (!canPrewarmAi(readPrewarmEnvironment())) return

    this.prewarmStarted = true
    this.prewarmTimer = window.setTimeout(() => {
      this.prewarmTimer = null
      void this.prewarmAi()
    }, PREWARM_DELAY_MS)
  }

  private async prewarmAi(): Promise<void> {
    if (this.destroyed || this.isPlaying) return

    const mostlyEnglish = this.chapterMostlyEnglish()
    const needChinese =
      !this.aiSpeech.initialized &&
      !mostlyEnglish &&
      this.aiStatus.phase === 'ready'
    const needEnglish =
      this.settings.englishAi &&
      !this.aiSpeech.englishInitialized &&
      this.englishPackReady() &&
      this.chapterHasEnglish()

    if (!needChinese && !needEnglish) return
    const generation = this.playbackGeneration

    try {
      await this.bookLexicon.waitForOverlay(8000)
      if (
        this.destroyed ||
        this.isPlaying ||
        generation !== this.playbackGeneration
      ) {
        return
      }
      if (needChinese) await this.ensureAiReady()
      if (
        this.destroyed ||
        this.isPlaying ||
        generation !== this.playbackGeneration
      ) {
        return
      }
      if (needEnglish) await this.ensureEnglishAiReady()
      if (this.destroyed) this.releaseAiRuntime()
    } catch {
      // Prewarming is best effort; a later play() retries with real feedback.
    }
  }

  private noteAiSpeed(lang: 'zh' | 'en'): void {
    if (this.slowAiNoticeShown) return
    const stats =
      lang === 'en' ? this.aiSpeech.englishStats : this.aiSpeech.stats
    if (
      !stats ||
      stats.lastSynthMs === null ||
      stats.lastRtf === null ||
      stats.lastSynthMs === this.lastRtfSynthMs
    ) {
      return
    }
    this.lastRtfSynthMs = stats.lastSynthMs

    if (stats.lastRtf > SLOW_RTF_THRESHOLD) this.slowRtfStreak += 1
    else this.slowRtfStreak = 0
    if (this.slowRtfStreak < SLOW_RTF_STREAK) return

    this.slowAiNoticeShown = true
    const hint = this.speech.supported
      ? '可切换到系统语音，或关闭「连读模式」缩短等待。'
      : '可关闭「连读模式」缩短等待。'
    this.options.onToast(`离线音色合成速度偏慢，播放可能出现停顿；${hint}`)
  }

  private collectBookText(signal: AbortSignal): Promise<string[]> {
    const session = this.session
    if (!session) return Promise.resolve([])
    return session.collectPlainText(signal)
  }

  private async ensureAiReady(): Promise<void> {
    if (!this.aiStatus.supported) {
      throw new Error('当前浏览器不支持离线 AI 音色。')
    }
    const targetVoice = this.settings.aiVoiceId
    if (this.aiSpeech.initialized && this.aiLoadedVoiceId === targetVoice) return

    if (this.aiInitPromise) {
      try {
        await this.aiInitPromise
      } catch {
        // Retry below with the currently selected voice.
      }
      if (this.aiSpeech.initialized && this.aiLoadedVoiceId === targetVoice) {
        return
      }
    }

    const task = (async () => {
      const overlay = this.settings.autoBookPolyphones
        ? await this.bookLexicon.waitForOverlay(5000)
        : ''
      const pack = await this.ai.loadPack(
        this.settings.aiVoiceId,
        overlay || undefined,
      )
      if (this.settings.labNoiseScale !== null) {
        pack.model = {
          ...pack.model,
          config: {
            ...pack.model.config,
            noiseScale: this.settings.labNoiseScale,
          },
        }
      }
      this.aiSpeech.unlock()
      await this.aiSpeech.init(pack)
      this.aiLoadedPackId = pack.packId
      this.aiLoadedVoiceId = pack.voiceId
      this.aiLoadedOverlay = overlay
    })()
    this.aiInitPromise = task
    try {
      await task
    } finally {
      if (this.aiInitPromise === task) this.aiInitPromise = null
    }
  }

  private async ensureEnglishAiReady(): Promise<void> {
    if (!this.aiStatus.supported) {
      throw new Error('当前浏览器不支持离线 AI 音色。')
    }
    if (!this.settings.englishAi) {
      throw new Error('英文离线音色未启用。')
    }
    const voice = this.ai.getEnglishVoice()
    if (!voice) {
      throw new Error('尚未下载英文离线音色包。')
    }
    if (
      this.aiSpeech.englishInitialized &&
      this.aiLoadedEnglishPackId === voice.packId
    ) {
      return
    }

    if (this.englishAiInitPromise) {
      try {
        await this.englishAiInitPromise
      } catch {
        // Retry below with the currently selected pack.
      }
      if (
        this.aiSpeech.englishInitialized &&
        this.aiLoadedEnglishPackId === voice.packId
      ) {
        return
      }
    }

    const task = (async () => {
      const pack = await this.ai.loadPack(voice.id)
      if (this.settings.labNoiseScale !== null) {
        pack.model = {
          ...pack.model,
          config: {
            ...pack.model.config,
            noiseScale: this.settings.labNoiseScale,
          },
        }
      }
      this.aiSpeech.unlock()
      await this.aiSpeech.initEnglish(pack)
      this.aiLoadedEnglishPackId = pack.packId
    })()
    this.englishAiInitPromise = task
    try {
      await task
    } finally {
      if (this.englishAiInitPromise === task) this.englishAiInitPromise = null
    }
  }

  private englishPackReady(): boolean {
    const pack = this.aiStatus.englishPack
    return Boolean(pack && pack.phase === 'ready' && pack.voices.length > 0)
  }

  /**
   * A pure-English chapter only needs the English runtime; loading the Chinese
   * model as well would waste time and memory.
   */
  private aiPackReadyForChapter(): boolean {
    if (this.aiStatus.phase === 'ready') return true
    return (
      this.settings.englishAi &&
      this.englishPackReady() &&
      this.chapterMostlyEnglish()
    )
  }

  private countChapterLetters(): { han: number; latin: number } {
    let han = 0
    let latin = 0
    for (const unit of this.units.slice(0, 200)) {
      han += countMatches(unit.speechText, HAN_LETTER)
      latin += countMatches(unit.speechText, LATIN_LETTER)
    }
    return { han, latin }
  }

  private chapterMostlyEnglish(): boolean {
    const { han, latin } = this.countChapterLetters()
    return latin >= 200 && latin > han * 2
  }

  private chapterHasEnglish(): boolean {
    return this.countChapterLetters().latin >= 200
  }

  private warmEnglishIfNeeded(plan: SpeechChunk[], text: string): void {
    if (!this.isPlaying || this.destroyed) return
    if (!this.settings.englishAi || !this.englishPackReady()) return
    if (this.aiSpeech.englishInitialized || this.englishAiFallback) return
    if (!plan.some((chunk) => chunk.lang === 'en')) return
    if (countMatches(text, LATIN_LETTER) < 30) return
    void this.ensureEnglishAiReady().catch(() => undefined)
  }

  /**
   * The first overlay run can outlast the wait in ensureAiReady. Rather than
   * reload the engine mid-sentence, pick the overlay up on the next play:
   * releasing here is silent because play() has not started audio yet.
   */
  private refreshAiOverlayIfNeeded(): void {
    if (!this.aiSpeech.initialized) return
    const overlay = this.bookLexicon.getOverlay()
    if (!overlay || overlay === this.aiLoadedOverlay) return
    this.releaseAiRuntime()
  }

  private releaseAiRuntime(): void {
    this.aiInitPromise = null
    this.englishAiInitPromise = null
    this.aiSpeech.release()
    this.aiLoadedPackId = null
    this.aiLoadedVoiceId = null
    this.aiLoadedOverlay = ''
    this.aiLoadedEnglishPackId = null
    this.englishAiFallback = false
  }

  private fallbackFromAi(reason: string): void {
    if (this.destroyed) return
    this.aiFallback = true
    this.releaseAiRuntime()
    const notice = /[。！？!?]$/.test(reason) ? reason : `${reason}。`

    if (!this.speech.supported) {
      this.isPlaying = false
      this.isLoading = false
      this.activeEngine = null
      this.activeLang = null
      this.disableWakeLock()
      void this.saveNow()
      this.options.onToast(`${notice}当前浏览器也不支持系统语音。`)
      this.emitState()
      return
    }

    this.options.onToast(`${notice}已切换为系统语音。`)
    this.speakCurrent()
  }

  private handleSentenceEnd(): void {
    if (!this.isPlaying || this.destroyed) return
    if (this.sentenceGapTimer !== null || this.sentenceGapActive) return

    this.resetActivePlan()
    const unit = this.currentUnit()
    const gap = unit
      ? sentenceGapMs(unit.text, {
          paragraphEnd: unit.paragraphEnd,
          rate: this.settings.rate,
          grouped: this.settings.groupSentences,
          scale: PAUSE_PRESET_SCALES[this.settings.pausePreset],
        })
      : 0
    if (gap <= 0) {
      this.advanceToNextSentence()
      return
    }

    const generation = this.playbackGeneration
    const useSink =
      this.aiModeActive &&
      this.aiSpeech.playGap(gap, () => {
        if (!this.isPlaying || generation !== this.playbackGeneration) return
        this.sentenceGapActive = false
        this.advanceToNextSentence()
      })
    if (useSink) {
      this.sentenceGapActive = true
      return
    }

    this.sentenceGapTimer = window.setTimeout(() => {
      this.sentenceGapTimer = null
      this.advanceToNextSentence()
    }, gap)
  }

  private advanceToNextSentence(): void {
    if (!this.isPlaying || this.destroyed) return
    const next = this.nextUnit()
    if (next) {
      this.sentenceIndex = next.start
      this.sentenceEndIndex = next.end
      this.speakCurrent()
      return
    }
    void this.advanceAfterSentenceEnd()
  }

  private clearSentenceGap(): void {
    if (this.sentenceGapTimer !== null) {
      window.clearTimeout(this.sentenceGapTimer)
      this.sentenceGapTimer = null
    }
    if (this.sentenceGapActive) {
      this.sentenceGapActive = false
      this.aiSpeech.stopGap()
    }
  }

  private clearChunkGap(): void {
    if (this.chunkGapTimer !== null) {
      window.clearTimeout(this.chunkGapTimer)
      this.chunkGapTimer = null
    }
  }

  private get aiModeActive(): boolean {
    return (
      (this.settings.engine === 'sherpa' || !this.speech.supported) &&
      !this.aiFallback
    )
  }

  private resetActivePlan(): void {
    this.activePlan = null
    this.activePlanIndex = 0
    this.activePlanGeneration = 0
    this.activeChunk = null
  }

  private shouldSkipChunk(chunk: SpeechChunk): boolean {
    return shouldSkipEnglishChunk(chunk, {
      enabled: this.settings.skipEnglishWhenLocked,
      aiMode: this.aiModeActive,
      hidden: document.visibilityState === 'hidden',
      ios: this.iosDevice,
    })
  }

  /**
   * Locks the screen while an English chunk is playing through the system
   * voice: iOS suspends it, so move on to the next chunk instead of waiting
   * for a watchdog.
   */
  private skipActiveEnglish(): void {
    if (!this.isPlaying || this.destroyed) return
    const plan = this.activePlan
    const chunk = this.activeChunk
    if (!plan || !chunk) return
    if (!this.shouldSkipChunk(chunk)) return
    if (!this.speech.speaking) return
    const generation = this.activePlanGeneration
    if (generation !== this.playbackGeneration) return

    this.speech.cancel()
    this.englishSkipped += 1
    this.runSpeechPlan(plan, this.activePlanIndex + 1, generation)
  }

  private showEnglishSkipNotice(): void {
    if (this.englishSkipped === 0 || this.englishSkipNoticed) return
    this.englishSkipNoticed = true
    this.options.onToast(
      `锁屏期间跳过了 ${this.englishSkipped} 段英文；可在阅读设置中关闭「锁屏跳过英文」。`,
    )
  }

  private async advanceAfterSentenceEnd(): Promise<void> {
    if (this.chapterIndex < this.chapters.length - 1) {
      await this.loadChapter(this.chapterIndex + 1, { target: 0, autoplay: true })
      return
    }
    this.finishBook('已经读完最后一章。')
  }

  private finishBook(message?: string): void {
    this.clearSentenceGap()
    this.clearChunkGap()
    this.resetActivePlan()
    this.isPlaying = false
    this.isLoading = false
    this.chapterLoading = false
    this.activeEngine = null
    this.activeLang = null
    this.playbackGeneration += 1
    this.speech.cancel()
    this.aiSpeech.cancel()
    this.disableWakeLock()
    void this.saveNow()
    if (message) this.options.onToast(message)
    this.emitState()
  }

  private readonly handleContentReady = (result: ChapterRender): void => {
    if (!this.initialized || this.displayInFlight || this.destroyed) return
    if (result.chapter.index !== this.chapterIndex) return

    this.highlighter = result.highlighter
    this.sentenceCount = result.highlighter.sentences.length
    this.rebuildUnits()
    if (this.sentenceCount > 0) {
      this.setPositionFromSentence(
        clamp(this.sentenceIndex, 0, this.sentenceCount - 1),
      )
    }

    if (!this.pocketActive && this.sentenceCount > 0) {
      this.highlightCurrent({ scroll: false })
    }
    this.emitState()
  }

  private readonly handleReflow = (): void => {
    if (this.destroyed || !this.initialized || this.pocketActive) return
    if (this.sentenceCount === 0) return
    this.highlightCurrent({
      scroll: this.settings.autoScroll,
      behavior: 'smooth',
    })
  }

  private openExternal(url: string): void {
    if (this.options.onExternalLink) {
      this.options.onExternalLink(url)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  private enableWakeLock(): void {
    if (!this.wakeLock.supported && !this.wakeLockNoticeShown) {
      this.wakeLockNoticeShown = true
      this.options.onToast('当前浏览器不支持屏幕常亮，建议调高自动锁屏时间。')
    }
    void this.wakeLock.setEnabled(true)
  }

  private disableWakeLock(): void {
    void this.wakeLock.setEnabled(false)
  }

  private scheduleProgressSave(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      this.persistProgress()
    }, 1200)
  }

  private persistProgress(): void {
    if (!this.initialized || this.chapterIndex < 0) return

    const totalChapters = Math.max(this.chapters.length, 1)
    const sentencePart =
      this.sentenceCount > 0
        ? Math.min(1, (this.sentenceEndIndex + 1) / this.sentenceCount)
        : 0
    const progress: StoredProgress = {
      bookId: this.options.book.id,
      chapterIndex: this.chapterIndex,
      chapterLabel: this.chapterLabel,
      sentenceIndex: this.sentenceIndex,
      sentenceCount: this.sentenceCount,
      percent: Math.min(1, (this.chapterIndex + sentencePart) / totalChapters),
      updatedAt: Date.now(),
    }

    this.progressWriteChain = this.progressWriteChain
      .catch(() => undefined)
      .then(() => saveProgress(progress))
      .catch(() => {
        if (this.progressErrorShown) return
        this.progressErrorShown = true
        this.options.onToast('阅读进度保存失败，请检查浏览器的存储空间。')
      })
  }

  private emitState(): void {
    if (this.destroyed) return
    this.sampleSpeechRate()
    this.options.onState({
      isPlaying: this.isPlaying,
      isLoading: this.isLoading,
      sentenceIndex: this.sentenceIndex,
      sentenceEndIndex: this.sentenceEndIndex,
      sentenceCount: this.sentenceCount,
      remainingMs: this.estimateRemaining(),
      chapterIndex: this.chapterIndex,
      chapterLabel: this.chapterLabel,
      chapterCount: this.chapters.length,
      canSpeak: this.canSpeak,
      activeEngine: this.activeEngine,
      activeLang: this.activeLang,
    })
    this.mediaSession.update(this.chapterLabel, this.isPlaying)
  }

  private sampleSpeechRate(): void {
    const stats = this.aiSpeech.stats
    if (!stats?.lastAudioMs || stats.lastAudioMs === this.lastSampledAudioMs) {
      return
    }
    this.lastSampledAudioMs = stats.lastAudioMs
    const sample = stats.lastAudioMsPerChar
    if (!sample || !Number.isFinite(sample)) return
    this.measuredZhMsPerChar =
      this.measuredZhMsPerChar === null
        ? sample
        : this.measuredZhMsPerChar * 0.7 + sample * 0.3
  }

  private estimateRemaining(): number | null {
    if (!this.units.length) return null
    const position = this.unitPosition()
    if (position < 0) return null
    return estimateRemainingMs(this.units, position, {
      rate: this.settings.rate,
      englishRate: this.settings.englishRate,
      zhMsPerChar: this.measuredZhMsPerChar,
      grouped: this.settings.groupSentences,
      pauseScale: PAUSE_PRESET_SCALES[this.settings.pausePreset],
    })
  }
}
