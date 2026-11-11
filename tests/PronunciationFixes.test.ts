import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  UTTERANCE_RESET,
  UTTERANCE_RESET_WORDS,
  WORD_BOUNDARY,
  applyUtteranceResets,
  preparePronunciationText,
  protectPronunciations,
} from '../src/core/tts/pronunciationGuard'

const root = process.cwd()
const overlay = readFileSync(
  resolve(root, 'src/core/tts/polyphones.v1.txt'),
  'utf8',
)
const workerSource = readFileSync(
  resolve(root, 'public/workers/sherpa-tts.worker.js'),
  'utf8',
)

function overlayReading(word: string): string | undefined {
  for (const line of overlay.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...phones] = trimmed.split(/\s+/)
    if (key === word) return phones.join(' ')
  }
  return undefined
}

function loadWorker() {
  const messages: any[] = []
  const context: Record<string, unknown> = {
    console,
    performance,
    Float32Array,
    Uint8Array,
    ArrayBuffer,
    Math,
    Set,
    Map,
    Promise,
    Error,
    Date,
    JSON,
    self: {
      postMessage: (message: any) => messages.push(message),
      close: () => undefined,
      onmessage: null,
    },
  }
  vm.createContext(context)
  vm.runInContext(
    `${workerSource}\n;globalThis.__probe = { utteranceParts, joinUtteranceAudio, UTTERANCE_RESET, synthesize, slots }`,
    context,
  )
  return { probe: (context as any).__probe, messages }
}

describe('2026-11-11 第五次复听：便宜是音素层问题', () => {
  it('占便宜的「宜」回到标准轻声 yi，且是训练过的轻声音素', () => {
    expect(overlayReading('占便宜')).toBe('" zhan4 pian2 yi')
    const neutrals = readFileSync(
      join(root, 'src/core/tts/trainedNeutrals.v1.txt'),
      'utf8',
    ).split(/\r?\n/).map((line) => line.trim())
    expect(neutrals).toContain('yi')
  })

  it('两个阳平 pian2 + yi2 不再出现在覆盖表的「占便宜」行里', () => {
    expect(overlayReading('占便宜')).not.toContain('yi2')
    expect(overlayReading('占便宜')).toContain('pian2')
  })

  it('便宜本身与同类词没有因为改轻声而被误加整词保护', () => {
    expect(protectPronunciations('一些会占便宜的有钱人')).toBe(
      `一些会${WORD_BOUNDARY}占便宜的有钱人`,
    )
  })
})

describe('2026-11-11 第五次复听：地盘是长句韵律问题', () => {
  it('重置词表只登记复听确认过的词，不含便宜', () => {
    expect(UTTERANCE_RESET_WORDS).toContain('地盘')
    expect(UTTERANCE_RESET_WORDS).not.toContain('占便宜')
  })

  it('在「地盘」前插入 U+2060 + U+200B，且保持幂等', () => {
    const sentence = '朱元璋对张士诚极为头疼，自己只是占了点地盘；'
    const prepared = preparePronunciationText(sentence)
    expect(prepared).toBe(
      `朱元璋对张士诚极为头疼，自己只是占了点${UTTERANCE_RESET}${WORD_BOUNDARY}地盘；`,
    )
    expect(preparePronunciationText(prepared)).toBe(prepared)
    expect(applyUtteranceResets(prepared)).toBe(prepared)
  })

  it('句首的重置词、更长的复合词、普通保护词都不触发切分', () => {
    expect(preparePronunciationText('地盘很小。')).toBe('地盘很小。')
    const compound = '占了点地盘之争'
    expect(preparePronunciationText(compound)).toBe(
      `占了点${WORD_BOUNDARY}地盘之争`,
    )
    expect(preparePronunciationText(compound)).not.toContain(UTTERANCE_RESET)
    expect(preparePronunciationText('可能是学会计出身的，')).not.toContain(UTTERANCE_RESET)
  })
})

describe('worker 的语句重置', () => {
  it('只在 matcha 中文下按哨兵切成两段', () => {
    const { probe } = loadWorker()
    expect(probe.UTTERANCE_RESET).toBe(UTTERANCE_RESET)
    const text = `自己只是占了点${UTTERANCE_RESET}${WORD_BOUNDARY}地盘；`
    const parts = probe.utteranceParts(text, true)
    expect(parts).toHaveLength(2)
    expect(parts[1]).toContain('地盘')
    for (const part of parts) expect(part).not.toContain(UTTERANCE_RESET)
    expect(probe.utteranceParts(text, false)).toBeNull()
    expect(probe.utteranceParts('没有标记的一句话。', true)).toBeNull()
  })

  it('拼接保留两段 PCM 并在中间留出 120ms 静音', () => {
    const { probe } = loadWorker()
    const a = new Float32Array(100).fill(0.25)
    const b = new Float32Array(70).fill(-0.5)
    const joined = probe.joinUtteranceAudio(
      [{ samples: a, sampleRate: 1000 }, { samples: b, sampleRate: 1000 }],
      1000,
      120,
    )
    expect(joined.sampleRate).toBe(1000)
    expect(joined.samples.length).toBe(100 + 120 + 70)
    expect(joined.samples[0]).toBeCloseTo(0.25)
    expect(joined.samples[99]).toBeCloseTo(0.25)
    expect(joined.samples[100]).toBe(0)
    expect(joined.samples[219]).toBe(0)
    expect(joined.samples[220]).toBeCloseTo(-0.5)
  })

  it('真实 synth 任务对含「地盘」的句子调用两次合成，普通句子仍只调用一次', async () => {
    const { probe, messages } = loadWorker()
    const slot = probe.slots.zh
    slot.ready = true
    slot.modelType = 'matcha'
    slot.sampleRate = 22050
    slot.numSpeakers = 1
    slot.speakerId = 0
    const calls: string[] = []
    slot.tts = {
      generateWithConfig: (text: string) => {
        calls.push(text)
        return { samples: new Float32Array(2205).fill(0.1), sampleRate: 22050 }
      },
    }

    const job = (jobId: string, text: string) => ({
      type: 'synth', jobId, lang: 'zh', epoch: 1, text, speed: 1,
    })
    await probe.synthesize(job('reset', preparePronunciationText('自己只是占了点地盘；')))
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toContain(UTTERANCE_RESET)
    expect(calls[1]).toContain('地盘')
    const resetResult = messages.find((message) => message.type === 'result')
    expect(resetResult).toBeTruthy()
    expect(resetResult.samples.byteLength / 4).toBe(2205 * 2 + Math.round(22050 * 0.12))

    calls.length = 0
    await probe.synthesize(job('plain', preparePronunciationText('一些会占便宜的有钱人；')))
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain(UTTERANCE_RESET)
  })
})
