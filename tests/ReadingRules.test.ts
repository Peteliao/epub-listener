import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const COMPILER = 'scripts/compile-overlay.mjs'
const IMPACT = 'scripts/audit-impact.mjs'

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
  const dir = await mkdtemp(join(tmpdir(), 'shusheng-rules-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function rule(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'demo-1',
    status: 'approved',
    class: 'phone',
    word: '在行',
    char: '行',
    offset: 1,
    phone: 'hang2',
    boundary: 'keep',
    scope: 'word',
    source: 'manual',
    confidence: 'confirmed',
    evidence: ['他很在行，一下就修好了。'],
    ...overrides,
  })
}

describe('reading rules compiler', () => {
  it('compiles the approved attribution rules idempotently', async () => {
    await withTempDir(async (dir) => {
      const report = join(dir, 'report.json')
      const stdout = ok(COMPILER, [
        `--report=${report}`,
        `--out=${join(dir, 'candidates.txt')}`,
        `--golden=${join(dir, 'golden.jsonl')}`,
      ])
      // Derive the expected count from the asset instead of pinning a number:
      // growing the rule set must not require editing this test by hand.
      const rules = (await readFile(join(root, 'src/core/tts/readingRules.v1.jsonl'), 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const compiledWords = new Set(
        rules
          .filter((rule) => rule.status === 'approved'
            && rule.scope === 'word'
            && rule.class !== 'frontend')
          .map((rule) => String(rule.word)),
      )
      expect(compiledWords.size).toBeGreaterThanOrEqual(12)
      expect(stdout).toContain(`already ${compiledWords.size}`)
      expect(stdout).toContain('冲突 0 条')
      expect(stdout).toContain('意外变化 0 处')

      const parsed = JSON.parse(await readFile(report, 'utf8')) as {
        rows: Array<{ status: string }>
        candidates: unknown[]
        conflicts: unknown[]
      }
      expect(parsed.candidates).toEqual([])
      expect(parsed.conflicts).toEqual([])
      expect(parsed.rows.filter((row) => row.status === 'delegated')).toHaveLength(2)
      expect(parsed.rows.filter((row) => row.status === 'already')).toHaveLength(compiledWords.size)
    })
  }, 20_000)

  it('compiles a new rule into a candidate line, golden case and impact report', async () => {
    await withTempDir(async (dir) => {
      const rules = join(dir, 'rules.jsonl')
      const corpus = join(dir, 'corpus.txt')
      const candidates = join(dir, 'candidates.txt')
      const report = join(dir, 'report.json')
      const golden = join(dir, 'golden.jsonl')
      await writeFile(
        rules,
        [
          rule(),
          rule({
            id: 'demo-2', word: '大都', char: '都', offset: 1,
            phone: 'dou1', evidence: ['元大都是一座城。'],
          }),
        ].join('\n') + '\n',
        'utf8',
      )
      await writeFile(corpus, '元大都是一座城，大都的城墙很高。\n', 'utf8')

      const stdout = ok(COMPILER, [
        `--rules=${rules}`,
        `--corpus=${corpus}`,
        `--out=${candidates}`,
        `--report=${report}`,
        `--golden=${golden}`,
      ])
      expect(stdout).toContain('目标变化 2 处 / 意外变化 0 处')
      expect(await readFile(candidates, 'utf8')).toContain('大都 da4 dou1')

      const parsed = JSON.parse(await readFile(report, 'utf8')) as {
        candidates: unknown[]
        golden: unknown[]
        impact: { intended: number; unexpected: number }
      }
      expect(parsed.candidates).toHaveLength(2)
      expect(parsed.golden).toHaveLength(2)
      expect(parsed.impact.unexpected).toBe(0)
    })
  }, 20_000)

  it('passes the impact gate when a candidate has no unexpected changes', async () => {
    await withTempDir(async (dir) => {
      const overlay = join(dir, 'candidates.txt')
      const corpus = join(dir, 'corpus.txt')
      await writeFile(overlay, '# 候选\n大都 da4 dou1\n', 'utf8')
      await writeFile(corpus, '元大都是一座城。\n', 'utf8')
      const stdout = ok(IMPACT, [
        `--overlay=${overlay}`,
        `--corpus=${corpus}`,
        `--out=${join(dir, 'impact.json')}`,
        '--fail-on-unexpected',
      ])
      expect(stdout).toContain('零意外变化')
    })
  }, 20_000)

  it('requires --confirm and refuses to overwrite a conflicting curated line', async () => {
    await withTempDir(async (dir) => {
      const rules = join(dir, 'rules.jsonl')
      const target = join(dir, 'overlay.txt')
      await writeFile(rules, `${rule({
        word: '率意', char: '率', offset: 0, phone: 'lv4',
        evidence: ['而是率意而为，打到哪儿算哪儿。'],
      })}\n`, 'utf8')
      await writeFile(target, '# 演练\n率意 shuai4 yi4\n', 'utf8')

      const conflicted = run(COMPILER, [
        `--rules=${rules}`,
        `--out=${join(dir, 'candidates.txt')}`,
        `--report=${join(dir, 'report.json')}`,
        `--golden=${join(dir, 'golden.jsonl')}`,
        '--apply', '--confirm', `--target-overlay=${target}`,
      ])
      expect(conflicted.status).not.toBe(0)
      expect(conflicted.stdout + conflicted.stderr).toContain('冲突')
      expect(await readFile(target, 'utf8')).not.toContain('率意 lv4 yi4')

      const noConfirm = run(COMPILER, [
        '--apply',
        `--out=${join(dir, 'candidates2.txt')}`,
        `--report=${join(dir, 'report2.json')}`,
        `--golden=${join(dir, 'golden2.jsonl')}`,
        `--target-overlay=${target}`,
      ])
      expect(noConfirm.status).not.toBe(0)
      expect(noConfirm.stdout + noConfirm.stderr).toContain('--confirm')
    })
  }, 20_000)

  it('detects unexpected reading changes caused by segmentation drift', async () => {
    // @ts-ignore -- dev-only ESM helper has no type declarations
    const { compareReadingChanges } = await import('../scripts/lib/impact.mjs')
    const before = new Map([
      ['地盘', 'di4 pan2'],
      ['之争', 'zhi1 zheng1'],
    ])
    const after = new Map([
      ...before,
      ['地盘之', 'di4 pan2 zhi1'],
    ])
    const report = compareReadingChanges({
      text: '地盘之争。',
      before,
      after,
      changedWords: new Set(['地盘之']),
    })
    expect(report.total).toBeGreaterThan(0)
    expect(report.unexpected).toBeGreaterThan(0)
    expect(report.samples.some((item: { intentional: boolean }) => !item.intentional)).toBe(true)
  }, 20_000)
})
