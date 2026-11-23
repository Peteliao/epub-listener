import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function loadAb(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/blindAb.mjs')
}

async function loadScore(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/blindScore.mjs')
}

async function loadWav(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/wav.mjs')
}

function fill(sheet: any, values: [number, number], mapping?: any) {
  for (const [index, item] of sheet.items.entries()) {
    for (const code of item.codes) {
      const value = mapping && code === mapping.before ? values[0] : values[1]
      for (const key of ['pronunciation', 'clarity', 'naturalness', 'prosody', 'emotion']) {
        item.scores[code][key] = value + index
      }
    }
  }
  return sheet
}

describe('2026-11-23 第十八轮：双盲保密与响度归一化', () => {
  it('每轮默认使用随机种子和实验 ID，公开清单不含 seed', async () => {
    const { buildBlindPlan, publicManifest } = await loadAb()
    const ids = ['a', 'b', 'c']
    const one = buildBlindPlan(ids)
    const two = buildBlindPlan(ids)
    expect(one.seed).not.toBe(two.seed)
    expect(one.experimentId).not.toBe(two.experimentId)
    expect(one.items).not.toEqual(two.items)
    const manifest = publicManifest(one)
    expect(manifest.experimentId).toBe(one.experimentId)
    expect(manifest.seed).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain(one.seed)
    expect(JSON.stringify(manifest)).not.toContain('key')
    const codes = one.items.flatMap((item: any) => item.order)
    expect(new Set(codes).size).toBe(6)
    expect(codes.join('')).not.toMatch(/before|after/i)
  })

  it('显式种子仅用于复现，固定后计划可重复', async () => {
    const { buildBlindPlan } = await loadAb()
    const one = buildBlindPlan(['a', 'b'], { seed: 'unit-seed', experimentId: 'exp-unit' })
    const two = buildBlindPlan(['a', 'b'], { seed: 'unit-seed', experimentId: 'exp-unit' })
    const other = buildBlindPlan(['a', 'b'], { seed: 'other-seed', experimentId: 'exp-unit' })
    expect(one).toEqual(two)
    expect(one.items).not.toEqual(other.items)
  })

  it('评分表只含随机代号和实验 ID，完成后才可统计', async () => {
    const { buildBlindPlan, publicManifest } = await loadAb()
    const { createBlindScoreSheet, validateBlindScoreSheet } = await loadScore()
    const bundle = publicManifest(buildBlindPlan(['x', 'y'], {
      seed: 'sheet', experimentId: 'exp-sheet',
    }))
    const sheet = createBlindScoreSheet({ bundle, rater: 'rater-1' })
    expect(sheet.experimentId).toBe('exp-sheet')
    expect(JSON.stringify(sheet)).not.toContain('before')
    expect(JSON.stringify(sheet)).not.toContain('"seed"')
    expect(validateBlindScoreSheet(sheet).complete).toBe(false)
    fill(sheet, [4, 3])
    const result = validateBlindScoreSheet(sheet)
    expect(result.complete).toBe(true)
    expect(result.items.every((item: any) => item.codes.length === 2)).toBe(true)
  })

  it('解盲后输出每名评分者结果与一致性', async () => {
    const { buildBlindPlan, publicManifest, revealScores } = await loadAb()
    const { createBlindScoreSheet } = await loadScore()
    const plan = buildBlindPlan(['x'], { seed: 'reveal', experimentId: 'exp-reveal' })
    const key = {
      experimentId: plan.experimentId,
      seed: plan.seed,
      items: plan.items.map(({ id, key: mapping }: any) => ({ id, ...mapping })),
    }
    const manifest = publicManifest(plan)
    const mapping = plan.items[0].key
    const first = fill(createBlindScoreSheet({ bundle: manifest, rater: 'r1' }), [5, 2], mapping)
    const second = fill(createBlindScoreSheet({ bundle: manifest, rater: 'r2' }), [2, 5], mapping)
    const result = revealScores([first, second], key, manifest)
    expect(result.experimentId).toBe('exp-reveal')
    expect(result.raters).toHaveLength(2)
    expect(result.raters[0].items[0].preferred).toBe(key.items[0].before)
    expect(result.raters[1].items[0].preferred).toBe(key.items[0].after)
    expect(result.agreement).toBe(0)
  })

  it('未完成、重复评分者或跨实验的评分表拒绝解盲', async () => {
    const { buildBlindPlan, publicManifest, revealScores } = await loadAb()
    const { createBlindScoreSheet } = await loadScore()
    const plan = buildBlindPlan(['x'], { seed: 'guard', experimentId: 'exp-guard' })
    const key = {
      experimentId: plan.experimentId,
      seed: plan.seed,
      items: plan.items.map(({ id, key: mapping }: any) => ({ id, ...mapping })),
    }
    const manifest = publicManifest(plan)
    const incomplete = createBlindScoreSheet({ bundle: manifest, rater: 'r1' })
    expect(() => revealScores([incomplete], key, manifest)).toThrow(/未完成/)

    const complete = fill(createBlindScoreSheet({ bundle: manifest, rater: 'r1' }), [4, 3])
    expect(() => revealScores([complete, complete], key, manifest)).toThrow(/重复评分者/)

    const other = fill(createBlindScoreSheet({
      bundle: { ...manifest, experimentId: 'exp-other' }, rater: 'r2',
    }), [4, 3])
    expect(() => revealScores([complete, other], key, manifest)).toThrow(/另一个实验/)
  })

  it('活动语音 RMS 归一化忽略停顿，并保留峰值上限', async () => {
    const { measureSpeechLevel, normalizeLoudness } = await loadWav()
    const rate = 22050
    const tone = (ms: number, amplitude: number) => {
      const length = Math.round((rate * ms) / 1000)
      const samples = new Float32Array(length)
      for (let index = 0; index < length; index += 1) {
        samples[index] = Math.sin((2 * Math.PI * 220 * index) / rate) * amplitude
      }
      return samples
    }
    const speech = tone(400, 0.1)
    const withPause = new Float32Array(speech.length + rate * 2)
    withPause.set(speech, 0)
    const levelSpeech = measureSpeechLevel(speech, rate)
    const levelPause = measureSpeechLevel(withPause, rate)
    expect(levelPause.activeRms).toBeCloseTo(levelSpeech.activeRms, 4)

    const normalized = normalizeLoudness(withPause, rate)
    const levelNormalized = measureSpeechLevel(normalized, rate)
    expect(levelNormalized.activeDb).toBeCloseTo(-20, 0)
    expect(levelNormalized.peak).toBeLessThanOrEqual(0.9501)

    // A quiet version with the same active speech must reach the same level.
    const quiet = normalizeLoudness(tone(400, 0.02), rate)
    expect(measureSpeechLevel(quiet, rate).activeDb).toBeCloseTo(-20, 0)

    // A loud transient limits gain so the evaluation copy never clips.
    const transient = new Float32Array(speech.length + 10)
    transient.set(speech, 0)
    transient[speech.length + 5] = 0.99
    const limited = normalizeLoudness(transient, rate)
    expect(Math.max(...limited)).toBeLessThanOrEqual(0.9501)
  })

  it('WAV 可往返，原始样本不被归一化修改', async () => {
    const { normalizePeak, readWav, writeWav } = await loadWav()
    const dir = mkdtempSync(join(tmpdir(), 'blind-wav-'))
    try {
      const file = join(dir, 'copy.wav')
      const samples = new Float32Array(1000).fill(0.2)
      writeWav(file, samples, 22050)
      const read = readWav(file)
      expect(read.sampleRate).toBe(22050)
      expect(read.samples.length).toBe(1000)
      expect(read.samples[0]).toBeCloseTo(0.2, 4)
      const normalized = normalizePeak(samples)
      expect(Math.max(...normalized)).toBeCloseTo(0.9, 4)
      expect(samples[0]).toBeCloseTo(0.2, 6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
