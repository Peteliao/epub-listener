import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const ITERATE = 'scripts/self-iterate.mjs'

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

async function loadLib(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/iterationFamilies.mjs')
}

async function loadReading(): Promise<any> {
  // @ts-ignore
  return import('../scripts/lib/reading.mjs')
}

describe('history replay baseline', () => {
  it('extracts every historical fix from the assets and covers all six families', async () => {
    const { loadHistory, pinCases, FAMILIES } = await loadLib()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const cases = [...(await loadHistory(root)), ...pinCases(assets)]
    expect(cases.length).toBeGreaterThan(1000)
    for (const family of FAMILIES) {
      expect(cases.some((item: any) => item.family === family), `missing ${family}`).toBe(true)
    }
  }, 20_000)

  it('replays every case against its pre-fix lexicon with zero regressions', async () => {
    const { loadHistory, pinCases, replayAll } = await loadLib()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const replays = replayAll([...(await loadHistory(root)), ...pinCases(assets)], assets)
    expect(replays.filter((item: any) => !item.result.ok)).toEqual([])
    expect(replays.filter((item: any) => item.result.reproducible).length).toBeGreaterThan(20)
  }, 30_000)

  it('reproduces 千军易得 de -> de2 before the fix', async () => {
    const { loadHistory, replayAll } = await loadLib()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const history = await loadHistory(root)
    const target = history.find((item: any) => item.id === 'rule:rr-0001')
    const result = replayAll([target], assets)[0].result
    expect(result.beforePhone).toBe('de')
    expect(result.afterPhone).toBe('de2')
    expect(result.reproducible).toBe(true)
  }, 20_000)
})

describe('family-wise discovery', () => {
  it('generalises phone rules by word shape and never proposes single-character rows', async () => {
    const { loadHistory, replayAll, phoneFamilies, discoverPhoneLeads } = await loadLib()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const replays = replayAll(await loadHistory(root), assets)
    const families = phoneFamilies(replays)
    expect(families.get('得')?.some((item: any) => item.expected === 'de2')).toBe(true)
    // 应天 is a proper noun: generalize=false must keep it out of the pool.
    expect(families.has('应')).toBe(false)
    const text = '千军易得，一将难求。他觉得这件事难得，却能率意而为。'
    const leads = discoverPhoneLeads(text, assets, replays)
    expect(leads.length).toBeGreaterThan(0)
    for (const lead of leads) {
      expect(Array.from(lead.word).length).toBeGreaterThanOrEqual(2)
      expect(lead.suggestion.startsWith(`${lead.word} `)).toBe(true)
    }
  }, 20_000)

  it('only proposes dictionary two-character words for boundary measurement', async () => {
    const { discoverBoundaryLeads } = await loadLib()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const text = '对这支武装发动了夜袭，深入古人的情境；双方纷纷议论，弹劾道同。'
    const leads = discoverBoundaryLeads(text, assets, { limit: 20 })
    for (const lead of leads) {
      expect(assets.effective.has(lead.word)).toBe(true)
      expect(Array.from(lead.word)).toHaveLength(2)
      expect(lead.phones).toHaveLength(2)
    }
    expect(leads.some((lead: any) => lead.word === '对这' || lead.word === '的情')).toBe(false)
  }, 20_000)

  it('does not report a cross-word substring as a longest-match loss', async () => {
    const { discoverSegmentationLeads } = await loadLib()
    const { loadMatchaAssets } = await loadReading()
    const assets = await loadMatchaAssets()
    const leads = discoverSegmentationLeads('有点类似倒时差。', assets)
    expect(leads.some((lead: any) => lead.word === '时差' && lead.actual === '倒时差')).toBe(false)
  }, 20_000)

  it('keeps the global frontend fix present', async () => {
    const { frontendConfigCheck, PATHS } = await loadLib()
    const [worker, aiModel] = await Promise.all([
      readFile(join(root, PATHS.worker), 'utf8'),
      readFile(join(root, PATHS.aiModel), 'utf8'),
    ])
    expect(frontendConfigCheck(worker, aiModel).every((check: any) => check.ok)).toBe(true)
  })
})

describe('self-iteration CI gate', () => {
  it('passes --verify with all historical cases still replayable', async () => {
    const result = run(ITERATE, ['--verify'])
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('通过')
    const report = JSON.parse(
      await readFile(join(root, 'scripts/out/self-iteration-verify.json'), 'utf8'),
    ) as {
      cases: number
      byFamily: Record<string, number>
      failures: unknown[]
      passed: number
      total: number
    }
    expect(report.cases).toBeGreaterThan(1000)
    expect(report.failures).toEqual([])
    expect(report.passed).toBe(report.total)
    expect(Object.keys(report.byFamily)).toHaveLength(6)
  }, 60_000)

  it('is wired into audit:all as a required gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-iterate-'))
    try {
      const out = join(dir, 'gates.json')
      const result = run('scripts/audit-all.mjs', ['--only=历史基线', `--out=${out}`])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8')) as {
        gates: Array<{ name: string; status: number; required: boolean }>
      }
      expect(report.gates).toHaveLength(1)
      expect(report.gates[0].required).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
