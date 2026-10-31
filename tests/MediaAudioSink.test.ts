import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaAudioSink } from '../src/core/tts/MediaAudioSink'

let urlSeq = 0

function fakeBuffer(): AudioBuffer {
  const sampleRate = 8000
  const samples = new Float32Array(sampleRate / 2)
  return {
    sampleRate,
    length: samples.length,
    duration: 0.5,
    getChannelData: () => samples,
  } as unknown as AudioBuffer
}

function element(): HTMLAudioElement {
  const found = document.querySelector('audio')
  if (!found) throw new Error('audio element missing')
  return found
}

describe('MediaAudioSink', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    urlSeq = 0
    ;(
      URL as unknown as { createObjectURL: (blob: Blob) => string }
    ).createObjectURL = vi.fn(() => `blob:test-${++urlSeq}`)
    ;(
      URL as unknown as { revokeObjectURL: (url: string) => void }
    ).revokeObjectURL = vi.fn()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('primes a looped silent element inside the start gesture', () => {
    const sink = new MediaAudioSink()
    sink.unlock()

    const audio = element()
    expect(audio.loop).toBe(true)
    expect(audio.muted).toBe(false)
    expect(audio.volume).toBe(1)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    expect(sink.diagnostics).toMatchObject({
      mode: 'media',
      state: 'keepalive',
    })
  })

  it('hands the keep-alive loop over to the next clip without pausing', () => {
    const sink = new MediaAudioSink()
    sink.unlock()
    sink.prepareSpeech()

    const onStart = vi.fn()
    expect(sink.playBuffer(fakeBuffer(), { onStart })).toBe(true)

    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(sink.diagnostics).toMatchObject({ mode: 'media', state: 'playing' })

    sink.stop()
  })

  it('stops a stale sentence before the next one is prepared', () => {
    const sink = new MediaAudioSink()
    sink.unlock()
    const onEnd = vi.fn()
    sink.playBuffer(fakeBuffer(), { onEnd })

    sink.prepareSpeech()

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    expect(sink.diagnostics.state).toBe('idle')
    element().dispatchEvent(new Event('ended'))
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('stops a sentence gap when speech takes over', () => {
    const sink = new MediaAudioSink()
    sink.unlock()
    const onEnd = vi.fn()
    sink.playGap(120, onEnd)

    sink.prepareSpeech()

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    expect(sink.diagnostics.state).toBe('idle')
    element().dispatchEvent(new Event('ended'))
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('plays a clip synchronously and reports its end', () => {
    const sink = new MediaAudioSink()
    sink.unlock()

    const onStart = vi.fn()
    const onEnd = vi.fn()
    expect(sink.playBuffer(fakeBuffer(), { onStart, onEnd })).toBe(true)

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(element().loop).toBe(false)
    expect(sink.diagnostics.state).toBe('playing')

    element().dispatchEvent(new Event('ended'))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(sink.diagnostics.state).toBe('idle')
  })

  it('plays an exact-length silence between sentences', () => {
    const sink = new MediaAudioSink()
    sink.unlock()

    const onEnd = vi.fn()
    expect(sink.playGap(120, onEnd)).toBe(true)
    expect(sink.diagnostics.state).toBe('gap')

    element().dispatchEvent(new Event('ended'))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('drops a pending gap callback when the gap is cancelled', () => {
    const sink = new MediaAudioSink()
    sink.unlock()

    const onEnd = vi.fn()
    sink.playGap(200, onEnd)
    sink.stopGap()
    element().dispatchEvent(new Event('ended'))

    expect(onEnd).not.toHaveBeenCalled()
    expect(sink.diagnostics.state).toBe('idle')
  })

  it('falls back to WebAudio when the element rejects playback', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new Error('blocked'),
    )

    const sink = new MediaAudioSink()
    sink.unlock()
    await vi.waitFor(() => {
      expect(sink.diagnostics.mode).toBe('webaudio')
    })
    expect(sink.diagnostics.lastError).toBe('blocked')
  })

  it('continues the chain when a gap cannot play', async () => {
    const sink = new MediaAudioSink()
    sink.unlock()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new Error('gap-blocked'),
    )

    const onEnd = vi.fn()
    expect(sink.playGap(150, onEnd)).toBe(true)
    await vi.waitFor(() => {
      expect(onEnd).toHaveBeenCalledTimes(1)
    })
    expect(sink.diagnostics.mode).toBe('webaudio')
  })

  it('reports speech playback failures so the driver can use WebAudio', async () => {
    const sink = new MediaAudioSink()
    sink.unlock()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new Error('speech-blocked'),
    )

    const onError = vi.fn()
    sink.playBuffer(fakeBuffer(), { onError })
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1)
    })
  })

  it('pre-encodes a clip once and reuses its blob url', () => {
    const sink = new MediaAudioSink()
    const buffer = fakeBuffer()
    sink.warm(buffer)
    sink.unlock()
    sink.playBuffer(buffer, {})

    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    sink.stop()
  })

  it('revives a clip that iOS never actually started', () => {
    vi.useFakeTimers()
    const sink = new MediaAudioSink()
    sink.unlock()

    const audio = element()
    let playing = false
    Object.defineProperty(audio, 'paused', {
      configurable: true,
      get: () => !playing,
    })
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => (playing ? 0.3 : 0),
    })

    sink.playBuffer(fakeBuffer(), {})
    vi.advanceTimersByTime(500)
    expect(sink.diagnostics.recoveries).toBe(1)
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1)

    playing = true
    vi.advanceTimersByTime(500)
    expect(sink.diagnostics).toMatchObject({
      mode: 'media',
      state: 'playing',
      recoveries: 1,
    })
  })

  it('leaves a clip alone once it is actually playing', () => {
    vi.useFakeTimers()
    const sink = new MediaAudioSink()
    sink.unlock()

    const audio = element()
    Object.defineProperty(audio, 'paused', {
      configurable: true,
      get: () => false,
    })
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => 0.3,
    })

    sink.playBuffer(fakeBuffer(), {})
    vi.advanceTimersByTime(1000)

    expect(sink.diagnostics.recoveries).toBe(0)
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
  })

  it('falls back when the clip still will not start after a retry', () => {
    vi.useFakeTimers()
    const sink = new MediaAudioSink()
    sink.unlock()

    const onError = vi.fn()
    sink.playBuffer(fakeBuffer(), { onError })
    vi.advanceTimersByTime(1000)

    expect(sink.diagnostics.recoveries).toBe(1)
    expect(sink.diagnostics.mode).toBe('webaudio')
    expect(sink.diagnostics.lastError).toBe('媒体音频未能启动。')
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('releases the element and its blob urls', () => {
    const sink = new MediaAudioSink()
    sink.unlock()
    sink.playBuffer(fakeBuffer(), {})
    sink.release()

    expect(document.querySelector('audio')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
})
