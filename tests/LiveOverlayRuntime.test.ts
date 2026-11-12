import { describe, expect, it, vi } from 'vitest'
import { BookLexiconService } from '@/core/tts/BookLexiconService'
import { ReaderController } from '@/core/player/ReaderController'
import { DEFAULT_SETTINGS } from '@/types'

function service() {
  const ai = { getLexiconAssets: vi.fn(async () => null) }
  const instance = new BookLexiconService(ai as never, 'book-a')
  return { instance, ai }
}

describe('BookLexiconService 即时纠错叠加', () => {
  it('live 行叠加到扫描结果之后，扫描缓存结果不被污染', () => {
    const { instance } = service()
    // Simulate a completed whole-book scan without touching IndexedDB.
    const internals = instance as unknown as {
      baseOverlay: string
      recompose: () => void
    }
    internals.baseOverlay = '甲 jia3'
    internals.recompose()
    expect(instance.getOverlay()).toBe('甲 jia3')

    expect(instance.setLiveOverlay('乙 yi3', 'hash-1')).toBe(true)
    expect(instance.getOverlay()).toBe('甲 jia3\n乙 yi3'.split('\n')
      .sort((a, b) => a.localeCompare(b, 'zh')).join('\n'))
  })

  it('相同指纹是 no-op（去抖幂等）', () => {
    const { instance } = service()
    expect(instance.setLiveOverlay('乙 yi3', 'h')).toBe(true)
    expect(instance.setLiveOverlay('乙 yi3', 'h')).toBe(false)
  })

  it('live 行覆盖扫描同名行，且人工表在 AiModel 侧仍最后生效', () => {
    const { instance } = service()
    const internals = instance as unknown as { baseOverlay: string; recompose: () => void }
    internals.baseOverlay = '会计 hui4 ji4'
    internals.recompose()
    expect(instance.setLiveOverlay('会计 kuai4 ji4', 'h2')).toBe(true)
    const rows = instance.getOverlay().split('\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toBe('会计 kuai4 ji4')
  })

  it('invalidate 只清 runKey，不丢当前可用 overlay', () => {
    const { instance } = service()
    const internals = instance as unknown as { baseOverlay: string; recompose: () => void; runKey: string }
    internals.baseOverlay = '甲 jia3'
    internals.runKey = 'key'
    internals.recompose()
    instance.invalidate()
    expect(internals.runKey).toBe('')
    expect(instance.getOverlay()).toBe('甲 jia3')
  })

  it('关闭开关后 getOverlay 返回空，可一键回退', () => {
    const { instance } = service()
    instance.setLiveOverlay('乙 yi3', 'h')
    instance.setEnabled(false)
    expect(instance.getOverlay()).toBe('')
  })
})

describe('ReaderController.applyLivePronunciations', () => {
  function controller() {
    const reader = Object.assign(Object.create(ReaderController.prototype), {
      settings: { ...DEFAULT_SETTINGS },
      destroyed: false,
      isPlaying: false,
      bookLexicon: {
        setLiveOverlay: vi.fn(() => true),
        getOverlay: vi.fn(() => ''),
      },
      aiSpeech: { initialized: false },
      releaseAiRuntime: vi.fn(),
      speakCurrent: vi.fn(),
    })
    return reader
  }

  it('变化且离线运行时已初始化时释放 runtime，播放中重播当前句', () => {
    const reader = controller()
    reader.aiSpeech.initialized = true
    reader.isPlaying = true
    expect(reader.applyLivePronunciations('乙 yi3', 'h')).toBe(true)
    expect(reader.releaseAiRuntime).toHaveBeenCalledTimes(1)
    expect(reader.speakCurrent).toHaveBeenCalledTimes(1)
  })

  it('未初始化时不重建，等下次 play 自然用新 overlay', () => {
    const reader = controller()
    expect(reader.applyLivePronunciations('乙 yi3', 'h')).toBe(true)
    expect(reader.releaseAiRuntime).not.toHaveBeenCalled()
  })

  it('指纹未变化时不触发任何重建', () => {
    const reader = controller()
    reader.bookLexicon.setLiveOverlay.mockReturnValue(false)
    expect(reader.applyLivePronunciations('', 'same')).toBe(false)
    expect(reader.releaseAiRuntime).not.toHaveBeenCalled()
    expect(reader.speakCurrent).not.toHaveBeenCalled()
  })

  it('destroyed 后完全不响应', () => {
    const reader = controller()
    reader.destroyed = true
    expect(reader.applyLivePronunciations('乙 yi3', 'h')).toBe(false)
    expect(reader.bookLexicon.setLiveOverlay).not.toHaveBeenCalled()
  })
})
