import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const HEALTH = 'scripts/pronunciation-health.mjs'
const LOOP = 'scripts/feedback-loop.mjs'
const AUDIT_ALL = 'scripts/audit-all.mjs'

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

function ok(script: string, args: string[]): string {
  const result = run(script, args)
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  return result.stdout
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shusheng-health-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface HealthReport {
  generatedAt: string
  assets: { overlayEntries: number; goldenCases: number }
  regressions: { golden: { mismatches: number } | null; compileConflicts: number }
  cost: { humanDecisionPoints: number; leverage: number }
  gates: { available: boolean; score: number | null }
  trend: { available: boolean; delta?: Record<string, number | null> }
}

async function health(dir: string, extra: string[] = []): Promise<HealthReport> {
  ok(HEALTH, [
    `--out=${join(dir, 'health.json')}`,
    `--summary=${join(dir, 'health.md')}`,
    `--history=${join(dir, 'history.jsonl')}`,
    '--gates=scripts/out/gate-results.json',
    ...extra,
  ])
  return JSON.parse(await readFile(join(dir, 'health.json'), 'utf8')) as HealthReport
}

describe('pronunciation health scorecard', () => {
  it('reports assets, zero golden regressions and a convergence trend', async () => {
    await withTempDir(async (dir) => {
      const first = await health(dir)
      expect(first.assets.overlayEntries).toBeGreaterThan(1000)
      expect(first.assets.goldenCases).toBeGreaterThan(150)
      expect(first.regressions.golden?.mismatches).toBe(0)
      expect(first.regressions.compileConflicts).toBe(0)
      expect(first.trend.available).toBe(false)

      const second = await health(dir)
      expect(second.trend.available).toBe(true)
      expect(second.trend.delta?.humanDecisionPoints).toBe(0)
      const history = (await readFile(join(dir, 'history.jsonl'), 'utf8'))
        .split(/\r?\n/).filter(Boolean)
      expect(history).toHaveLength(2)
      expect(await readFile(join(dir, 'health.md'), 'utf8')).toContain('收敛趋势')
    })
  }, 60_000)

  it('does not append history with --no-history (CI mode)', async () => {
    await withTempDir(async (dir) => {
      await health(dir)
      await health(dir, ['--no-history'])
      const history = (await readFile(join(dir, 'history.jsonl'), 'utf8'))
        .split(/\r?\n/).filter(Boolean)
      expect(history).toHaveLength(1)
    })
  }, 60_000)
})

describe('feedback close loop', () => {
  it('closes the entire 2026-11-09 batch with zero human decisions', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'loop.json')
      const stdout = ok(LOOP, [
        '--verify',
        `--out=${out}`,
        `--rule-candidates=${join(dir, 'rules.jsonl')}`,
        `--exception-candidates=${join(dir, 'exceptions.jsonl')}`,
      ])
      expect(stdout).toContain('9/9 通过')
      const report = JSON.parse(await readFile(out, 'utf8')) as {
        totals: {
          feedback: number
          closed: number
          humanDecisionPoints: number
          automationPercent: number
        }
      }
      expect(report.totals.feedback).toBe(9)
      expect(report.totals.closed).toBe(9)
      expect(report.totals.humanDecisionPoints).toBe(0)
      expect(report.totals.automationPercent).toBe(100)
    })
  }, 60_000)
})

describe('CI gate orchestration', () => {
  it('runs a single named gate and records its result', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'gates.json')
      ok(AUDIT_ALL, [`--out=${out}`, '--only=反馈闭环'])
      const report = JSON.parse(await readFile(out, 'utf8')) as {
        gates: Array<{ name: string; status: number; skipped: boolean }>
      }
      expect(report.gates).toHaveLength(1)
      expect(report.gates[0].name).toContain('反馈闭环')
      expect(report.gates[0].status).toBe(0)
      expect(report.gates[0].skipped).toBe(false)
    })
  }, 60_000)
})
