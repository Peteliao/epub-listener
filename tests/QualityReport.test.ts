import { describe, expect, it } from 'vitest'

async function loadReport(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/qualityReport.mjs')
}

describe('2026-11-23 第十七轮：统一质量状态', () => {
  it('硬性门禁失败时输出 FAIL，不会被 advisory 掩盖', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport({
      gates: [{ name: '黄金集', required: true, status: 1 }],
      selfIteration: { failures: [] },
    })
    expect(report.status).toBe('FAIL')
    expect(report.deterministicErrors).toContain('黄金集')
  })

  it('待复听时输出 NEEDS_LISTENING，并统计高风险数量', async () => {
    const { buildQualityReport } = await loadReport()
    const report = buildQualityReport({
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
      selfIteration: { failures: [] },
    })
    expect(report.status).toBe('NEEDS_LISTENING')
    expect(report.highRiskListening).toBe(3)
    expect(report.performance.status).toBe('PASS')
  })

  it('全部硬性通过且有解盲结果时为 PASS', async () => {
    const { buildQualityReport, formatQualityReport } = await loadReport()
    const report = buildQualityReport({
      gates: [
        { name: '黄金集', required: true, status: 0 },
        { name: '声学冒烟', required: false, status: 0, durationMs: 900 },
      ],
      blindReveals: [{ overall: [{ id: 'a', delta: 0.3 }] }],
      selfIteration: { failures: [] },
    })
    expect(report.status).toBe('PASS')
    expect(report.blind.averageDelta).toBe(0.3)
    expect(formatQualityReport(report)).toContain('PASS')
  })
})
