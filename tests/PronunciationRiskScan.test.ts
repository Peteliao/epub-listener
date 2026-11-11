import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const SCANNER = 'scripts/scan-pronunciation-risks.mjs'
const TRIAGE = 'scripts/reports-to-overlay.mjs'

interface RiskRecord {
  family: string
  pattern: string
  current: string
  expected: string
  kind: string
  status: string
  count: number
  sources: string[]
  suggestion?: { type: string; text: string }
}

function run(script: string, args: string[]): string {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`${script} 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function records(text: string): RiskRecord[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as RiskRecord)
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shusheng-risks-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('pronunciation risk scanner', () => {
  it('recalls the phone-level errors from the 2026-11-09 report', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'risks.jsonl')
      const summary = join(dir, 'risks.md')
      const stdout = run(SCANNER, [
        '--verify',
        `--out=${out}`,
        `--summary=${summary}`,
      ])
      expect(stdout).toContain('召回 3/3')

      const all = records(await readFile(out, 'utf8'))
      const confirmed = all.filter(
        (item) => item.status === 'candidate' && item.sources.includes('verify'),
      )
      expect(confirmed).toHaveLength(3)
      expect(confirmed.map((item) => item.suggestion?.text).sort()).toEqual(
        ['而为 er2 wei2', '易得 yi4 de2', '率意 shuai4 yi4'].sort(),
      )

      // pinyin-pro reads 长期地 as di4 and 应立即 as ying4. Both must stay
      // out of the candidate list.
      const particle = all.find(
        (item) => item.family === '地' && item.current === 'de' && item.expected === 'di4',
      )
      expect(particle?.status).toBe('review')
      const ying = all.find(
        (item) => item.family === '应' && item.current === 'ying1' && item.expected === 'ying4',
      )
      expect(ying?.status).toBe('review')
    })
  })

  it('does not flag readings already confirmed by the curated table or golden set', async () => {
    await withTempDir(async (dir) => {
      const corpus = join(dir, 'corpus.txt')
      await writeFile(corpus, '朝鲜与解缙。大都和率军。\n', 'utf8')
      const out = join(dir, 'risks.jsonl')
      const summary = join(dir, 'risks.md')
      run(SCANNER, [corpus, `--out=${out}`, `--summary=${summary}`])

      const candidates = records(await readFile(out, 'utf8')).filter(
        (item) => item.status === 'candidate',
      )
      const protectedWords = ['朝鲜', '解缙', '大都', '率军']
      expect(
        candidates.filter((item) =>
          protectedWords.some((word) => item.pattern.includes(word)),
        ),
      ).toEqual([])
    })
  })

  it('spreads one confirmed expectation to every matching position', async () => {
    await withTempDir(async (dir) => {
      const corpus = join(dir, 'corpus.txt')
      await writeFile(corpus, '而是率意而为，打到哪儿算哪儿。后来又率意而为。\n', 'utf8')
      const out = join(dir, 'risks.jsonl')
      const summary = join(dir, 'risks.md')
      run(SCANNER, [
        corpus,
        '--baseline',
        '--expect=率:shuai4@率意',
        `--out=${out}`,
        `--summary=${summary}`,
      ])

      const all = records(await readFile(out, 'utf8'))
      const hit = all.find(
        (item) => item.kind === 'expected' && item.family === '率' && item.expected === 'shuai4',
      )
      expect(hit?.count).toBe(2)
      expect(hit?.suggestion?.text).toBe('率意 shuai4 yi4')
      expect(await readFile(summary, 'utf8')).toContain('| 率 | shuai4 | 率意 | cli | 2 |')
    })
  })
})

describe('feedback triage', () => {
  it('separates acoustic problems from real dictionary overrides', async () => {
    await withTempDir(async (dir) => {
      const reports = join(dir, 'reports.jsonl')
      await writeFile(
        reports,
        [
          JSON.stringify({
            id: 'override',
            paragraph: { text: '元大都是一座城。' },
            marks: [{
              char: '都', charIndex: 2, word: '大都',
              wordStart: 1, wordEnd: 3, expectedPinyin: 'dou1',
            }],
          }),
          JSON.stringify({
            id: 'acoustic',
            paragraph: { text: '正因如此，一些会占便宜的有钱人长期地用盐不给钱。' },
            marks: [{
              char: '便', charIndex: 9, word: '占便宜',
              wordStart: 8, wordEnd: 11, expectedPinyin: 'pian2',
            }],
          }),
        ].join('\n') + '\n',
        'utf8',
      )
      const triage = join(dir, 'triage.jsonl')
      const stdout = run(TRIAGE, [reports, `--triage=${triage}`])
      expect(stdout).toContain('override-lexicon 1')
      expect(stdout).toContain('acoustic 1')

      const rows = records(await readFile(triage, 'utf8')) as unknown as Array<{
        word: string
        class: string
      }>
      expect(rows.find((row) => row.word === '大都')?.class).toBe('override-lexicon')
      expect(rows.find((row) => row.word === '占便宜')?.class).toBe('acoustic')
    })
  })
})
