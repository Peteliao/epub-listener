import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/types'

interface Summary {
  n: number
  synthMsMean: number
  rtfMean: number
  audioMsMean: number
  silenceRatio: number
  rms: number
  peak: number
}

interface WorkerRun {
  initMs: number
  warmupMs: number
  heapBytes: number
  releasedModelBytes: number
  memfs: Array<{ name: string; exists: boolean }>
  sentences: Summary
  durationDrift: number
}

interface Baseline {
  'noise-0.5': WorkerRun
  'noise-0.667': WorkerRun
  'noise-0.8': WorkerRun
  'silence-0.8': Summary
  'silence-1': Summary
  'silence-1.2': Summary
  'group-60': Summary & { chars: number }
  'group-90': Summary & { chars: number }
  'group-120': Summary & { chars: number }
  synthesisAfterRelease: boolean
  samples?: Record<string, number[]>
}

interface Analysis {
  metric: string
  direction: 'lower' | 'none'
  summary: Array<{ label: string; mean: number; ci95: [number, number] }>
  F: number
  etaSquared: number
  permutationP: number
  significant: boolean
  best: string | null
}

const root = process.cwd()
function loadJson<T>(name: string): T {
  return JSON.parse(
    readFileSync(resolve(root, 'tests/fixtures', name), 'utf8'),
  ) as T
}
const runs = [
  loadJson<Baseline>('ab-baseline.json'),
  loadJson<Baseline>('ab-baseline-run2.json'),
  loadJson<Baseline>('ab-baseline-run3.json'),
]
const [baseline, , randomised] = runs
const stats = loadJson<{ analyses: Analysis[] }>('ab-statistics.json')
const statsRerun = loadJson<{ analyses: Analysis[] }>('ab-statistics-run2.json')
const analysis = (metric: string): Analysis => {
  const found = stats.analyses.find((item) => item.metric.startsWith(metric))
  if (!found) throw new Error(`缺少统计分析：${metric}`)
  return found
}
const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/manifest.json'), 'utf8'),
) as {
  packs: Array<{ id: string; model: { config: { noiseScale: number } } }>
}
const shanlan = manifest.packs.find(
  (pack) => pack.id === 'matcha-icefall-zh-baker',
)!

describe('山岚 A/B baseline (real WASM, 20 fixed sentences)', () => {
  it('uses a randomised, repeated grid before claiming an optimum', () => {
    expect(randomised.samples).toBeDefined()
    for (const key of ['noise-0.5', 'noise-0.667', 'noise-0.8']) {
      expect(randomised.samples?.[key]?.length).toBeGreaterThanOrEqual(10)
    }
    const noise = analysis('noiseScale')
    expect(noise.significant).toBe(true)
    expect(noise.permutationP).toBeLessThan(0.01)
    expect(noise.etaSquared).toBeGreaterThan(0.5)
    expect(noise.best).toBe('0.667')
    // The 0.667 CI must not overlap the other two.
    const ci = new Map(noise.summary.map((row) => [row.label, row.ci95]))
    expect(ci.get('0.667')![1]).toBeLessThan(ci.get('0.5')![0])
    expect(ci.get('0.667')![1]).toBeLessThan(ci.get('0.8')![0])
    expect(shanlan.model.config.noiseScale).toBe(0.667)
    expect(DEFAULT_SETTINGS.labNoiseScale).toBeNull()
  })

  it('reproduces the statistical conclusion in a second randomised run', () => {
    const find = (source: typeof stats, metric: string) => {
      const found = source.analyses.find((item) => item.metric.startsWith(metric))
      if (!found) throw new Error(`缺少统计分析：${metric}`)
      return found
    }
    for (const source of [stats, statsRerun]) {
      expect(find(source, 'noiseScale').significant).toBe(true)
      expect(find(source, 'noiseScale').best).toBe('0.667')
      expect(find(source, 'noiseScale').permutationP).toBeLessThan(0.01)
      expect(find(source, 'silenceScale').significant).toBe(true)
      expect(find(source, 'groupChars').significant).toBe(true)
      expect(find(source, 'groupChars').permutationP).toBeLessThan(0.05)
    }
  })

  it('keeps silenceScale 1 as a listening choice, not a measured optimum', () => {
    const silence = analysis('silenceScale')
    expect(silence.significant).toBe(true)
    expect(silence.direction).toBe('none')
    expect(silence.best).toBeNull()
    for (const run of runs) {
      expect(run['silence-0.8'].silenceRatio).toBeLessThan(
        run['silence-1'].silenceRatio,
      )
      expect(run['silence-1'].silenceRatio).toBeLessThan(
        run['silence-1.2'].silenceRatio,
      )
    }
    expect(DEFAULT_SETTINGS.labSilenceScale).toBe(1)
  })

  it('justifies the 90-character group cap', () => {
    // The exact ratio drifts between machines (1.23–1.34×); significance and
    // a consistent ordering are the durable evidence, not a fixed threshold.
    expect(baseline['group-120'].synthMsMean).toBeGreaterThan(
      baseline['group-90'].synthMsMean * 1.15,
    )
    expect(baseline['group-120'].peak).toBeGreaterThan(
      baseline['group-90'].peak,
    )
    const group = analysis('groupChars')
    expect(group.significant).toBe(true)
    expect(group.permutationP).toBeLessThan(0.05)
    const means = new Map(group.summary.map((row) => [row.label, row.mean]))
    expect(means.get('120')).toBeGreaterThan(means.get('90')! * 1.15)
    expect(means.get('90')).toBeLessThan(means.get('120')!)
    expect(means.get('60')).toBeLessThan(means.get('90')!)
  })

  it('reproduces the same ordering on three independent runs', () => {
    for (const run of runs) {
      expect(Math.min(...[
        run['noise-0.5'].sentences.rtfMean,
        run['noise-0.667'].sentences.rtfMean,
        run['noise-0.8'].sentences.rtfMean,
      ])).toBe(run['noise-0.667'].sentences.rtfMean)
      expect(run['group-120'].synthMsMean).toBeGreaterThan(
        run['group-90'].synthMsMean * 1.15,
      )
      expect(run.synthesisAfterRelease).toBe(true)
    }
  })

  it('released both ONNX copies from MEMFS and kept synthesis working', () => {
    for (const run of runs) {
      for (const key of [
        'noise-0.5',
        'noise-0.667',
        'noise-0.8',
      ] as const) {
        const worker = run[key]
        expect(worker.releasedModelBytes).toBeGreaterThan(120_000_000)
        expect(worker.sentences.n).toBeGreaterThan(0)
        expect(worker.sentences.rms).toBeGreaterThan(0.1)
        const files = new Map(
          worker.memfs.map((item) => [item.name, item.exists]),
        )
        expect(files.get('model-steps-3.onnx')).toBe(false)
        expect(files.get('vocos-22khz-univ.onnx')).toBe(false)
        expect(files.get('lexicon.v3.txt')).toBe(true)
        expect(files.get('tokens.txt')).toBe(true)
        expect(files.get('phone.fst')).toBe(true)
      }
    }
  })
})
