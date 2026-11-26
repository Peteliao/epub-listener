import { describe, expect, it } from 'vitest'
// @ts-ignore -- dev-only ESM helper has no type declarations
import { loadMatchaAssets } from '../scripts/lib/reading.mjs'
// @ts-ignore -- dev-only ESM helper has no type declarations
import { loadFrontendSpeech } from '../scripts/lib/frontendSpeech.mjs'
// @ts-ignore -- dev-only ESM helper has no type declarations
import { MATCHA_FRONTEND_CASES, MATCHA_FRONTEND_PROTOCOL, planMatchaFrontendCase, validateMatchaFrontendReport } from '../scripts/lib/matchaFrontendParity.mjs'

interface MatchaFrontendInput {
  id: string
  nativeTokens: string[]
}

interface MatchaFrontendCase {
  id: string
  decision: 'g2p' | 'native-fallback' | 'reject'
  normalizedText: string | null
  tokens: string[] | null
  nativeManaged: Array<{ text: string }>
  omissions: Array<{ reason: string }>
  error?: string
  nativeComparison?: { captured: boolean; tokens: string[] }
}

interface MatchaFrontendReport {
  protocol: string
  mode: 'frozen-snapshot' | 'native-probe'
  cases: MatchaFrontendCase[]
  listeningAccuracy: null
}

async function fixture(): Promise<{
  assets: { overlayText: string }
  cases: MatchaFrontendCase[]
  report: MatchaFrontendReport
}> {
  const [assets, frontend] = await Promise.all([loadMatchaAssets(), loadFrontendSpeech()])
  const cases: MatchaFrontendCase[] = MATCHA_FRONTEND_CASES.map((item: MatchaFrontendInput) =>
    planMatchaFrontendCase(item, {
      assets,
      frontend,
      overlayText: assets.overlayText,
    }))
  return {
    assets,
    cases,
    report: {
      protocol: MATCHA_FRONTEND_PROTOCOL,
      mode: 'frozen-snapshot',
      cases,
      listeningAccuracy: null,
    },
  }
}

describe('Matcha default frontend parity', () => {
  it('matches frozen native tokens for supported production text', async () => {
    const { report } = await fixture()
    expect(validateMatchaFrontendReport(report)).toEqual([])
    expect(report.cases.filter((row) => row.decision === 'g2p')).toHaveLength(8)
    expect(report.cases.filter((row) => row.decision === 'native-fallback')).toHaveLength(3)
    expect(report.cases.filter((row) => row.decision === 'reject')).toHaveLength(1)
  })

  it('normalizes dates but keeps Arabic-managed spans explicit instead of inventing tokens', async () => {
    const { cases } = await fixture()
    const date = cases.find((row) => row.id === 'arabic-date')!
    expect(date.normalizedText).toContain('二零二六年十一月二十六日')
    expect(date.decision).toBe('native-fallback')
    expect(date.tokens).toBeNull()
    expect(date.nativeManaged.map((entry) => entry.text).join('')).toBe('123')
    const decimal = cases.find((row) => row.id === 'decimal-number')!
    expect(decimal.nativeManaged.map((entry) => entry.text).join('')).toBe('12345')
  })

  it('preserves native tone sandhi, punctuation and quote behavior', async () => {
    const { cases } = await fixture()
    expect(cases.find((row) => row.id === 'tone-sandhi-yi')?.tokens).toEqual(['yi2', 'ge4', 'ren2', '.'])
    expect(cases.find((row) => row.id === 'tone-sandhi-bu')?.tokens).toEqual([
      'bu4', 'qu4', 'chong2', 'qing4', '.',
    ])
    expect(cases.find((row) => row.id === 'punctuation')?.tokens).toEqual([
      'ni2', 'hao3', ',', 'shi4', 'jie4', '!', 'zai4', 'jian4',
      'ran2', 'hou4', '.', '.', '.', '.', '.', '.',
    ])
    expect(cases.find((row) => row.id === 'quotes')?.tokens).toEqual([
      'ni2', 'hao3', ',', 'ta1', 'shuo1', '.',
    ])
  })

  it('classifies zero-width boundaries and keeps punctuation-only reset coverage explicit', async () => {
    const { cases } = await fixture()
    const reset = cases.find((row) => row.id === 'utterance-reset')!
    expect(reset.omissions.map((entry) => entry.reason)).toEqual(expect.arrayContaining([
      'word-boundary-no-token',
      'sentence-boundary-no-token',
    ]))
    expect(reset.tokens!.at(-1)).toBe('"')
    const punctuationReset = cases.find((row) => row.id === 'punctuation-reset')!
    expect(punctuationReset.tokens).toEqual(['ni2', 'hao3'])
    expect(punctuationReset.omissions.map((entry) => entry.reason)).toEqual(expect.arrayContaining([
      'word-boundary-no-token',
      'runtime-oov-skipped',
    ]))
  })

  it('hard-fails uncovered Han rather than routing it through native silent loss', async () => {
    const { cases } = await fixture()
    const rejected = cases.find((row) => row.id === 'uncovered-han')!
    expect(rejected.decision).toBe('reject')
    expect(rejected.tokens).toBeNull()
    expect(rejected.error).toContain('拒绝静默丢弃')
    expect(rejected.error).toContain('𠀀')
  })

  it('rejects forged G2P completeness and requires live native probes in native mode', async () => {
    const { report } = await fixture()
    const forged = structuredClone(report)
    const fallback = forged.cases.find((row) => row.id === 'raw-number-latin')!
    fallback.tokens = ['ni2', 'hao3']
    expect(validateMatchaFrontendReport(forged).join(' ')).toContain('不得把原生托管文本冒充完整 token')

    const live = structuredClone(report)
    live.mode = 'native-probe'
    for (const row of live.cases) {
      if (row.decision !== 'reject') {
        row.nativeComparison = {
          captured: true,
          tokens: MATCHA_FRONTEND_CASES.find((item: MatchaFrontendInput) => item.id === row.id)!.nativeTokens,
        }
      }
    }
    expect(validateMatchaFrontendReport(live, { requireNative: true })).toEqual([])
    live.cases[0].nativeComparison!.captured = false
    expect(validateMatchaFrontendReport(live, { requireNative: true }).join(' '))
      .toContain('实时原生 token 与冻结快照不一致')
  })
})
