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

describe('2026-11-23 第十七轮：真正双盲 A/B', () => {
  it('随机代号固定种子可复现，且不暴露版本信息', async () => {
    const { buildBlindPlan, publicManifest } = await loadAb()
    const ids = ['a', 'b', 'c']
    const one = buildBlindPlan(ids, { seed: 'unit-seed' })
    const two = buildBlindPlan(ids, { seed: 'unit-seed' })
    const other = buildBlindPlan(ids, { seed: 'other-seed' })
    expect(one).toEqual(two)
    expect(one).not.toEqual(other)
    const codes = one.items.flatMap((item: any) => item.order)
    expect(new Set(codes).size).toBe(6)
    expect(codes.join('')).not.toMatch(/before|after/i)
    expect(JSON.stringify(publicManifest(one))).not.toContain('key')
  })

  it('评分表只含随机代号，完成后才可统计', async () => {
    const { buildBlindPlan, publicManifest } = await loadAb()
    const { createBlindScoreSheet, validateBlindScoreSheet } = await loadScore()
    const bundle = publicManifest(buildBlindPlan(['x', 'y'], { seed: 'sheet' }))
    const sheet = createBlindScoreSheet({ bundle, rater: 'rater-1' })
    expect(JSON.stringify(sheet)).not.toContain('before')
    expect(validateBlindScoreSheet(sheet).complete).toBe(false)
    fill(sheet, [4, 3])
    const result = validateBlindScoreSheet(sheet)
    expect(result.complete).toBe(true)
    expect(result.items.every((item: any) => item.codes.length === 2)).toBe(true)
  })

  it('解盲后输出每名评分者结果与一致性', async () => {
    const { buildBlindPlan, revealScores } = await loadAb()
    const { createBlindScoreSheet } = await loadScore()
    const plan = buildBlindPlan(['x'], { seed: 'reveal' })
    const key = { seed: plan.seed, items: plan.items.map(({ id, key: mapping }: any) => ({ id, ...mapping })) }
    const manifest = { seed: plan.seed, items: [{ id: 'x', codes: plan.items[0].order }] }
    const mapping = plan.items[0].key
    const first = fill(createBlindScoreSheet({ bundle: manifest, rater: 'r1' }), [5, 2], mapping)
    const second = fill(createBlindScoreSheet({ bundle: manifest, rater: 'r2' }), [2, 5], mapping)
    const result = revealScores([first, second], key, manifest)
    expect(result.raters).toHaveLength(2)
    expect(result.raters[0].items[0].preferred).toBe(key.items[0].before)
    expect(result.raters[1].items[0].preferred).toBe(key.items[0].after)
    expect(result.agreement).toBe(0)
  })

  it('响度归一化只作用于评测副本，WAV 可往返', async () => {
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
