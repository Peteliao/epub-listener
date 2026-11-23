import { describe, expect, it } from 'vitest'

async function loadReport(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/qualityReport.mjs')
}

const PROVENANCE = {
  commit: 'abc123',
  packageVersion: '0.4.1',
  suiteVersion: 'qe-18',
  voicePack: 'voice-1',
  lexicon: 'lex-1',
  corpus: 'corpus-1',
  experimentId: 'qe-exp-1',
}

function validProvenance(overrides: any = {}) {
  const expected = { ...PROVENANCE, ...overrides }
  return {
    expected,
    sources: [
      { name: 'gate-results', provenance: expected },
      { name: 'envelope-report', provenance: expected },
    ],
  }
}

function twoRaters(overall = [{ id: 'a', delta: 0.3 }]) {
  return [{
    experimentId: 'exp-1',
    raters: [{ rater: 'r1', items: [] }, { rater: 'r2', items: [] }],
    overall,
    agreement: 0.5,
  }]
}

function passInputs(overrides: any = {}) {
  return {
    gates: [
      { name: '黄金集', required: true, status: 0 },
      { name: '声学冒烟', required: false, status: 0, durationMs: 900 },
    ],
    envelope: [{ decision: 'PASS', severity: 'B' }],
    blindReveals: twoRaters(),
    selfIteration: { failures: [], checks: [{ ok: true }], passed: 1, total: 1 },
    provenance: validProvenance(),
    ...overrides,
  }
}

describe('2026-11-23 第十八轮：统一质量状态', () => {
  it('硬性门禁失败时输出 FAIL，不会被 advisory 掩盖', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport({
      gates: [{ name: '黄金集', required: true, status: 1 }],
      selfIteration: { failures: [] },
    })
    expect(report.status).toBe('FAIL')
    expect(report.deterministicErrors).toContain('黄金集')
  })

  it('高置信度包络 FAIL 进入最终 FAIL', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      envelope: [{
        decision: 'FAIL',
        severity: 'S',
        alignment: { confidence: 'high' },
      }],
    }))
    expect(report.status).toBe('FAIL')
    expect(report.envelopeFailures).toBe(1)
    expect(report.reasons.join('\n')).toContain('高置信度包络异常')
  })

  it('低置信度包络 FAIL 只进入 NEEDS_LISTENING', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      envelope: [{
        decision: 'FAIL',
        severity: 'S',
        alignment: { confidence: 'medium' },
      }],
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.envelopeFailures).toBe(0)
  })

  it('S 级但定位不确定时输出 NEEDS_LISTENING', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      envelope: [{ decision: 'PASS', severity: 'S' }],
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.sUncertain).toBe(1)
  })

  it('有待复听 OOV 时不能 PASS', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      oovRecall: { sample: [{ word: '白果' }, { word: '一张' }] },
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.oovSample).toBe(2)
  })

  it('待复听时统计高风险数量：包络 + OOV 不重复计数', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      gates: [
        { name: '黄金集', required: true, status: 0 },
        { name: '包络', required: false, status: 0 },
        { name: '声学冒烟', required: false, status: 0, durationMs: 1200 },
      ],
      envelope: [
        { decision: 'PASS', severity: 'B' },
        { decision: 'NEEDS_LISTENING', severity: 'S' },
      ],
      oovRecall: { sample: [{ word: '白果' }, { word: '一张' }] },
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.highRiskListening).toBe(3)
    expect(report.performance.status).toBe('PASS')
  })

  it('只有一名评分者时标记评测样本不足', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      blindReveals: [{
        experimentId: 'exp-1',
        raters: [{ rater: 'r1', items: [] }],
        overall: [{ id: 'a', delta: 0.3 }],
      }],
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.blind.insufficient).toBe(true)
    expect(report.reasons.join('\n')).toContain('独立评分者不足')
  })

  it('两次各一名评分者的实验不能替代一次双人实验', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      blindReveals: [
        {
          experimentId: 'exp-1',
          raters: [{ rater: 'r1', items: [] }],
          overall: [{ id: 'a', delta: 0.3 }],
        },
        {
          experimentId: 'exp-2',
          raters: [{ rater: 'r2', items: [] }],
          overall: [{ id: 'a', delta: 0.2 }],
        },
      ],
    }))
    expect(report.blind.raters).toBe(2)
    expect(report.blind.completeExperiments).toBe(0)
    expect(report.status).toBe('NEEDS_LISTENING')
  })

  it('数据版本不一致时不能 PASS', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      provenance: {
        expected: PROVENANCE,
        sources: [
          { name: 'gate-results', provenance: { ...PROVENANCE, commit: 'old-commit' } },
        ],
      },
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.provenance.status).toBe('MISMATCH')
    expect(report.reasons.join('\n')).toContain('数据版本未通过校验')
  })

  it('来自不同实验的数据不能 PASS', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      provenance: {
        expected: PROVENANCE,
        sources: [
          { name: 'gate-results', provenance: PROVENANCE },
          {
            name: 'envelope-report',
            provenance: { ...PROVENANCE, experimentId: 'qe-exp-2' },
          },
        ],
      },
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.provenance.status).toBe('MISMATCH')
    expect(report.provenance.mismatches.join('\n')).toContain('experimentId')
  })

  it('来源缺少实验 ID 时标记 UNVERIFIED', async () => {
    const { buildQualityReport } = await loadReport()
    const withoutId = { ...PROVENANCE, experimentId: undefined }
    const report = buildQualityReport(passInputs({
      provenance: {
        expected: PROVENANCE,
        sources: [{ name: 'gate-results', provenance: withoutId }],
      },
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.provenance.status).toBe('UNVERIFIED')
    expect(report.provenance.unverified.join('\n')).toContain('experimentId')
  })

  it('缺少版本信息的旧报告不能 PASS', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      provenance: {
        expected: PROVENANCE,
        sources: [{ name: 'gate-results', provenance: null }],
      },
    }))
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.provenance.status).toBe('UNVERIFIED')
  })

  it('全部条件满足时为 PASS 并报告一致性与版本状态', async () => {
    const { buildQualityReport, formatQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs())
    expect(report.status).toBe('PASS')
    expect(report.blind.averageDelta).toBe(0.3)
    expect(report.blind.raters).toBe(2)
    expect(report.blind.agreement).toBe(0.5)
    expect(report.provenance.status).toBe('OK')
    const text = formatQualityReport(report)
    expect(text).toContain('PASS')
    expect(text).toContain('数据版本')
  })

  it('历史回归的 checks 失败也视为 FAIL', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport(passInputs({
      selfIteration: {
        failures: [],
        checks: [{ ok: true }, { ok: false }],
        passed: 1,
        total: 2,
      },
    }))
    expect(report.status).toBe('FAIL')
  })
})