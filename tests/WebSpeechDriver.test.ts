import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSpeechDriver } from '../src/core/tts/WebSpeechDriver'

interface FakeVoice {
  name: string
  lang: string
  voiceURI: string
  localService: boolean
  default: boolean
}

class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  pitch = 1
  volume = 1
  voice: FakeVoice | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}

const CHINESE: FakeVoice = {
  name: 'Chinese',
  lang: 'zh-CN',
  voiceURI: 'zh-cn',
  localService: true,
  default: true,
}

const ENGLISH: FakeVoice = {
  name: 'English',
  lang: 'en-US',
  voiceURI: 'en-us',
  localService: true,
  default: false,
}

function installSynth(voices: FakeVoice[]) {
  const spoken: FakeUtterance[] = []
  const synth = {
    getVoices: () => voices,
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance)
    },
    cancel: vi.fn(),
    resume: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('speechSynthesis', synth)
  return { synth, spoken }
}

describe('WebSpeechDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('warms up speech synthesis silently for a later iOS utterance', () => {
    const { synth, spoken } = installSynth([CHINESE, ENGLISH])
    const driver = new WebSpeechDriver()

    driver.unlock()

    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toMatchObject({
      text: ' ',
      lang: 'zh-CN',
      volume: 0,
      rate: 10,
    })

    driver.cancelActive()
    expect(synth.cancel).not.toHaveBeenCalled()
    driver.unlock()
    expect(spoken).toHaveLength(1)

    driver.cancel()
    expect(synth.cancel).toHaveBeenCalledTimes(1)
  })

  it('does not warm speech synthesis again after a successful unlock', () => {
    const { spoken } = installSynth([CHINESE, ENGLISH])
    const driver = new WebSpeechDriver()

    driver.unlock()
    expect(spoken).toHaveLength(1)

    spoken[0]?.onend?.()
    driver.unlock()
    driver.cancel()
    driver.unlock()

    expect(spoken).toHaveLength(1)
  })

  it('warms again when the system voice refused the previous unlock', () => {
    const { spoken } = installSynth([CHINESE, ENGLISH])
    const driver = new WebSpeechDriver()

    driver.unlock()
    spoken[0]?.onerror?.({ error: 'not-allowed' })
    driver.unlock()

    expect(spoken).toHaveLength(2)
  })

  it('never voices English with a Chinese voice', async () => {
    const { spoken } = installSynth([CHINESE])
    const driver = new WebSpeechDriver()

    driver.speak(
      { text: 'Why Nations Fail', rate: 1, voiceURI: null, lang: 'en' },
      {},
    )
    await vi.advanceTimersByTimeAsync(40)

    expect(spoken).toHaveLength(1)
    expect(spoken[0]?.voice).toBeNull()
    expect(spoken[0]?.lang).toBe('en-US')
    expect(driver.hasEnglishVoice()).toBe(false)
    driver.cancel()
  })

  it('picks the English voice for English chunks', async () => {
    const { spoken } = installSynth([CHINESE, ENGLISH])
    const driver = new WebSpeechDriver()

    driver.speak(
      { text: 'Why Nations Fail', rate: 1, voiceURI: null, lang: 'en' },
      {},
    )
    await vi.advanceTimersByTimeAsync(40)

    expect(spoken[0]?.voice?.name).toBe('English')
    expect(spoken[0]?.lang).toBe('en-US')
    expect(driver.voiceCount).toBe(2)
    expect(driver.hasEnglishVoice()).toBe(true)
    driver.cancel()
  })

  it('avoids iOS novelty voices when auto-selecting English', async () => {
    const iosVoices: FakeVoice[] = [
      {
        name: 'Ting-Ting',
        lang: 'zh-CN',
        voiceURI: 'com.apple.voice.compact.zh-CN.Ting-Ting',
        localService: true,
        default: true,
      },
      {
        name: 'Albert',
        lang: 'en-US',
        voiceURI: 'com.apple.speech.synthesis.voice.Albert',
        localService: true,
        default: false,
      },
      {
        name: 'Bells',
        lang: 'en-US',
        voiceURI: 'com.apple.speech.synthesis.voice.Bells',
        localService: true,
        default: false,
      },
      {
        name: 'Grandma',
        lang: 'en-US',
        voiceURI: 'com.apple.eloquence.en-US.Grandma',
        localService: true,
        default: false,
      },
      {
        name: 'Kathy',
        lang: 'en-US',
        voiceURI: 'com.apple.speech.synthesis.voice.Kathy',
        localService: true,
        default: false,
      },
      {
        name: 'Samantha',
        lang: 'en-US',
        voiceURI: 'com.apple.voice.compact.en-US.Samantha',
        localService: true,
        default: false,
      },
      {
        name: 'Aaron',
        lang: 'en-US',
        voiceURI: 'com.apple.ttsbundle.siri_Aaron_en-US_compact',
        localService: true,
        default: false,
      },
      {
        name: 'Daniel',
        lang: 'en-GB',
        voiceURI: 'com.apple.voice.compact.en-GB.Daniel',
        localService: true,
        default: false,
      },
    ]
    const { spoken } = installSynth(iosVoices)
    const driver = new WebSpeechDriver()

    driver.speak(
      {
        text: 'Why Nations Fail',
        rate: 1,
        voiceURI: 'com.apple.voice.compact.zh-CN.Ting-Ting',
        lang: 'en',
      },
      {},
    )
    await vi.advanceTimersByTimeAsync(40)

    expect(spoken[0]?.voice?.name).toBe('Aaron')
    expect(spoken[0]?.voice?.voiceURI).toContain('siri_Aaron')
    expect(spoken[0]?.voice?.name).not.toBe('Albert')
    expect(driver.hasEnglishVoice()).toBe(true)
    driver.cancel()
  })

  it('applies per-utterance volume and clamps it to the platform range', async () => {
    const { spoken } = installSynth([CHINESE, ENGLISH])
    const driver = new WebSpeechDriver()

    driver.speak(
      { text: 'Hello.', rate: 1, voiceURI: null, lang: 'en', volume: 0.7 },
      {},
    )
    await vi.advanceTimersByTimeAsync(40)
    expect(spoken[0]?.volume).toBe(0.7)

    driver.speak(
      { text: 'Hello again.', rate: 1, voiceURI: null, lang: 'en', volume: 1.2 },
      {},
    )
    await vi.advanceTimersByTimeAsync(40)
    expect(spoken[1]?.volume).toBe(1)
    driver.cancel()
  })

  it('exposes English voices separately and previews with the selected one', () => {
    const { spoken } = installSynth([CHINESE, ENGLISH])
    const driver = new WebSpeechDriver()
    const received: string[][] = []
    const unsubscribe = driver.subscribeEnglishVoices((voices) =>
      received.push(voices.map((voice) => voice.name)),
    )

    expect(driver.getEnglishVoices().map((voice) => voice.name)).toEqual([
      'English',
    ])
    expect(received).toEqual([['English']])

    expect(
      driver.preview('en-us', 'Hello, this is a preview.', 1, 'en', 0.8),
    ).toBe(true)
    expect(spoken[0]?.voice?.name).toBe('English')
    expect(spoken[0]?.lang).toBe('en-US')
    expect(spoken[0]?.volume).toBe(0.8)

    driver.refreshEnglishVoices()
    expect(received).toHaveLength(2)
    unsubscribe()
    driver.destroy()
  })

  it('does not treat novelty voices as usable English voices', async () => {
    const novelty: FakeVoice[] = [
      {
        name: 'Albert',
        lang: 'en-US',
        voiceURI: 'com.apple.speech.synthesis.voice.Albert',
        localService: true,
        default: false,
      },
      {
        name: 'Bells',
        lang: 'en-US',
        voiceURI: 'com.apple.speech.synthesis.voice.Bells',
        localService: true,
        default: false,
      },
    ]
    const { spoken } = installSynth([CHINESE, ...novelty])
    const driver = new WebSpeechDriver()

    expect(driver.hasEnglishVoice()).toBe(false)
    driver.speak(
      { text: 'Why Nations Fail', rate: 1, voiceURI: null, lang: 'en' },
      {},
    )
    await vi.advanceTimersByTimeAsync(40)

    expect(spoken[0]?.voice).toBeNull()
    expect(spoken[0]?.lang).toBe('en-US')
    driver.cancel()
  })
})
