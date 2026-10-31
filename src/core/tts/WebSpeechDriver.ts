import type { VoiceOption } from '@/types'
import {
  compareEnglishVoices,
  compareSystemVoices,
  detectVoiceQuality,
  isChineseVoice,
  isEnglishVoice,
  isNoveltyVoice,
  normalizeVoiceLang,
} from './systemVoice'

export interface SpeakOptions {
  text: string
  rate: number
  voiceURI: string | null
  lang?: 'zh' | 'en'
  /** 0–1; values above 1 are clamped by the speech API. */
  volume?: number
}

export interface SpeakHandlers {
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

function errorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
      return '浏览器阻止了语音播放，请点按播放按钮重试。'
    case 'audio-busy':
    case 'audio-hardware':
      return '系统语音暂时不可用，请稍后重试。'
    case 'voice-unavailable':
      return '当前选择的语音不可用，请在设置里更换。'
    case 'network':
      return '系统语音需要网络，请检查连接后重试。'
    default:
      return '系统语音启动失败，请稍后重试。'
  }
}

const START_DELAY_MS = 40

function clampVolume(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

interface ListedVoice {
  raw: SpeechSynthesisVoice
  option: VoiceOption
}

export class WebSpeechDriver {
  readonly supported: boolean

  private readonly synth: SpeechSynthesis | null = null
  private utterance: SpeechSynthesisUtterance | null = null
  private warmup: SpeechSynthesisUtterance | null = null
  private warmupTimer: number | null = null
  private unlockedOnce = false
  private generation = 0
  private startTimer: number | null = null
  private watchdog: number | null = null
  private voiceListeners = new Set<(voices: VoiceOption[]) => void>()
  private englishVoiceListeners = new Set<(voices: VoiceOption[]) => void>()
  private readonly handleVoicesChanged = () => this.emitVoices()

  constructor() {
    this.supported =
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined'

    if (this.supported) {
      this.synth = window.speechSynthesis
      this.synth.addEventListener?.('voiceschanged', this.handleVoicesChanged)
    }
  }

  subscribeVoices(listener: (voices: VoiceOption[]) => void): () => void {
    this.voiceListeners.add(listener)
    listener(this.getVoices())
    return () => this.voiceListeners.delete(listener)
  }

  subscribeEnglishVoices(listener: (voices: VoiceOption[]) => void): () => void {
    this.englishVoiceListeners.add(listener)
    listener(this.getEnglishVoices())
    return () => this.englishVoiceListeners.delete(listener)
  }

  getVoices(): VoiceOption[] {
    return this.listVoices().map((item) => item.option)
  }

  getEnglishVoices(): VoiceOption[] {
    return this.listVoices('en').map((item) => item.option)
  }

  get voiceCount(): number {
    if (!this.synth) return 0
    try {
      return this.synth.getVoices().length
    } catch {
      return 0
    }
  }

  get speaking(): boolean {
    return this.utterance !== null
  }

  hasEnglishVoice(): boolean {
    return this.listVoices('en').length > 0
  }

  /**
   * Must run synchronously inside a user gesture. iOS only allows the first
   * speechSynthesis.speak() from a gesture, while English chunks in AI mode
   * are spoken minutes after the tap and would otherwise stay silent. The
   * unlock survives synth.cancel(); warming again on every resume would only
   * restart the speech session right as the AI clip begins to play.
   */
  unlock(): void {
    if (!this.synth || this.warmup || this.unlockedOnce) return
    try {
      this.synth.resume()
      const utterance = new SpeechSynthesisUtterance(' ')
      utterance.lang = 'zh-CN'
      utterance.volume = 0
      utterance.rate = 10
      utterance.onend = () => this.releaseWarmup(utterance)
      utterance.onerror = (event) => {
        if (event.error === 'not-allowed') this.unlockedOnce = false
        this.releaseWarmup(utterance)
      }
      this.warmup = utterance
      this.warmupTimer = window.setTimeout(
        () => this.releaseWarmup(utterance),
        1000,
      )
      this.unlockedOnce = true
      this.synth.speak(utterance)
    } catch {
      this.unlockedOnce = false
      this.clearWarmup()
    }
  }

  cancelActive(): void {
    if (this.utterance) this.cancel()
  }

  refreshVoices(): VoiceOption[] {
    this.emitVoices()
    return this.getVoices()
  }

  refreshEnglishVoices(): VoiceOption[] {
    const voices = this.getEnglishVoices()
    for (const listener of this.englishVoiceListeners) listener(voices)
    return voices
  }

  preview(
    voiceURI: string | null,
    text: string,
    rate = 1,
    lang: 'zh' | 'en' = 'zh',
    volume = 1,
  ): boolean {
    if (!this.synth) return false
    if (this.utterance) this.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = Math.min(2, Math.max(0.5, rate))
    utterance.pitch = 1
    utterance.volume = clampVolume(volume)

    const voice = this.resolveVoice(voiceURI, lang)
    if (voice) {
      utterance.voice = voice
      utterance.lang = normalizeVoiceLang(voice.lang)
    } else {
      utterance.lang = lang === 'en' ? 'en-US' : 'zh-CN'
    }
    this.utterance = utterance
    const release = () => {
      if (this.utterance === utterance) this.utterance = null
    }
    utterance.onend = release
    utterance.onerror = release

    try {
      this.synth.resume()
      this.synth.speak(utterance)
    } catch {
      release()
      return false
    }
    return true
  }

  speak(options: SpeakOptions, handlers: SpeakHandlers): void {
    if (!this.synth) {
      handlers.onError?.('当前浏览器不支持系统语音朗读。')
      return
    }

    this.cancel()
    const generation = this.generation
    const utterance = new SpeechSynthesisUtterance(options.text)
    const rate = Math.min(2, Math.max(0.5, options.rate))
    utterance.rate = rate
    utterance.pitch = 1
    utterance.volume = clampVolume(options.volume)

    const voice = this.resolveVoice(options.voiceURI, options.lang ?? 'zh')
    if (voice) {
      utterance.voice = voice
      utterance.lang = normalizeVoiceLang(voice.lang)
    } else {
      utterance.lang = options.lang === 'en' ? 'en-US' : 'zh-CN'
    }

    this.utterance = utterance

    const cleanup = () => {
      if (this.startTimer !== null) {
        window.clearTimeout(this.startTimer)
        this.startTimer = null
      }
      if (this.watchdog !== null) {
        window.clearTimeout(this.watchdog)
        this.watchdog = null
      }
    }

    utterance.onstart = () => {
      if (generation !== this.generation) return
      handlers.onStart?.()
    }

    utterance.onend = () => {
      if (generation !== this.generation) return
      cleanup()
      this.utterance = null
      handlers.onEnd?.()
    }

    utterance.onerror = (event) => {
      if (generation !== this.generation) return
      cleanup()
      this.utterance = null
      if (event.error === 'not-allowed') this.unlockedOnce = false
      if (event.error === 'canceled' || event.error === 'interrupted') return
      handlers.onError?.(errorMessage(event.error))
    }

    this.startTimer = window.setTimeout(() => {
      this.startTimer = null
      if (generation !== this.generation) return

      try {
        this.synth!.resume()
        this.synth!.speak(utterance)
      } catch {
        cleanup()
        this.utterance = null
        handlers.onError?.('系统语音启动失败，请稍后重试。')
        return
      }

      const estimated = Math.max(
        12000,
        Math.ceil((options.text.length * 380) / Math.max(rate, 0.5)) + 5000,
      )
      this.watchdog = window.setTimeout(() => {
        if (generation !== this.generation) return
        cleanup()
        this.utterance = null
        handlers.onEnd?.()
      }, estimated)
    }, START_DELAY_MS)
  }

  cancel(): void {
    this.generation += 1
    if (this.startTimer !== null) {
      window.clearTimeout(this.startTimer)
      this.startTimer = null
    }
    if (this.watchdog !== null) {
      window.clearTimeout(this.watchdog)
      this.watchdog = null
    }
    if (this.utterance) {
      this.utterance.onstart = null
      this.utterance.onend = null
      this.utterance.onerror = null
      this.utterance = null
    }
    this.clearWarmup()
    try {
      this.synth?.cancel()
    } catch {
      // Some embedded webviews throw while the engine is shutting down.
    }
  }

  destroy(): void {
    this.cancel()
    this.synth?.removeEventListener?.('voiceschanged', this.handleVoicesChanged)
    this.voiceListeners.clear()
    this.englishVoiceListeners.clear()
  }

  private listVoices(lang: 'zh' | 'en' = 'zh'): ListedVoice[] {
    if (!this.synth) return []
    let voices: SpeechSynthesisVoice[] = []
    try {
      voices = this.synth.getVoices()
    } catch {
      return []
    }

    const matches = lang === 'en' ? isEnglishVoice : isChineseVoice
    const compare = lang === 'en' ? compareEnglishVoices : compareSystemVoices

    return voices
      .filter((voice) => matches(voice.lang))
      .filter(
        (voice) => lang !== 'en' || !isNoveltyVoice(voice.name, voice.voiceURI),
      )
      .map((raw) => ({
        raw,
        option: {
          uri: raw.voiceURI,
          name: raw.name,
          lang: normalizeVoiceLang(raw.lang),
          local: raw.localService,
          isDefault: raw.default,
          quality: detectVoiceQuality(raw.name, raw.voiceURI),
        },
      }))
      .sort((a, b) => compare(a.option, b.option))
  }

  private resolveVoice(
    voiceURI: string | null,
    lang: 'zh' | 'en' = 'zh',
  ): SpeechSynthesisVoice | null {
    const listed = this.listVoices(lang)
    if (voiceURI) {
      const selected = listed.find((item) => item.option.uri === voiceURI)
      if (selected) return selected.raw
    }
    // Never hand English text to a Chinese voice; let the engine pick from
    // utterance.lang when the device has no English voice installed.
    return listed[0]?.raw ?? null
  }

  private releaseWarmup(utterance: SpeechSynthesisUtterance | null): void {
    if (!utterance || this.warmup !== utterance) return
    utterance.onend = null
    utterance.onerror = null
    this.warmup = null
    if (this.warmupTimer !== null) {
      window.clearTimeout(this.warmupTimer)
      this.warmupTimer = null
    }
  }

  private clearWarmup(): void {
    this.releaseWarmup(this.warmup)
  }

  private emitVoices(): void {
    const chinese = this.getVoices()
    for (const listener of this.voiceListeners) listener(chinese)
    this.refreshEnglishVoices()
  }
}
