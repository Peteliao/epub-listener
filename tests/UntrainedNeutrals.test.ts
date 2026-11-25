import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const AUDIT = 'scripts/audit-untrained-neutrals.mjs'

async function loadAudit(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/untrainedNeutrals.mjs')
}

function run(args: string[]) {
  return spawnSync(process.execPath, [AUDIT, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  })
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shusheng-neutrals-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('base-lexicon untrained neutrals', () => {
  it('uses last-line-wins, excludes toneless whitelist phones and stable-sorts risks', async () => {
    const { findUntrainedNeutrals, parseNeutralWhitelist } = await loadAudit()
    const lexicon = [
      '# base fixture',
      '笹 ti',
      '甲 ti4',
      '训 de',
      '乙 ti',
      '笹 ti4', // duplicate: the runtime's final row is tonal, so no risk
      '词组 ti',
      '啊 a',
    ].join('\n')
    expect(parseNeutralWhitelist('# trained\nde\n')).toEqual(new Set(['de']))
    expect(findUntrainedNeutrals(lexicon, 'de\n')).toEqual([
      { char: '乙', phone: 'ti', lexiconLine: 5 },
      { char: '啊', phone: 'a', lexiconLine: 8 },
    ])
  })

  it('lists only literal corpus hits with counts and first context', async () => {
    const { selectCorpusHits } = await loadAudit()
    const risks = [
      { char: '乙', phone: 'ti', lexiconLine: 5 },
      { char: '啊', phone: 'a', lexiconLine: 8 },
      { char: '笹', phone: 'ti', lexiconLine: 1 },
    ]
    expect(selectCorpusHits(risks, '乙乙，普通。啊呀')).toEqual([
      { ...risks[0], count: 2, firstContext: '乙乙，普通。啊呀' },
      { ...risks[1], count: 1, firstContext: '乙乙，普通。啊呀' },
    ])
  })

  it('filters a real book/corpus, verifies deterministic bytes and has explicit exit codes', async () => {
    await withTempDir(async (dir) => {
      const corpus = join(dir, 'book.txt')
      const out = join(dir, 'report.json')
      const summary = join(dir, 'report.md')
      await writeFile(corpus, '笹垣来了。啊，笹又出现了。\n', 'utf8')
      const args = [
        '--verify', `--book=${corpus}`, `--out=${out}`, `--summary=${summary}`,
      ]
      const first = run(args)
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0)
      expect(first.stdout).toContain('确定性验收通过')
      const bytes = await readFile(out, 'utf8')
      const report = JSON.parse(bytes)
      expect(report.rows.map((row: any) => row.char)).toEqual(['啊', '笹'])
      expect(report.rows.find((row: any) => row.char === '笹')).toMatchObject({
        phone: 'ti', count: 2,
      })
      expect(report.totals.baseRiskChars).toBeGreaterThan(80)
      expect(report.totals.listedChars).toBe(2)
      expect(report.totals.hits).toBe(3)
      expect(await readFile(summary, 'utf8')).toContain('仅列语料/书籍实际命中')

      const second = run(args)
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0)
      expect(await readFile(out, 'utf8')).toBe(bytes)

      const strict = run([...args, '--strict'])
      expect(strict.status).toBe(1)
      const missing = run([`--corpus=${join(dir, 'missing.epub')}`, `--out=${out}`])
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('ENOENT')
    })
  }, 60_000)

  it('without a corpus reports the full base dictionary rather than an empty hit list', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'all.json')
      const result = run([`--out=${out}`, `--summary=${join(dir, 'all.md')}`, '--top=1'])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8'))
      expect(report.corpus).toBeNull()
      expect(report.rows.length).toBe(report.totals.baseRiskChars)
      expect(report.rows.some((row: any) => row.char === '笹' && row.phone === 'ti')).toBe(true)
      expect(result.stdout).toContain('全量')
    })
  }, 30_000)
})
