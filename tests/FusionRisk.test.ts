import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const AUTO = 'scripts/auto-pronunciation-loop.mjs'
const OVERLAY = join(root, 'src/core/tts/polyphones.v1.txt')
const SENTENCE = '也就是在此前不久，一个人来到了洪都，他是受朱元璋委派来此地镇守的。'

// Dev-only ESM helpers have no declarations; TypeScript otherwise resolves
// them to Vite's generic asset-module shape instead of their real exports.
async function loadFusion(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/fusionRisk.mjs')
}

async function loadReading(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/reading.mjs')
}

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

describe('syllable fusion detection', () => {
  it('splits a syllable and blends lai2 + dao4 into lao', async () => {
    const { splitSyllable, blendSyllable, isFusionRisk } = await loadFusion()
    expect(splitSyllable('lai2')).toEqual({ initial: 'l', final: 'ai', tone: '2', base: 'lai' })
    expect(splitSyllable('dao4')).toEqual({ initial: 'd', final: 'ao', tone: '4', base: 'dao' })
    expect(blendSyllable('lai2', 'dao4')).toBe('lao')
    expect(blendSyllable('ta1', 'shi4')).toBeNull()
    expect(blendSyllable('hong2', 'du1')).toBeNull()
    expect(isFusionRisk('lai2', 'dao4', new Set(['lao3']))).toBe(true)
    expect(isFusionRisk('lai2', 'dao4', new Set(['xyz']))).toBe(false)
  })

  it('rediscovers 「来到了」 on the pre-fix lexicon and not intact words', async () => {
    const { scanFusionRisks } = await loadFusion()
    const { loadMatchaAssets, maxWordLength } = await loadReading()
    const assets = await loadMatchaAssets()
    const baseline = new Map(assets.effective)
    baseline.delete('来到了')
    baseline.delete('来到')
    const risks = scanFusionRisks(SENTENCE, {
      ...assets,
      effective: baseline,
      maxLength: maxWordLength(baseline),
    })
    const found = risks.find((risk: any) => risk.word === '来到了')
    expect(found).toBeTruthy()
    expect(found.blend).toBe('lao')
    expect(found.confidence).toBe('high')
    expect(found.phones).toEqual(['lai2', 'dao4', 'le'])
    expect(risks.some((risk: any) => risk.word === '洪都')).toBe(false)
  })

  it('generates the whole-word overlay line with a word-final boundary', async () => {
    const { fixLine } = await loadFusion()
    expect(fixLine({ word: '来到了', phones: ['lai2', 'dao4', 'le'] }))
      .toBe('来到了 lai2 dao4 le "')
  })

  it('keeps the reported fix in the curated overlay', async () => {
    const overlay = await readFile(OVERLAY, 'utf8')
    expect(overlay).toMatch(/^来到 lai2 dao4$/m)
    expect(overlay).toMatch(/^来到了 lai2 dao4 le "$/m)
  })
})

describe('P3 self-iteration gate', () => {
  it('passes --verify with every recorded fix still discoverable', async () => {
    const result = run(AUTO, ['--verify'])
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('通过')
    const report = JSON.parse(
      await readFile(join(root, 'scripts/out/fusion-verify.json'), 'utf8'),
    ) as { passed: number; total: number; checks: Array<{ ok: boolean }> }
    expect(report.passed).toBe(report.total)
    expect(report.checks.every((check) => check.ok)).toBe(true)
  }, 20_000)

  it('scans a book corpus without WASM and ranks high-confidence risks first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-fusion-'))
    try {
      const corpus = join(dir, 'book.txt')
      const out = join(dir, 'auto.json')
      const risks = join(dir, 'risks.jsonl')
      await writeFile(corpus, [
        SENTENCE,
        '他走到了门口，回头看了一眼。',
        '朱棣回到了北平，开始重新布置防务。',
        '皇帝看到了报告，深感自己做了大好事。',
      ].join('\n'), 'utf8')
      const result = run(AUTO, [
        `--corpus=${corpus}`,
        `--out=${out}`,
        `--summary=${join(dir, 'summary.md')}`,
        `--risks=${risks}`,
        `--history=${join(dir, 'history.jsonl')}`,
        '--limit=3',
      ])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8')) as { highConfidence: number }
      expect(report.highConfidence).toBeGreaterThan(0)
      const rows = (await readFile(risks, 'utf8'))
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { confidence: string })
      expect(rows.some((row) => row.confidence === 'high')).toBe(true)
      expect(rows[0].confidence).toBe('high')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('is wired into audit:all as a required gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-p3-gate-'))
    try {
      const out = join(dir, 'gates.json')
      const result = run('scripts/audit-all.mjs', ['--only=P3', `--out=${out}`])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8')) as {
        gates: Array<{ name: string; status: number; required: boolean }>
      }
      expect(report.gates).toHaveLength(1)
      expect(report.gates[0].name).toContain('P3')
      expect(report.gates[0].required).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
