/**
 * Unified quality status for the TTS 2.0 evaluation loop.
 *
 * Determine what is objectively proven, what is only a risk signal and what
 * still requires a human listener. This module is pure; scripts/quality-report
 * only gathers the files written by the other dev scripts.
 */
export const QUALITY_STATUSES = Object.freeze([
  'PASS', 'WARNING', 'NEEDS_LISTENING', 'FAIL',
])

export function classifyGate(gate) {
  if (gate?.skipped) return 'SKIP'
  if (gate?.status === 0) return 'PASS'
  return gate?.required ? 'FAIL' : 'WARNING'
}

export function buildQualityReport(inputs = {}) {
  const gates = inputs.gates ?? []
  const envelope = inputs.envelope ?? []
  const blindReveals = inputs.blindReveals ?? []
  const oovRecall = inputs.oovRecall
  const selfIteration = inputs.selfIteration

  const required = gates.filter((gate) => gate?.required && !gate.skipped)
  const deterministicErrors = required
    .filter((gate) => gate.status !== 0)
    .map((gate) => gate.name)
  const advisoryWarnings = gates
    .filter((gate) => !gate.required && !gate.skipped && gate.status !== 0)
    .map((gate) => gate.name)

  const needsListening = envelope.filter((item) => item.decision === 'NEEDS_LISTENING')
  const highRiskEnvelope = envelope.filter((item) =>
    item.severity === 'S' && item.decision !== 'NEEDS_LISTENING')
  const oovSample = oovRecall?.sample?.length ?? 0
  const blindDeltas = blindReveals.flatMap((reveal) =>
    (reveal.overall ?? []).map((item) => item.delta).filter((value) => Number.isFinite(value)))
  const blindAverage = blindDeltas.length
    ? blindDeltas.reduce((sum, value) => sum + value, 0) / blindDeltas.length
    : null

  const regressionStatus = selfIteration
    ? ((selfIteration.failures?.length ?? 0) ? 'FAIL' : 'PASS')
    : 'NEEDS_LISTENING'
  const acousticGate = gates.find((gate) => gate?.name?.includes('声学'))
  const performance = acousticGate
    ? { status: classifyGate(acousticGate), synthSmokeMs: acousticGate.durationMs ?? null }
    : { status: 'NEEDS_LISTENING', synthSmokeMs: null }

  let status = 'PASS'
  if (deterministicErrors.length || regressionStatus === 'FAIL') status = 'FAIL'
  else if (needsListening.length || !blindReveals.length || performance.status === 'NEEDS_LISTENING') {
    status = 'NEEDS_LISTENING'
  } else if (advisoryWarnings.length) status = 'WARNING'

  return {
    status,
    deterministicErrors,
    advisoryWarnings,
    highRiskListening: needsListening.length + highRiskEnvelope.length + oovSample,
    needsListening: needsListening.length,
    oovSample,
    blind: {
      raters: blindReveals.length,
      averageDelta: blindAverage == null ? null : Math.round(blindAverage * 100) / 100,
    },
    envelope: {
      pass: envelope.filter((item) => item.decision === 'PASS').length,
      needsListening: needsListening.length,
      fail: envelope.filter((item) => item.decision === 'FAIL').length,
    },
    regression: { status: regressionStatus, failures: selfIteration?.failures?.length ?? null },
    performance,
    statuses: QUALITY_STATUSES,
  }
}

export function formatQualityReport(report) {
  return [
    `# 山岚 TTS 质量报告：${report.status}`,
    '',
    '- PASS：硬性测试通过；WARNING：有风险但证据不足；NEEDS_LISTENING：必须人工复听；FAIL：确定性失败。',
    '- 自动指标只负责发现问题和守住回归；最终音质以盲听为准。',
    '',
    `| 指标 | 结果 |`,
    `| --- | --- |`,
    `| 确定性失败 | ${report.deterministicErrors.join('、') || '0'} |`,
    `| advisory 警告 | ${report.advisoryWarnings.join('、') || '0'} |`,
    `| 高风险待复听 | ${report.highRiskListening}（包络 ${report.needsListening} + OOV 抽样 ${report.oovSample}） |`,
    `| 盲听评分变化 | ${report.blind.averageDelta == null ? '未提供解盲结果' : report.blind.averageDelta} |`,
    `| 历史回归 | ${report.regression.status}（失败 ${report.regression.failures ?? '—'}） |`,
    `| 声学冒烟 | ${report.performance.status} · ${report.performance.synthSmokeMs ?? '—'}ms |`,
  ].join('\n')
}
