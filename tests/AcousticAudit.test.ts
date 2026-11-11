import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const AUDIT = 'scripts/audit-acoustics.mjs'

// The dev-only .mjs helpers have no declarations; TypeScript otherwise resolves
// them to Vite's generic asset-module shape instead of their real exports.
async function loadScoring(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/acousticScoring.mjs')
}

async function loadSynth(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/matchaSynth.mjs')
}

describe('acoustic scoring policy', () => {
  it('classifies swallowed, normal and merged syllables from real A/B numbers', async () => {
    const { classifyContribution, scoreContributions } = await loadScoring()
    expect(classifyContribution(59)).toBe('swallowed')
    expect(classifyContribution(200)).toBe('normal')
    expect(classifyContribution(453)).toBe('merged')

    // 占便宜: appending a boundary to a 3-character word collapsed pian2.
    expect(scoreContributions([58, 162, 232]))
      .toBeGreaterThan(scoreContributions([70, 59, 128]))
    // 最先: zui4 383ms absorbed xian1; the boundary restores balance.
    expect(scoreContributions([301, 232]))
      .toBeGreaterThan(scoreContributions([383, 186]))
  })

  it('never auto-recommends a trailing boundary for 3-character words', async () => {
    const { chooseVariant } = await loadScoring()
    const variant = (mode: string, score: number) => ({
      mode, score, values: [], min: 0, max: 0, states: [], reason: '',
    })
    const threeChar = chooseVariant([
      variant('none', 103.2),
      variant('tail', 84.7),
      variant('current', 103.2),
    ], 3)
    expect(threeChar.recommendation).not.toBe('tail')
    expect(threeChar.best.mode).not.toBe('tail')
    expect(threeChar.requiresHuman).toBe(true)

    const twoChar = chooseVariant([
      variant('none', 150.4),
      variant('tail', 192.3),
      variant('current', 150.4),
    ], 2)
    expect(twoChar.recommendation).toBe('tail')
    expect(twoChar.requiresHuman).toBe(true)
  })
})

describe('real WASM acoustic audit', () => {
  it('loads the committed runtime and measures syllable durations', async () => {
    const { createMatchaSynth } = await loadSynth()
    const synth = await createMatchaSynth()
    try {
      const tokens = ['ying1', 'li4', 'ji2', '.']
      expect(synth.duration(tokens)).toBeGreaterThan(500)
      const values = synth.contributions(tokens, [0, 1, 2])
      expect(values).toHaveLength(3)
      expect(values.every((value: number) => Number.isFinite(value))).toBe(true)
    } finally {
      synth.free()
    }
  }, 90_000)

  it('verifies the first listener case end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-acoustics-'))
    try {
      const out = join(dir, 'report.json')
      const summary = join(dir, 'summary.md')
      const exceptions = join(dir, 'exceptions.jsonl')
      const result = spawnSync(
        process.execPath,
        [
          AUDIT, '--verify', '--limit=1', '--no-audio',
          `--out=${out}`,
          `--summary=${summary}`,
          `--exceptions=${exceptions}`,
        ],
        { cwd: root, encoding: 'utf8' },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('1/1 通过')

      const report = JSON.parse(await readFile(out, 'utf8')) as {
        cases: Array<{
          word: string
          requiresHuman: boolean
          forbiddenTail: boolean
          baseline: { values: number[] }
          variants: Array<{ mode: string }>
        }>
        policy: { forbidTailOnThreeCharWords: boolean; requiresHumanConfirmation: boolean }
      }
      expect(report.cases).toHaveLength(1)
      expect(report.cases[0].word).toBe('应立即')
      expect(report.cases[0].requiresHuman).toBe(true)
      expect(report.cases[0].forbiddenTail).toBe(true)
      expect(report.cases[0].baseline.values).toHaveLength(3)
      expect(report.cases[0].variants.map((item) => item.mode)).toContain('tail')
      expect(report.policy.forbidTailOnThreeCharWords).toBe(true)
      expect(report.policy.requiresHumanConfirmation).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
