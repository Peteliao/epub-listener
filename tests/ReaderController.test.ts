import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReaderController } from '../src/core/player/ReaderController'
import { DEFAULT_SETTINGS } from '../src/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const voice = { id: 'en-01', packId: 'hojo', engine: 'hojo', lang: 'en' }
  const reader = Object.assign(Object.create(ReaderController.prototype), {
    settings: {
      ...DEFAULT_SETTINGS, engine: 'sherpa', aiVoiceId: 'zh-01',
      aiEnglishVoiceId: 'en-01', englishAi: true,
    },
    options: { onToast: vi.fn() },
    destroyed: false,
    initialized: true,
    isPlaying: false,
    aiRuntimeGeneration: 0,
    englishAiGeneration: 0,
    playbackGeneration: 0,
    aiInitPromise: null,
    englishAiInitPromise: null,
    aiLoadedVoiceId: null,
    aiLoadedEnglishVoiceId: null,
    aiLoadedEnglishPackId: null,
    englishAiFallback: false,
    aiFallback: false,
    units: [],
    sentenceIndex: 0,
    activePlanIndex: 0,
    speech: { supported: true, cancelActive: vi.fn(), cancel: vi.fn() },
    ai: {
      getVoice: vi.fn(() => ({ id: 'zh-01', engine: 'hojo', modelType: 'hojo' })),
      getEnglishVoice: vi.fn(() => voice),
      loadPack: vi.fn(async (id: string) => ({
        voiceId: id, packId: 'hojo', model: { config: {} },
      })),
      selectEnglishVoice: vi.fn((id: string) => { voice.id = id }),
    },
    aiStatus: { supported: true, phase: 'ready', packs: [{ id: 'hojo', phase: 'ready', voices: [voice] }] },
    aiSpeech: {
      initialized: false, englishInitialized: false,
      init: vi.fn(async () => {}), initEnglish: vi.fn(async () => {}),
      unlock: vi.fn(), releaseEnglish: vi.fn(), release: vi.fn(),
      prepareSpeech: vi.fn(), cancel: vi.fn(), speak: vi.fn(), preload: vi.fn(),
    },
    bookLexicon: { waitForOverlay: vi.fn(async () => ''), setEnabled: vi.fn() },
    maybeStartBookLexicon: vi.fn(),
  })
  return reader
}

function unit(start: number, text: string) {
  return { start, end: start, text, speechText: text }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('ReaderController bilingual playback', () => {
  it('prefetches the next language before later same-language chunks across units', () => {
    const reader = fixture()
    reader.units = [unit(0, '第一句。'), unit(1, 'The next sentence.'), unit(2, '第三句。')]
    const plan = reader.buildSpeechPlan([{ lang: 'zh', text: '第一句。' }], true)
    expect(plan[0].nextChunks).toEqual([
      { lang: 'en', text: 'The next sentence.' }, { lang: 'zh', text: '第三句。' },
    ])
  })

  it('keeps mixed chunks in playback order and excludes system English from prefetch', () => {
    const reader = fixture()
    const segments = [
      { lang: 'zh', text: '你好。' }, { lang: 'en', text: 'Hello.' }, { lang: 'zh', text: '再见。' },
    ]
    expect(reader.buildSpeechPlan(segments, true)[0].nextChunks.map((c: { lang: string }) => c.lang))
      .toEqual(['en', 'zh'])
    reader.settings.englishAi = false
    expect(reader.buildSpeechPlan(segments, true)[0].nextChunks.map((c: { lang: string }) => c.lang))
      .toEqual(['zh'])
  })

  it('initializes Hojo English lookahead before the first Chinese chunk', async () => {
    const reader = fixture()
    reader.isPlaying = true
    const order: string[] = []
    reader.ensureAiReady = vi.fn(async () => { order.push('zh') })
    reader.ensureEnglishAiReady = vi.fn(async () => { order.push('en') })
    reader.runSpeechPlan = vi.fn(() => { order.push('play') })
    await reader.speakWithAi([{
      engine: 'ai', lang: 'zh', text: '你好。', nextChunks: [{ lang: 'en', text: 'Hello.' }],
    }], 0, 0)
    expect(order).toEqual(['zh', 'en', 'play'])
  })

  it('does not wait for pronunciation overlays when starting Hojo', async () => {
    const reader = fixture()
    await reader.ensureAiReady()
    expect(reader.bookLexicon.waitForOverlay).not.toHaveBeenCalled()
    expect(reader.aiSpeech.init).toHaveBeenCalledTimes(1)
  })

  it('shares initialization between idle prewarming and playback', async () => {
    const reader = fixture()
    const loading = deferred<unknown>()
    reader.ai.loadPack.mockImplementationOnce(() => loading.promise)
    reader.aiSpeech.init.mockImplementation(async () => { reader.aiSpeech.initialized = true })
    const warm = reader.ensureAiReady()
    const play = reader.ensureAiReady()
    loading.resolve({ voiceId: 'zh-01', packId: 'hojo', model: { config: {} } })
    await Promise.all([warm, play])
    expect(reader.ai.loadPack).toHaveBeenCalledTimes(1)
    expect(reader.aiSpeech.init).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('preloads real bilingual text silently with initialized=%s', async (initialized) => {
    const reader = fixture()
    reader.aiSpeech.initialized = initialized
    reader.aiSpeech.englishInitialized = initialized
    reader.units = [unit(0, '你好。'), unit(1, 'Hello.'), unit(2, '再见。')]
    reader.settings.englishVolume = 0.7
    await reader.prewarmAi()
    expect(reader.aiSpeech.init).toHaveBeenCalledTimes(initialized ? 0 : 1)
    expect(reader.aiSpeech.initEnglish).toHaveBeenCalledTimes(initialized ? 0 : 1)
    expect(reader.bookLexicon.waitForOverlay).not.toHaveBeenCalled()
    expect(reader.aiSpeech.preload).toHaveBeenCalledWith([
      expect.objectContaining({ text: '你好。', lang: 'zh', volume: 1 }),
      expect.objectContaining({ text: 'Hello.', lang: 'en', volume: 0.7 }),
      expect.objectContaining({ text: '再见。', lang: 'zh', volume: 1 }),
    ])
    expect(reader.aiSpeech.speak).not.toHaveBeenCalled()
  })

  it.each(['play', 'seek', 'settings', 'release', 'destroy'])('does not preload stale text after %s during initialization', async (change) => {
    const reader = fixture()
    reader.units = [unit(0, '你好。'), unit(1, 'Hello.')]
    const loading = deferred<void>()
    reader.ensureAiReady = vi.fn(() => loading.promise)
    reader.ensureEnglishAiReady = vi.fn()
    const warm = reader.prewarmAi()
    if (change === 'play') reader.isPlaying = true
    if (change === 'seek') reader.playbackGeneration += 1
    if (change === 'settings') reader.settings = { ...reader.settings, englishVolume: 0.8 }
    if (change === 'release') reader.releaseAiRuntime()
    if (change === 'destroy') reader.destroyed = true
    loading.resolve()
    await warm
    expect(reader.ensureEnglishAiReady).not.toHaveBeenCalled()
    expect(reader.aiSpeech.preload).not.toHaveBeenCalled()
  })

  it('does not synthesize idle text when the system engine is selected', async () => {
    const reader = fixture()
    reader.settings.engine = 'system'
    reader.units = [unit(0, '你好。')]
    await reader.prewarmAi()
    expect(reader.aiSpeech.preload).not.toHaveBeenCalled()
  })

  it('does not reuse an English voice just because it shares a pack', async () => {
    const reader = fixture()
    reader.aiSpeech.englishInitialized = true
    reader.aiLoadedEnglishPackId = 'hojo'
    reader.aiLoadedEnglishVoiceId = 'en-00'
    await reader.ensureEnglishAiReady()
    expect(reader.aiSpeech.initEnglish).toHaveBeenCalledTimes(1)
    expect(reader.aiLoadedEnglishVoiceId).toBe('en-01')
  })

  it('ignores old English cache loads finishing after a voice switch', async () => {
    const reader = fixture()
    const old = deferred<unknown>()
    reader.ai.loadPack.mockImplementationOnce(() => old.promise)
    const pending = reader.ensureEnglishAiReady()
    reader.releaseEnglishAi()
    reader.ai.selectEnglishVoice('en-02')
    await reader.ensureEnglishAiReady()
    old.resolve({ voiceId: 'en-01', packId: 'hojo', model: { config: {} } })
    await pending
    expect(reader.aiSpeech.initEnglish).toHaveBeenCalledTimes(1)
    expect(reader.aiSpeech.initEnglish.mock.calls[0][0].voiceId).toBe('en-02')
    expect(reader.aiLoadedEnglishVoiceId).toBe('en-02')
  })

  it('does not overwrite new voice tracking when an old initialization finishes', async () => {
    const reader = fixture()
    const old = deferred<void>()
    reader.aiSpeech.initEnglish.mockImplementationOnce(() => old.promise)
    const pending = reader.ensureEnglishAiReady()
    await Promise.resolve()
    reader.releaseEnglishAi()
    reader.ai.selectEnglishVoice('en-02')
    await reader.ensureEnglishAiReady()
    old.resolve()
    await pending
    expect(reader.aiLoadedEnglishVoiceId).toBe('en-02')
  })

  it('invalidates a model load after the runtime is released', async () => {
    const reader = fixture()
    const old = deferred<unknown>()
    reader.ai.loadPack.mockImplementationOnce(() => old.promise)
    const pending = reader.ensureAiReady()
    reader.releaseAiRuntime()
    old.resolve({ voiceId: 'zh-01', packId: 'hojo', model: { config: {} } })
    await pending
    expect(reader.aiSpeech.init).not.toHaveBeenCalled()
    expect(reader.aiLoadedVoiceId).toBeNull()
  })

  it('stops old playback synchronously before awaiting a replacement voice', () => {
    const reader = fixture()
    reader.isPlaying = true
    reader.units = [unit(0, '你好。Hello.')]
    reader.clearSentenceGap = vi.fn()
    reader.clearChunkGap = vi.fn()
    reader.highlightCurrent = vi.fn()
    reader.scheduleProgressSave = vi.fn()
    reader.emitState = vi.fn()
    const pending = deferred<void>()
    reader.speakWithAi = vi.fn(() => pending.promise)
    reader.speakCurrent(1)
    expect(reader.aiSpeech.prepareSpeech).toHaveBeenCalledTimes(1)
    expect(reader.aiSpeech.prepareSpeech.mock.invocationCallOrder[0])
      .toBeLessThan(reader.speakWithAi.mock.invocationCallOrder[0])
    expect(reader.speakWithAi.mock.calls[0][2]).toBe(1)
  })

  it('restarts only the active chunk when changing the English voice', () => {
    const reader = fixture()
    reader.isPlaying = true
    reader.activePlanIndex = 2
    reader.restartPlanIndex = 2
    reader.speakCurrent = vi.fn()
    reader.setSettings({ ...reader.settings, aiEnglishVoiceId: 'en-02' })
    expect(reader.aiSpeech.releaseEnglish).toHaveBeenCalledTimes(1)
    expect(reader.speakCurrent).toHaveBeenCalledWith(2)
  })

  it('resumes the same chunk when the English voice changes again during initialization', () => {
    const reader = fixture()
    reader.isPlaying = true
    reader.restartPlanIndex = 2
    reader.speakCurrent = vi.fn((index = 0) => { reader.restartPlanIndex = index })
    reader.setSettings({ ...reader.settings, aiEnglishVoiceId: 'en-02' })
    reader.setSettings({ ...reader.settings, aiEnglishVoiceId: 'en-03' })
    expect(reader.speakCurrent.mock.calls).toEqual([[2], [2]])
  })

  it('passes the English rate and volume to cross-language synthesis', () => {
    const reader = fixture()
    reader.isPlaying = true
    reader.settings.rate = 1.2
    reader.settings.englishRate = 0.8
    reader.settings.englishVolume = 0.7
    reader.shouldSkipChunk = vi.fn(() => false)
    reader.runSpeechPlan([{
      engine: 'ai', lang: 'zh', text: '你好。', nextChunks: [{ lang: 'en', text: 'Hello.' }],
    }], 0, 0)
    expect(reader.aiSpeech.speak.mock.calls[0][0].nextChunks[0]).toMatchObject({
      lang: 'en', text: 'Hello.', rate: 0.96, volume: 0.7,
    })
  })
})
