import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

const REPORT = {
  id: 'r-1',
  paragraph: { text: '门前有一棵老槐树。' },
  marks: [
    {
      char: '槐',
      charIndex: 6,
      word: '槐树',
      wordStart: 6,
      wordEnd: 8,
      expectedPinyin: 'huai2',
    },
  ],
  voice: { voiceLabel: '山岚', packVersion: '2026.10.26' },
}

describe('reports-to-overlay', () => {
  it('emits an overlay line and a golden regression case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-overlay-'))
    try {
      const reportPath = join(dir, 'reports.jsonl')
      const overlayPath = join(dir, 'overlay.txt')
      const goldenPath = join(dir, 'golden.jsonl')
      await writeFile(reportPath, `${JSON.stringify(REPORT)}\n`, 'utf8')

      const result = spawnSync(
        process.execPath,
        [
          'scripts/reports-to-overlay.mjs',
          reportPath,
          `--out=${overlayPath}`,
          `--golden=${goldenPath}`,
        ],
        { cwd: root, encoding: 'utf8' },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)

      const overlay = await readFile(overlayPath, 'utf8')
      expect(overlay).toContain('槐树 huai2 shu4')

      const golden = await readFile(goldenPath, 'utf8')
      const lines = golden
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
      const record = JSON.parse(lines[0]!) as {
        id: string
        text: string
        readings: Array<[string, number, string]>
      }
      expect(record.id).toBe('feedback-槐树')
      expect(record.text).toBe(REPORT.paragraph.text)
      expect(record.readings).toEqual([['槐', 1, 'huai2']])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
