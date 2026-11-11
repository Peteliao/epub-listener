import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const fixture = (name: string) => resolve(root, 'tests/fixtures', name)

function readRecords(name: string): Array<{
  id: string
  text: string
  family?: string
  readings: Array<[string, number, string]>
}> {
  return readFileSync(fixture(name), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as {
      id: string
      text: string
      family?: string
      readings: Array<[string, number, string]>
    })
}

describe('pronunciation regression gate', () => {
  it('matches the bundled 山岚 lexicon and overlay', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/audit-golden.mjs', '--all'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('不一致：0 处')
    expect(result.stdout).toContain('格式问题：0 处')
    // The snapshot grows with the curated overlay; the lower bound is checked
    // explicitly below, so only require a sane 3–4 digit case count here.
    expect(result.stdout).toMatch(/用例：[1-9]\d{2,3} 条/)
    expect(result.stdout).toMatch(/字族 (?:[3-9]\d|\d{3}) 个/)
  })

  it('keeps every case well formed and unique', () => {
    const records = [
      ...readRecords('pronunciation-golden.jsonl'),
      ...readRecords('pronunciation-regression.jsonl'),
    ]
    expect(records.length).toBeGreaterThanOrEqual(800)
    const ids = new Set<string>()
    for (const record of records) {
      // Feedback-generated ids carry the Chinese word (feedback-槐树).
      expect(record.id).toMatch(/^[\p{Script=Han}a-z0-9-]+$/u)
      expect(ids.has(record.id), `duplicate id ${record.id}`).toBe(false)
      ids.add(record.id)
      expect(record.text.trim().length).toBeGreaterThan(0)
      expect(record.readings.length).toBeGreaterThan(0)
      for (const [char, occurrence, phone] of record.readings) {
        expect(Array.from(char)).toHaveLength(1)
        expect(Number.isInteger(occurrence)).toBe(true)
        expect(occurrence).toBeGreaterThan(0)
        expect(phone).toMatch(/^[a-z]+[1-4]?$/)
        expect(
          Array.from(record.text).filter((item) => item === char).length,
          `${record.id}: 「${char}」in ${record.text}`,
        ).toBeGreaterThanOrEqual(occurrence)
      }
    }
  })

  it('layers the snapshot across at least 30 polyphone families', () => {
    const families = new Set(
      readRecords('pronunciation-regression.jsonl')
        .map((record) => record.family)
        .filter((family): family is string => Boolean(family && family !== 'other')),
    )
    expect(families.size).toBeGreaterThanOrEqual(30)
  })
})
