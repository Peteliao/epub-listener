import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'scripts', 'baseline-polyphones.mjs')

function run(extraArgs: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, '--json', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

describe('基线测量脚本输出格式', () => {
  it('产出可解析的 JSON，且明确区分静态一致率与听感正确率', () => {
    const result = run()
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.metric).toBe('static-lexicon-phoneme-agreement')
    // A/B listening scores can only be produced by a human; never invent one.
    expect(report.listeningAccuracy).toBeNull()
    expect(report.listeningAccuracyNote).toContain('人工')

    for (const key of ['golden', 'regression', 'combined']) {
      const stats = report[key]
      expect(stats.cases).toBeGreaterThan(0)
      expect(stats.points).toBeGreaterThan(0)
      expect(stats.matched + stats.mismatched).toBe(stats.points)
      expect(stats.accuracy).toBeGreaterThanOrEqual(0)
      expect(stats.accuracy).toBeLessThanOrEqual(1)
    }
    expect(report.combined.cases).toBe(
      report.golden.cases + report.regression.cases,
    )
    expect(report.assets.curatedOverlayEntries).toBeGreaterThan(0)
  })

  it('--out 写入同一份结构化结果', () => {
    const out = join(ROOT, 'scripts', 'out', 'baseline-polyphones-test.json')
    const result = run([`--out=${out}`])
    expect(result.status).toBe(0)
    const file = JSON.parse(readFileSync(out, 'utf8'))
    expect(file.metric).toBe('static-lexicon-phoneme-agreement')
    expect(file.golden.accuracy).toBe(1)
  })
})
