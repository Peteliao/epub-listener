/**
 * Unified quality status for the TTS 2.0 evaluation loop.
 *
 * Determine what is objectively proven, what is only a risk signal and what
 * still requires a human listener. This module is pure; scripts/quality-report
 * only gathers the files written by the other dev scripts.
 *
 * A PASS is deliberately hard to get: every measurement must carry the same
 * code / voice pack / lexicon / corpus provenance, and a blind result needs at
 * least two independent raters. Anything unproven stays NEEDS_LISTENING.
 */
import { checkProvenance } from './provenance.mjs'

export const QUALITY_STATUSES = Object.freeze([
  'PASS', 'WARNING', 'NEEDS_LISTENING', 'FAIL',
])

export function classifyGate(gate) {
  if (gate?.skipped) return 'SKIP'
  if (gate?.status === 0) return 'PASS'
  return gate?.required ? 'FAIL' : 'WARNING'
}

function highConfidence(item) {
  return item?.alignment?.confidence === 'high'
}

function regressionOf(selfIteration) {
  if (!selfIteration) return 'NEEDS_LISTENING'
  const failures = selfIteration.failures?.length ?? 0
  const checks = Array.isArray(selfIteration.checks)
    ? selfIteration.checks.filter((check) => check && !check.ok).length
    : 0
  const short = Number.isFinite(selfIteration.passed)
    && Number.isFinite(selfIteration.total)
    && selfIteration.passed < selfIteration.total
  return failures || checks || short ? 'FAIL' : 'PASS'
}

function summarizeBlind(blindReveals) {
  const raterNames = new Set()
  for (const reveal of blindReveals) {
    for (const rater of reveal.raters ?? []) {
      if (rater?.rater) raterNames.add(rater.rater)
    }
  }
  const raterCount = raterNames.size || blindReveals.length
  const completeExperiments = blindReveals.filter((reveal) =>
    (reveal.raters?.length ?? 0) >= 2).length
  const deltas = blindReveals.flatMap((reveal) =>
    (reveal.overall ?? []).map((item) => item.delta).filter((value) => Number.isFinite(value)))
  const averageDelta = deltas.length
    ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
    : null
  const agreements = blindReveals
    .map((reveal) => reveal.agreement)
    .filter((value) => Number.isFinite(value))
  const agreement = agreements.length
    ? agreements.reduce((sum, value) => sum + value, 0) / agreements.length
    : null
  return {
    raters: raterCount,
    experiments: blindReveals.length,
    averageDelta: averageDelta == null ? null : Math.round(averageDelta * 100) / 100,
    agreement: agreement == null ? null : Math.round(agreement * 1000) / 1000,
    completeExperiments,
    insufficient: raterCount < 2 || completeExperiments === 0,
  }
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

  const envelopeFailures = envelope.filter((item) =>
    item.decision === 'FAIL' && highConfidence(item))
  const uncertainFailures = envelope.filter((item) =>
    item.decision === 'FAIL' && !highConfidence(item))
  const needsListeningItems = envelope.filter((item) =>
    item.decision === 'NEEDS_LISTENING')
  const sUncertain = envelope.filter((item) =>
    item.severity === 'S' && item.decision !== 'FAIL' && item.decision !== 'NEEDS_LISTENING')
  const needsListening = needsListeningItems.length + uncertainFailures.length
  const oovSample = oovRecall?.sample?.length ?? 0

  const regressionStatus = regressionOf(selfIteration)
  const acousticGate = gates.find((gate) => gate?.name?.includes('声学'))
  const performance = acousticGate
    ? { status: classifyGate(acousticGate), synthSmokeMs: acousticGate.durationMs ?? null }
    : { status: 'NEEDS_LISTENING', synthSmokeMs: null }

  const blind = summarizeBlind(blindReveals)
  const provenance = checkProvenance(
    inputs.provenance?.expected ?? null,
    inputs.provenance?.sources ?? [],
  )

  const reasons = []
  if (deterministicErrors.length) reasons.push(`硬性门禁失败：${deterministicErrors.join('、')}`)
  if (regressionStatus === 'FAIL') {
    reasons.push(`历史回归失败：${selfIteration?.failures?.length ?? 0} 条`)
  }
  if (envelopeFailures.length) reasons.push(`高置信度包络异常：${envelopeFailures.length} 条`)
  if (needsListening) reasons.push(`包络定位不确定或需复听：${needsListening} 条`)
  if (sUncertain.length) reasons.push(`S 级风险但定位不确定：${sUncertain.length} 条`)
  if (oovSample) reasons.push(`OOV 待复听抽样：${oovSample} 条`)
  if (!blindReveals.length) reasons.push('缺少盲听解盲结果')
  else if (blind.insufficient) reasons.push(`独立评分者不足：${blind.raters}/2`)
  if (performance.status === 'NEEDS_LISTENING') reasons.push('缺少声学冒烟结果')
  if (provenance.status !== 'OK') {
    reasons.push(`数据版本未通过校验：${provenance.status}`)
  }
  if (advisoryWarnings.length) reasons.push(`advisory 警告：${advisoryWarnings.join('、')}`)

  let status = 'PASS'
  if (
    deterministicErrors.length
    || regressionStatus === 'FAIL'
    || envelopeFailures.length
  ) {
    status = 'FAIL'
  } else if (
    needsListening
    || sUncertain.length
    || oovSample
    || !blindReveals.length
    || blind.insufficient
    || performance.status === 'NEEDS_LISTENING'
    || provenance.status !== 'OK'
  ) {
    status = 'NEEDS_LISTENING'
  } else if (advisoryWarnings.length || performance.status === 'WARNING') {
    status = 'WARNING'
  }

  return {
    status,
    reasons,
    deterministicErrors,
    advisoryWarnings,
    highRiskListening: needsListening + sUncertain.length + oovSample,
    needsListening,
    envelopeFailures: envelopeFailures.length,
    sUncertain: sUncertain.length,
    oovSample,
    blind,
    envelope: {
      pass: envelope.filter((item) => item.decision === 'PASS').length,
      needsListening,
      fail: envelopeFailures.length,
      uncertainFail: uncertainFailures.length,
    },
    regression: { status: regressionStatus, failures: selfIteration?.failures?.length ?? null },
    performance,
    provenance,
    statuses: QUALITY_STATUSES,
  }
}

export function formatQualityReport(report) {
  const blindLine = report.blind.averageDelta == null
    ? '未提供解盲结果'
    : `${report.blind.averageDelta}（${report.blind.raters} 名评分者${
      report.blind.agreement == null ? '' : ` · 一致性 ${Math.round(report.blind.agreement * 100)}%`
    }）`
  const provenanceLine = report.provenance.status === 'OK'
    ? `OK（${report.provenance.checked} 份输入）`
    : `${report.provenance.status}${
      report.provenance.mismatches.length ? `：${report.provenance.mismatches[0]}` : ''
    }`
  return [
    `# 山岚 TTS 质量报告：${report.status}`,
    '',
    '- PASS：硬性测试通过、包络高置信度无异常、版本一致且至少两名独立评分者。',
    '- WARNING：只有 advisory 风险；NEEDS_LISTENING：证据不足或必须人工复听；FAIL：确定性失败。',
    '- 自动指标只负责发现问题和守住回归；最终音质以盲听为准。',
    '',
    '| 指标 | 结果 |',
    '| --- | --- |',
    `| 确定性失败 | ${report.deterministicErrors.join('、') || '0'} |`,
    `| advisory 警告 | ${report.advisoryWarnings.join('、') || '0'} |`,
    `| 高置信度包络异常 | ${report.envelopeFailures} |`,
    `| S 级定位不确定 | ${report.sUncertain} |`,
    `| 高风险待复听 | ${report.highRiskListening}（包络 ${report.needsListening} + OOV 抽样 ${report.oovSample}） |`,
    `| 盲听评分变化 | ${blindLine} |`,
    `| 历史回归 | ${report.regression.status}（失败 ${report.regression.failures ?? '—'}） |`,
    `| 声学冒烟 | ${report.performance.status} · ${report.performance.synthSmokeMs ?? '—'}ms |`,
    `| 数据版本 | ${provenanceLine} |`,
    '',
    '## 状态原因',
    '',
    ...(report.reasons.length ? report.reasons.map((reason) => `- ${reason}`) : ['- 无']),
  ].join('\n')
}
