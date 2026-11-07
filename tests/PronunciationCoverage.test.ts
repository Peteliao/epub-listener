import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('山岚 sample-book coverage', () => {
  it('keeps multi-character words and neutral tones covered', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/audit-coverage.mjs', 'public/sample.epub', '--top=5'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

    const hit = /多字词命中 \d+\/\d+（(\d+\.\d+)%）/.exec(result.stdout)
    expect(hit, result.stdout).not.toBeNull()
    expect(Number(hit![1])).toBeGreaterThanOrEqual(80)

    // A new neutral gap means a common word lost its curated reading; the
    // audit output lists it so it can be reviewed and pinned to the golden set.
    expect(result.stdout).toContain(
      '词库标全调、参考为轻声（高可信候选）：0 个词 / 0 次',
    )
  })
})
