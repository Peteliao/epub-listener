import { describe, expect, it, vi } from 'vitest'
import { ReaderController } from '../src/core/player/ReaderController'
import { DEFAULT_SETTINGS } from '../src/types'

const PACK_ID = 'matcha-icefall-zh-baker'

function routeFixture(overrides: Record<string, unknown> = {}) {
  const reader = Object.assign(Object.create(ReaderController.prototype), {
    settings: {
      ...DEFAULT_SETTINGS,
      engine: 'system',
      aiVoiceId: 'shanlan',
      preferChineseOffline: true,
      englishAi: true,
    },
    speech: { supported: true },
    aiFallback: false,
    englishAiFallback: false,
    aiStatus: {
      supported: true,
      phase: 'ready',
      packs: [{ id: PACK_ID, phase: 'ready', voices: [{ id: 'shanlan' }] }],
    },
    ai: {
      getVoice: vi.fn(() => ({
        id: 'shanlan',
        packId: PACK_ID,
        modelType: 'matcha',
      })),
      getEnglishVoice: vi.fn(() => ({
        id: 'kristin',
        packId: 'en-pack',
      })),
    },
    units: [],
    sentenceIndex: 0,
    ...overrides,
  })
  return reader
}

describe('中文优先离线朗读：生效条件', () => {
  it('系统引擎 + 山岚音色包就绪时生效', () => {
    expect(routeFixture().chineseOfflineActive()).toBe(true)
  })

  it.each([
    ['开关关闭', { settings: { ...DEFAULT_SETTINGS, engine: 'system', preferChineseOffline: false, aiVoiceId: 'shanlan' } }],
    ['用户已选离线引擎', { settings: { ...DEFAULT_SETTINGS, engine: 'sherpa' } }],
    ['音色包未就绪', {
      aiStatus: {
        supported: true,
        phase: 'missing',
        packs: [{ id: PACK_ID, phase: 'missing', voices: [] }],
      },
    }],
    ['已降级到系统语音', { aiFallback: true }],
    ['浏览器不支持系统语音', { speech: { supported: false } }],
    ['浏览器不支持离线音色', {
      aiStatus: { supported: false, phase: 'unsupported', packs: [] },
    }],
  ])('%s 时不生效，保持原有朗读路径', (_label, overrides) => {
    expect(routeFixture(overrides).chineseOfflineActive()).toBe(false)
  })

  it('选中的中文音色不是 Matcha 时不生效', () => {
    const reader = routeFixture()
    reader.ai.getVoice.mockReturnValue({
      id: 'zh-01',
      packId: 'piper-pack',
      modelType: 'vits',
    })
    expect(reader.chineseOfflineActive()).toBe(false)
  })
})

describe('中文优先离线朗读：模式语义边界', () => {
  it('新路由下只扩展音频会话，不改变锁屏跳过英文的判定', () => {
    const reader = routeFixture()
    expect(reader.chineseOfflineActive()).toBe(true)
    expect(reader.aiModeActive).toBe(false)
    expect(reader.offlineAudioActive).toBe(true)
  })

  it('开关关闭时两个 getter 都为 false', () => {
    const reader = routeFixture({
      settings: {
        ...DEFAULT_SETTINGS,
        engine: 'system',
        preferChineseOffline: false,
      },
    })
    expect(reader.aiModeActive).toBe(false)
    expect(reader.offlineAudioActive).toBe(false)
  })

  it('显式选择 sherpa 时 aiModeActive 为 true，新开关不介入', () => {
    const reader = routeFixture({ settings: { ...DEFAULT_SETTINGS, engine: 'sherpa' } })
    expect(reader.chineseOfflineActive()).toBe(false)
    expect(reader.aiModeActive).toBe(true)
    expect(reader.offlineAudioActive).toBe(true)
  })
})

describe('中文优先离线朗读：play() 兜底', () => {
  function playFixture(overrides: Record<string, unknown> = {}) {
    const reader = routeFixture({
      initialized: true,
      destroyed: false,
      isPlaying: false,
      chapterLoading: false,
      sentenceCount: 1,
      iosDevice: false,
      options: { onToast: vi.fn() },
      aiSpeech: { unlock: vi.fn(), initialized: false },
      enableWakeLock: vi.fn(),
      emitState: vi.fn(),
      speakCurrent: vi.fn(),
      ...overrides,
    })
    reader.speech.unlock = vi.fn()
    return reader
  }

  it('仍在首次手势内解锁离线音频，且不弹下载提示、不设置 aiFallback', () => {
    const reader = playFixture()
    reader.play()
    expect(reader.aiSpeech.unlock).toHaveBeenCalledTimes(1)
    expect(reader.options.onToast).not.toHaveBeenCalled()
    expect(reader.aiFallback).toBe(false)
    expect(reader.speakCurrent).toHaveBeenCalledTimes(1)
  })

  it('开关关闭时不触碰离线音频，完全保持系统引擎行为', () => {
    const reader = playFixture({
      settings: {
        ...DEFAULT_SETTINGS,
        engine: 'system',
        preferChineseOffline: false,
      },
    })
    reader.play()
    expect(reader.aiSpeech.unlock).not.toHaveBeenCalled()
    expect(reader.aiFallback).toBe(false)
  })
})

describe('中文优先离线朗读：分段路由', () => {
  const segments = [
    { lang: 'zh', text: '他答应了一声。' },
    { lang: 'en', text: 'Hello world.' },
  ]

  it('只把中文段落交给离线引擎，英文包就绪也仍用系统语音', () => {
    const reader = routeFixture()
    // Make the English offline route otherwise eligible, to prove the guard.
    reader.aiStatus.packs.push({
      id: 'en-pack',
      phase: 'ready',
      voices: [{ id: 'kristin' }],
    })
    const plan = reader.buildSpeechPlan(segments, true, true)
    expect(plan.map((chunk: { engine: string }) => chunk.engine)).toEqual([
      'ai',
      'system',
    ])
  })

  it('关闭开关时（sherpa 引擎）英文仍按 englishAi 走离线', () => {
    const reader = routeFixture()
    reader.aiStatus.packs.push({
      id: 'en-pack',
      phase: 'ready',
      voices: [{ id: 'kristin' }],
    })
    const plan = reader.buildSpeechPlan(segments, true, false)
    expect(plan.map((chunk: { engine: string }) => chunk.engine)).toEqual([
      'ai',
      'ai',
    ])
  })

  it('系统语音不可用时，所有段落都必须由离线引擎兜底', () => {
    const reader = routeFixture({ speech: { supported: false } })
    const plan = reader.buildSpeechPlan(segments, true, true)
    expect(plan.map((chunk: { engine: string }) => chunk.engine)).toEqual([
      'ai',
      'ai',
    ])
  })

  it('chineseOnlyAi 向下传递到预取，英文后续句不混入 AI chunk', () => {
    const reader = routeFixture()
    // An otherwise-eligible English offline pack makes the guard observable.
    reader.aiStatus.packs.push({
      id: 'en-pack',
      phase: 'ready',
      voices: [{ id: 'kristin' }],
    })
    reader.units = [
      { start: 0, end: 0, text: '你好。', speechText: '你好。' },
      { start: 1, end: 1, text: 'Hello.', speechText: 'Hello.' },
    ]
    reader.sentenceIndex = 0
    const plan = reader.buildSpeechPlan([{ lang: 'zh', text: '你好。' }], true, true)
    expect(plan[0].nextChunks).toEqual([])
  })
})
