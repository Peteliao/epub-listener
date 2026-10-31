import { encodeWavBlob } from './wav'

export type AudioSinkMode = 'media' | 'webaudio'
export type AudioSinkState = 'idle' | 'keepalive' | 'playing' | 'gap'

export interface MediaSinkHandlers {
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

export interface MediaSinkDiagnostics {
  mode: AudioSinkMode
  state: AudioSinkState
  lastError: string | null
  clips: number
  recoveries: number
}

type PlaybackKind = 'speech' | 'gap' | 'keepalive'

const SILENCE_RATE = 8000
const LOOP_SILENCE_MS = 1000
const CLIP_URL_LIMIT = 8
const GAP_URL_LIMIT = 24
const START_PROBE_MS = 500

/**
 * Plays synthesized speech through a hidden <audio> element. iOS keeps an
 * in-DOM playing element alive after the screen locks, while WebAudio and
 * timers are suspended or throttled, so this is the channel that carries the
 * reading chain in the background.
 */
export class MediaAudioSink {
  private element: HTMLAudioElement | null = null
  private mode: AudioSinkMode = 'media'
  private state: AudioSinkState = 'idle'
  private kind: PlaybackKind | null = null
  private token = 0
  private handlers: MediaSinkHandlers | null = null
  private loopUrl: string | null = null
  private readonly gapUrls = new Map<number, string>()
  private readonly clipUrls = new Map<AudioBuffer, string>()
  private lastError: string | null = null
  private startWatchdog: number | null = null
  private recoveries = 0

  get diagnostics(): MediaSinkDiagnostics {
    return {
      mode: this.mode,
      state: this.state,
      lastError: this.lastError,
      clips: this.clipUrls.size,
      recoveries: this.recoveries,
    }
  }

  /** Must run inside a user gesture; iOS only unlocks media playback there. */
  unlock(): void {
    const element = this.ensureElement()
    if (!element) return
    // A rejected play() may just have been missing a gesture, so a fresh tap
    // gets another chance at the media channel.
    this.mode = 'media'
    this.lastError = null
    if (this.state === 'idle') this.startKeepAlive()
  }

  /**
   * Clears stale speech or gap audio before the next sentence. The silent
   * keep-alive loop is left running on purpose: pausing it and calling play()
   * again within the same tap makes iOS drop the new clip, whereas swapping the
   * clip in over the running loop is the same path synthesized sentences use.
   */
  prepareSpeech(): void {
    if (this.kind === 'speech' || this.kind === 'gap') {
      this.stop()
      return
    }
    this.token += 1
    this.handlers = null
  }

  playBuffer(buffer: AudioBuffer, handlers: MediaSinkHandlers): boolean {
    const element = this.ensureElement()
    if (!element || this.mode !== 'media') return false

    const token = ++this.token
    this.handlers = handlers
    this.kind = 'speech'
    this.state = 'playing'

    try {
      const url = this.clipUrl(buffer)
      element.loop = false
      element.src = url
      const played = element.play()
      if (played && typeof played.catch === 'function') {
        played.catch((error: unknown) => this.fail(token, error))
      }
      handlers.onStart?.()
      this.armStartWatchdog(token, element, url)
    } catch (error) {
      this.markFallback(error)
      this.handlers = null
      this.kind = null
      this.state = 'idle'
      handlers.onError?.('媒体播放通道出错，已切换到备用通道。')
      return true
    }

    return true
  }

  playGap(ms: number, onEnd: () => void): boolean {
    const element = this.ensureElement()
    if (!element || this.mode !== 'media') return false
    if (!Number.isFinite(ms) || ms <= 0) return false

    this.clearStartWatchdog()
    const token = ++this.token
    this.handlers = { onEnd }
    this.kind = 'gap'
    this.state = 'gap'

    try {
      element.loop = false
      element.src = this.gapUrl(ms)
      const played = element.play()
      if (played && typeof played.catch === 'function') {
        played.catch((error: unknown) => this.fail(token, error))
      }
    } catch (error) {
      this.markFallback(error)
      this.handlers = null
      this.kind = null
      this.state = 'idle'
      return false
    }
    return true
  }

  /**
   * Holds the audio session with near-silent looping audio while the model
   * synthesizes or the next chapter renders.
   */
  startKeepAlive(): void {
    const element = this.ensureElement()
    if (!element || this.mode !== 'media') return
    if (this.kind === 'speech' || this.kind === 'gap') return
    if (this.state === 'keepalive' && !element.paused) return

    this.clearStartWatchdog()
    const token = ++this.token
    this.handlers = null
    this.kind = 'keepalive'
    this.state = 'keepalive'

    try {
      this.loopUrl ??= this.silenceUrl(LOOP_SILENCE_MS)
      element.loop = true
      if (element.src !== this.loopUrl) element.src = this.loopUrl
      const played = element.play()
      if (played && typeof played.catch === 'function') {
        played.catch((error: unknown) => this.fail(token, error))
      }
    } catch (error) {
      this.markFallback(error)
      this.kind = null
      this.state = 'idle'
    }
  }

  stop(): void {
    this.token += 1
    this.handlers = null
    this.kind = null
    this.state = 'idle'
    this.clearStartWatchdog()
    this.pauseElement()
  }

  stopGap(): void {
    if (this.kind === 'gap') this.stop()
  }

  /** Pre-encodes a synthesized clip so the next sentence starts without a wait. */
  warm(buffer: AudioBuffer): void {
    if (this.mode !== 'media') return
    try {
      this.clipUrl(buffer)
    } catch {
      // Encoding failures surface when the clip is actually played.
    }
  }

  clearClips(): void {
    for (const url of this.clipUrls.values()) {
      if (url !== this.element?.src) URL.revokeObjectURL(url)
    }
    this.clipUrls.clear()
  }

  release(): void {
    this.stop()
    const element = this.element
    this.element = null
    if (element) {
      try {
        element.pause()
        element.removeAttribute('src')
        element.load()
      } catch {
        // A detached element may already be unloading.
      }
      element.remove()
    }
    this.clearClips()
    for (const url of this.gapUrls.values()) URL.revokeObjectURL(url)
    this.gapUrls.clear()
    if (this.loopUrl) {
      URL.revokeObjectURL(this.loopUrl)
      this.loopUrl = null
    }
  }

  private ensureElement(): HTMLAudioElement | null {
    if (this.element) return this.element
    if (typeof document === 'undefined' || typeof Audio === 'undefined') {
      this.mode = 'webaudio'
      return null
    }

    try {
      const element = document.createElement('audio')
      element.preload = 'auto'
      element.setAttribute('playsinline', '')
      element.setAttribute('webkit-playsinline', '')
      element.setAttribute('aria-hidden', 'true')
      element.tabIndex = -1
      element.volume = 1
      element.muted = false
      element.style.cssText =
        'position:fixed;left:-2px;bottom:-2px;width:1px;height:1px;pointer-events:none;'
      element.addEventListener('ended', this.handleEnded)
      element.addEventListener('error', this.handleError)
      document.body.appendChild(element)
      this.element = element
      return element
    } catch {
      this.mode = 'webaudio'
      return null
    }
  }

  private readonly handleEnded = (): void => {
    this.clearStartWatchdog()
    const handlers = this.handlers
    const kind = this.kind
    this.handlers = null
    this.kind = null
    this.state = 'idle'
    if (kind === 'speech' || kind === 'gap') handlers?.onEnd?.()
  }

  private readonly handleError = (): void => {
    if (this.kind === null) return
    const code = this.element?.error?.code
    this.fail(
      this.token,
      new Error(code ? `媒体音频加载失败（${code}）` : '媒体音频加载失败'),
    )
  }

  private fail(token: number, error: unknown): void {
    if (token !== this.token) return

    this.clearStartWatchdog()
    const handlers = this.handlers
    const kind = this.kind
    this.markFallback(error)
    this.handlers = null
    this.kind = null
    this.state = 'idle'
    this.pauseElement()

    // A failed gap must not stall the chain; continue as if it finished.
    if (kind === 'gap') handlers?.onEnd?.()
    else if (kind === 'speech') {
      handlers?.onError?.('媒体播放通道出错，已切换到备用通道。')
    }
  }

  private markFallback(error: unknown): void {
    this.mode = 'webaudio'
    this.lastError =
      error instanceof Error && error.message
        ? error.message
        : '媒体元素播放失败。'
  }

  /**
   * iOS occasionally drops the play() issued right after a tap-resume: the
   * clip never starts and no event fires. A pause + reload + play cycle
   * revives it — the same thing a second tap on play does — so retry once
   * before handing the clip to the WebAudio fallback.
   */
  private armStartWatchdog(
    token: number,
    element: HTMLAudioElement,
    url: string,
  ): void {
    this.clearStartWatchdog()
    let retried = false

    const check = (): void => {
      this.startWatchdog = null
      if (token !== this.token || this.kind !== 'speech') return
      if (!element.paused && element.currentTime > 0) return

      if (retried) {
        this.fail(token, new Error('媒体音频未能启动。'))
        return
      }
      retried = true
      this.recoveries += 1

      try {
        element.pause()
        element.src = url
        element.load()
        const played = element.play()
        if (played && typeof played.catch === 'function') {
          played.catch((error: unknown) => this.fail(token, error))
        }
      } catch (error) {
        this.fail(token, error)
        return
      }
      this.startWatchdog = window.setTimeout(check, START_PROBE_MS)
    }

    this.startWatchdog = window.setTimeout(check, START_PROBE_MS)
  }

  private clearStartWatchdog(): void {
    if (this.startWatchdog === null) return
    window.clearTimeout(this.startWatchdog)
    this.startWatchdog = null
  }

  private pauseElement(): void {
    try {
      this.element?.pause()
    } catch {
      // Ignore an element that is already shutting down.
    }
  }

  private clipUrl(buffer: AudioBuffer): string {
    const existing = this.clipUrls.get(buffer)
    if (existing) {
      this.clipUrls.delete(buffer)
      this.clipUrls.set(buffer, existing)
      return existing
    }

    const url = URL.createObjectURL(
      encodeWavBlob(buffer.getChannelData(0), buffer.sampleRate),
    )
    this.clipUrls.set(buffer, url)
    while (this.clipUrls.size > CLIP_URL_LIMIT) {
      const oldest = this.clipUrls.keys().next().value
      if (oldest === undefined) break
      const stale = this.clipUrls.get(oldest)!
      this.clipUrls.delete(oldest)
      if (stale !== this.element?.src) URL.revokeObjectURL(stale)
    }
    return url
  }

  private gapUrl(ms: number): string {
    const key = Math.max(1, Math.round(ms / 10) * 10)
    const existing = this.gapUrls.get(key)
    if (existing) {
      this.gapUrls.delete(key)
      this.gapUrls.set(key, existing)
      return existing
    }

    const url = this.silenceUrl(key)
    this.gapUrls.set(key, url)
    while (this.gapUrls.size > GAP_URL_LIMIT) {
      const oldest = this.gapUrls.keys().next().value
      if (oldest === undefined) break
      const stale = this.gapUrls.get(oldest)!
      this.gapUrls.delete(oldest)
      if (stale !== this.element?.src) URL.revokeObjectURL(stale)
    }
    return url
  }

  private silenceUrl(ms: number): string {
    const sampleCount = Math.max(1, Math.round((SILENCE_RATE * ms) / 1000))
    return URL.createObjectURL(
      encodeWavBlob(new Float32Array(sampleCount), SILENCE_RATE),
    )
  }
}
