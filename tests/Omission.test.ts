import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const USER_SENTENCE = '正因如此，一些会占便宜的有钱人长期地用盐不给钱。'
const TRUNCATED_TOKENS = [
  'zheng4', 'yin1', 'ru2', 'ci3', ',', 'yi4', 'xie1', 'hui4',
  'zhan4', 'pian2', 'yi2', 'de', 'you3', 'qian2', 'ren2', '.',
]

async function loadOmission(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/omission.mjs')
}

async function loadReading(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/reading.mjs')
}

describe('feedback sentence reconstruction', () => {
  it('rejects the truncated token stream that hid the 占便宜 regression', async () => {
    const { sentenceCoverage } = await loadOmission()
    const han = Array.from(USER_SENTENCE).filter((char) => /\p{Script=Han}/u.test(char)).length
    const truncated = sentenceCoverage({ tokens: TRUNCATED_TOKENS }, USER_SENTENCE)
    expect(truncated.ok).toBe(false)
    expect(truncated.han).toBe(han)
    expect(truncated.phones).toBeLessThan(han)
  })

  it('rebuilds every character of the full feedback sentence from the overlay', async () => {
    const { caseStream, sentenceCoverage } = await loadOmission()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const stream = caseStream(USER_SENTENCE, '占便宜', assets)
    expect(stream).not.toBeNull()
    expect(sentenceCoverage(stream, USER_SENTENCE).ok).toBe(true)
    expect(stream.tokens).toContain('"')
    expect(stream.phones).toEqual(['zhan4', 'pian2', 'yi'])
  }, 20_000)

  it('enumerates the word-initial slot as well as tail, mid and both ends', async () => {
    // The winning repair for 占便宜 is the LEADING boundary: it puts the
    // swallowed syllable back at the start of a phrase (便 221 → 337ms). The
    // old enumerator only produced tail/mid, so it could never find it.
    const { boundaryVariants, caseStream, repairReading } = await loadOmission()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const stream = caseStream(USER_SENTENCE, '占便宜', assets)
    const variants = boundaryVariants(stream)
    expect(variants.map((item: any) => `${item.kind}@${item.after}`))
      .toEqual(['none@0', 'lead@0', 'internal@1', 'internal@2', 'tail@3', 'both@0'])
    expect(repairReading(['zhan4', 'pian2', 'yi2'], 0)).toBe('" zhan4 pian2 yi2')
    expect(repairReading(['zhan4', 'pian2', 'yi2'], 2)).toBe('zhan4 pian2 " yi2')
    const lead = variants.find((item: any) => item.kind === 'lead')
    expect(lead.tokens[stream.range.start]).toBe('"')
    expect(lead.tokens.slice(stream.range.start + 1, stream.range.start + 4))
      .toEqual(['zhan4', 'pian2', 'yi'])
    const both = variants.find((item: any) => item.kind === 'both')
    expect(both.tokens[stream.range.start]).toBe('"')
    expect(both.tokens[stream.range.start + 4]).toBe('"')
  }, 20_000)
})

describe('silent boundary policy', () => {
  it('only allows word edges; an in-word boundary is an offender', async () => {
    const { inWordBoundaries, currentBoundary } = await loadOmission()
    expect(inWordBoundaries(new Map([
      ['占便宜', 'zhan4 pian2 " yi2'],
      ['地盘', '" di4 pan2 "'],
      ['之间', 'zhi1 jian1 "'],
    ])).map((item: any) => item.word)).toEqual(['占便宜'])
    expect(currentBoundary('zhan4 pian2 " yi2')).toEqual({ kind: 'internal', after: 2 })
    expect(currentBoundary('" zhan4 pian2 yi2')).toEqual({ kind: 'lead', after: 0 })
    expect(currentBoundary('" di4 pan2 "')).toEqual({ kind: 'both', after: 0 })
    expect(currentBoundary('zhi1 jian1 "')).toEqual({ kind: 'tail', after: 2 })
    expect(currentBoundary('di4 pan2')).toEqual({ kind: 'none', after: 0 })
  })
})

describe('omission case replay', () => {
  it('loads the case asset and replays the confirmed repair', async () => {
    const { parseOmissionCases, replayOmission, currentBoundary } = await loadOmission()
    const { loadMatchaAssets } = await loadReading()
    const text = readFileSync(join(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
    const cases = parseOmissionCases(text)
    expect(cases.length).toBeGreaterThan(0)
    const first = cases[0]
    expect(first.sentences.length).toBeGreaterThanOrEqual(2)
    expect(first.sentences[0]).toBe(USER_SENTENCE)
    const assets = await loadMatchaAssets()
    expect(currentBoundary(assets.overlay.entries.get(first.word)))
      .toEqual({ kind: 'lead', after: 0 })
    const result = replayOmission(first, assets)
    expect(result.ok, result.detail).toBe(true)
    expect(result.reproducible).toBe(true)
  }, 20_000)

  it('fails when the recorded repair has been reverted', async () => {
    const { parseOmissionCases, replayOmission } = await loadOmission()
    const { loadMatchaAssets } = await loadReading()
    const text = readFileSync(join(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
    const first = parseOmissionCases(text)[0]
    const assets = await loadMatchaAssets()
    const reverted = new Map(assets.overlay.entries)
    reverted.set(first.word, 'zhan4 pian2 yi2')
    const effectiveBefore = new Map(assets.effective)
    effectiveBefore.set(first.word, 'zhan4 pian2 yi2')
    const result = replayOmission(first, {
      ...assets,
      overlay: { ...assets.overlay, entries: reverted },
      effective: effectiveBefore,
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('修复已回退')
  }, 20_000)

  it('automatically folds a newly written case into the next replay baseline', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { loadHistory, FAMILIES } = await import('../scripts/lib/iterationFamilies.mjs') as any
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-omission-history-'))
    try {
      const assetDir = join(dir, 'src/core/tts')
      await mkdir(assetDir, { recursive: true })
      const original = readFileSync(join(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
      const next = JSON.stringify({
        id: 'om-next', source: 'self-iterate', status: 'confirmed',
        sentences: ['他只想捡便宜。', '不要总想着捡便宜。'],
        word: '捡便宜', char: '便', offset: 1, phone: 'pian2',
        repair: { kind: 'internal', after: 2, reading: 'jian3 pian2 " yi2' },
      })
      const assetPath = join(assetDir, 'omissionCases.v1.jsonl')
      const count = async () => (await loadHistory(dir))
        .filter((item: any) => item.family === 'omission').length
      await writeFile(assetPath, `${original.trimEnd()}\n`)
      const baseline = await count()
      expect(baseline).toBeGreaterThanOrEqual(1)
      await writeFile(assetPath, `${original.trimEnd()}\n${next}\n`)
      const history = await loadHistory(dir)
      expect(await count()).toBe(baseline + 1)
      expect(history.some((item: any) => item.id === 'omission:om-next')).toBe(true)
      expect(FAMILIES).toContain('omission')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('generalises the confirmed omission to whole-book candidates', async () => {
    const { parseOmissionCases, discoverOmissionLeads } = await loadOmission()
    const { loadMatchaAssets } = await loadReading()
    const text = readFileSync(join(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8')
    const cases = parseOmissionCases(text)
    const assets = await loadMatchaAssets()
    // 2026-11-11 sixth round pinned the 便宜 family in the curated overlay, so
    // discovery has nothing left to propose on the current lexicon. Replay the
    // PRE-FIX lexicon instead (same technique as self-iterate --verify) to prove
    // the scanner would still rediscover these words if the fix ever regressed.
    const beforeEffective = new Map(assets.effective)
    const beforeOverlay = new Map(assets.overlay.entries)
    for (const word of ['小便宜', '捡便宜', '讨便宜', '贪便宜', '便宜货']) {
      beforeOverlay.delete(word)
      const base = assets.lexicon.get(word)
      if (base) beforeEffective.set(word, base)
      else beforeEffective.delete(word)
    }
    const preFix = {
      ...assets,
      effective: beforeEffective,
      overlay: { ...assets.overlay, entries: beforeOverlay },
    }
    const leads = discoverOmissionLeads(
      '他不肯吃亏，只想贪便宜，讨便宜也没讨着，捡便宜倒是很在行。',
      preFix, cases,
    )
    expect(leads.some((lead: any) => lead.family === 'omission')).toBe(true)
    expect(leads.some((lead: any) => lead.word !== '占便宜')).toBe(true)
    expect(leads.some((lead: any) => ['贪便宜', '讨便宜', '捡便宜'].includes(lead.word))).toBe(true)
    for (const lead of leads) {
      expect(Array.from(lead.word).length).toBeGreaterThanOrEqual(2)
      expect(lead.sentences.every((sentence: string) => !sentence.startsWith('…'))).toBe(true)
    }
  }, 20_000)
})

describe('omission CI gate', () => {
  it('passes --verify with real WASM on both full feedback sentences', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/audit-omission.mjs', '--verify'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('原句未截断')
    expect(result.stdout).toContain('每个音节都可听')
    // The long book block whose three syllables all exceed 350ms after
    // 宜→轻声 must stay visible every run, but must not be hidden by being
    // silently dropped from the case asset.
    expect(result.stdout).toContain('待复听  om-0001')
  }, 120_000)

  it('is wired into audit:all as a required gate', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-omission-'))
    try {
      const out = join(dir, 'gates.json')
      const result = spawnSync(
        process.execPath,
        ['scripts/audit-all.mjs', '--only=反馈原句可听性', `--out=${out}`],
        { cwd: root, encoding: 'utf8' },
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8')) as {
        gates: Array<{ name: string; status: number; required: boolean }>
      }
      expect(report.gates).toHaveLength(1)
      expect(report.gates[0].required).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
