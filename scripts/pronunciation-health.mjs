#!/usr/bin/env node
// Dev-only: one-page health report for the 山岚 pronunciation system.
//
// Aggregates P0 risk inventory, P1 compile report, P2 acoustic report, the
// curated assets and the golden set into a single scorecard, and appends a
// compact history row so the convergence trend is visible over time.
//
// Every input is optional except the assets themselves: on a fresh CI checkout
// (no scripts/out artefacts) the report degrades gracefully instead of failing.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ROOT, loadMatchaAssets, readingAt } from './lib/reading.mjs'

const OUT = resolve(ROOT, 'scripts/out/pronunciation-health.json')
const SUMMARY = resolve(ROOT, 'scripts/out/pronunciation-health.md')
const HISTORY = resolve(ROOT, 'scripts/out/health-history.jsonl')
const GATES = resolve(ROOT, 'scripts/out/gate-results.json')
const RULES = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const EXCEPTIONS = resolve(ROOT, 'src/core/tts/acousticExceptions.v1.jsonl')
const GOLDEN = resolve(ROOT, 'tests/fixtures/pronunciation-golden.jsonl')
const REGRESSION = resolve(ROOT, 'tests/fixtures/pronunciation-regression.jsonl')
const RISKS = resolve(ROOT, 'scripts/out/pronunciation-risks.jsonl')
const COMPILE = resolve(ROOT, 'scripts/out/compile-report.json')
const ACOUSTICS = resolve(ROOT, 'scripts/out/acoustics-report.json')
const IMPACT = resolve(ROOT, 'scripts/out/pronunciation-impact.json')

function parseArgs(argv) {
  const options = { out: OUT, summary: SUMMARY, history: HISTORY, gates: GATES, noHistory: false }
  for (const arg of argv) {
    if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--history=')) options.history = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--gates=')) options.gates = resolve(ROOT, arg.slice(8))
    else if (arg === '--no-history') options.noHistory = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function printHelp() {
  console.log(`用法: node scripts/pronunciation-health.mjs [选项]

汇总山岚读音体系的健康度与收敛趋势。所有 scripts/out 诊断产物都是可选的，
缺失时相应指标标记为 unavailable，脚本仍正常退出。

  --out=<file>       JSON 报告（默认 scripts/out/pronunciation-health.json）
  --summary=<file>   Markdown 摘要（默认 scripts/out/pronunciation-health.md）
  --history=<file>   趋势历史 JSONL（默认 scripts/out/health-history.jsonl）
  --gates=<file>     audit:all 的门禁结果（默认 scripts/out/gate-results.json）
  --no-history       只出报告不追加历史（CI 用）`)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return []
      try {
        return [JSON.parse(trimmed)]
      } catch {
        return []
      }
    })
  } catch {
    return null
  }
}

async function countLines(path) {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#')).length
  } catch {
    return 0
  }
}

function goldenMismatches(assets, cases) {
  if (!cases) return null
  let mismatches = 0
  let checked = 0
  for (const record of cases) {
    if (!Array.isArray(record.readings)) continue
    for (const [char, occurrence, expected] of record.readings) {
      checked += 1
      try {
        const resolved = readingAt(record.text, char, occurrence, assets.effective)
        if (resolved.phone !== expected) mismatches += 1
      } catch {
        mismatches += 1
      }
    }
  }
  return { checked, mismatches }
}

function gatesScore(gates) {
  if (!gates?.gates?.length) return { available: false, passed: 0, failed: 0, skipped: 0, score: null }
  const list = gates.gates
  const passed = list.filter((item) => item.status === 0 && !item.skipped).length
  const failed = list.filter((item) => item.status !== 0 && !item.skipped).length
  const skipped = list.filter((item) => item.skipped).length
  const score = passed + failed ? Math.round(passed / (passed + failed) * 100) : 100
  return { available: true, passed, failed, skipped, score }
}

function riskStats(risks) {
  if (!risks) return { available: false }
  const byStatus = {}
  const byKind = {}
  let topScore = 0
  for (const item of risks) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    topScore = Math.max(topScore, Number(item.score) || 0)
  }
  return {
    available: true,
    total: risks.length,
    candidates: byStatus.candidate ?? 0,
    reviews: byStatus.review ?? 0,
    byStatus,
    byKind,
    topScore,
  }
}

function rulesStats(rules) {
  if (!rules) return { available: false }
  const byStatus = {}
  const byClass = {}
  for (const item of rules) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
    byClass[item.class] = (byClass[item.class] ?? 0) + 1
  }
  return { available: true, total: rules.length, byStatus, byClass }
}

function exceptionStats(exceptions) {
  if (!exceptions) return { available: false }
  const byStatus = {}
  let needsReview = 0
  for (const item of exceptions) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
    if (item.recommendation === 'needs-review') needsReview += 1
  }
  return { available: true, total: exceptions.length, byStatus, needsReview }
}

function trendFrom(history, current) {
  if (!history?.length) return { available: false }
  const previous = history[history.length - 1]
  const delta = (key) => current[key] - (previous[key] ?? current[key])
  return {
    available: true,
    previousAt: previous.generatedAt,
    delta: {
      overlayEntries: delta('overlayEntries'),
      goldenCases: delta('goldenCases'),
      approvedRules: delta('approvedRules'),
      candidates: delta('candidates'),
      reviews: delta('reviews'),
      humanDecisionPoints: delta('humanDecisionPoints'),
      gateScore: previous.gateScore === null || current.gateScore === null
        ? null
        : current.gateScore - previous.gateScore,
    },
  }
}

function arrow(value, lowerIsBetter = false) {
  if (value === 0 || value === null || value === undefined) return '→ 0'
  const good = lowerIsBetter ? value < 0 : value > 0
  return `${value > 0 ? '+' : ''}${value} ${good ? '✓' : '⚠'}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()
  const [rules, exceptions, golden, risks, compile, acoustics, impact, gates, history] = await Promise.all([
    readJsonl(RULES),
    readJsonl(EXCEPTIONS),
    readJsonl(GOLDEN),
    readJsonl(RISKS),
    readJson(COMPILE),
    readJson(ACOUSTICS),
    readJson(IMPACT),
    readJson(GATES),
    readJsonl(options.history),
  ])
  const goldenCases = golden?.length ?? 0
  const regressionCases = await countLines(REGRESSION)
  const overlayEntries = assets.overlay.entries.size
  const goldenCheck = goldenMismatches(assets, golden)
  const ruleInfo = rulesStats(rules)
  const exceptionInfo = exceptionStats(exceptions)
  const riskInfo = riskStats(risks)
  const gateInfo = gatesScore(gates)

  const compileConflicts = compile?.conflicts?.length ?? 0
  const acousticNeedsListening = acoustics?.cases?.filter((item) => item.needsListening).length ?? 0
  const acousticVerify = acoustics?.verify
    ? acoustics.cases.filter((item) => item.requiresHuman).length
    : null
  const impactUnexpected = impact?.total?.unexpected ?? null

  // A "human decision point" is anything that cannot be applied automatically.
  // Fewer of these per reported error is the measurable batching payoff.
  const humanDecisionPoints =
    (ruleInfo.byStatus?.candidate ?? 0) +
    exceptionInfo.needsReview +
    compileConflicts +
    acousticNeedsListening
  const automatedAssets =
    (ruleInfo.byStatus?.approved ?? 0) +
    (exceptionInfo.available ? exceptionInfo.total - exceptionInfo.needsReview : 0)
  const leverage = humanDecisionPoints === 0
    ? automatedAssets
    : Math.round(automatedAssets / humanDecisionPoints * 10) / 10

  const compact = {
    generatedAt: new Date().toISOString(),
    overlayEntries,
    goldenCases,
    regressionCases,
    approvedRules: ruleInfo.byStatus?.approved ?? 0,
    candidates: riskInfo.candidates ?? 0,
    reviews: riskInfo.reviews ?? 0,
    humanDecisionPoints,
    leverage,
    goldenMismatches: goldenCheck?.mismatches ?? null,
    gateScore: gateInfo.score,
  }

  const report = {
    ...compact,
    assets: {
      overlayEntries,
      goldenCases,
      regressionCases,
      rules: ruleInfo,
      acousticExceptions: exceptionInfo,
    },
    risks: riskInfo,
    regressions: {
      golden: goldenCheck,
      compileConflicts,
      impactUnexpected,
      acousticVerifyConfirmed: acousticVerify,
    },
    cost: {
      automatedAssets,
      humanDecisionPoints,
      leverage,
      note: 'leverage = 已自动化资产 / 待人工决策点；越大表示新增反馈越不需要线性增加人工操作',
    },
    gates: gateInfo,
    trend: trendFrom(history, compact),
    inputs: {
      risks: Boolean(risks),
      compile: Boolean(compile),
      acoustics: Boolean(acoustics),
      impact: Boolean(impact),
      gates: Boolean(gates),
    },
  }

  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(options.summary, renderSummary(report), 'utf8')
  if (!options.noHistory) {
    await mkdir(dirname(options.history), { recursive: true })
    await appendFile(options.history, `${JSON.stringify(compact)}\n`, 'utf8')
  }

  console.log(`山岚读音健康度 ${new Date(compact.generatedAt).toISOString().slice(0, 10)}`)
  console.log(`  资产：覆盖表 ${overlayEntries} 条 · 黄金集 ${goldenCases} 条 · 快照 ${regressionCases} 条 · 已批准规则 ${compact.approvedRules} 条`)
  console.log(`  门禁：${gateInfo.available ? `${gateInfo.passed} 通过 / ${gateInfo.failed} 失败 / ${gateInfo.skipped} 跳过（${gateInfo.score} 分）` : '未运行 audit:all'}`)
  console.log(`  回归：黄金集不一致 ${goldenCheck?.mismatches ?? '—'} · 编译冲突 ${compileConflicts} · 影响面意外 ${impactUnexpected ?? '—'} · 需复听 ${acousticNeedsListening}`)
  console.log(`  风险：${riskInfo.available ? `候选 ${riskInfo.candidates} / 待确认 ${riskInfo.reviews}` : '全书清单未生成（运行 npm run scan:risks）'}`)
  console.log(`  人工决策点 ${humanDecisionPoints} · 自动化触达比 ${leverage}`)
  console.log(`  报告 ${options.out}`)
  console.log(`  摘要 ${options.summary}`)
}

function renderSummary(report) {
  const lines = [
    '# 山岚读音健康度',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 门禁：${report.gates.available ? `${report.gates.passed} 通过 / ${report.gates.failed} 失败 / ${report.gates.skipped} 跳过 · **${report.gates.score} 分**` : '未运行 \`npm run audit:all\`'}`,
    '',
    '## 资产（沉淀量）',
    '',
    '| 指标 | 数量 |',
    '| --- | ---: |',
    `| 人工覆盖表条目 | ${report.assets.overlayEntries} |`,
    `| 黄金集用例 | ${report.assets.goldenCases} |`,
    `| 一致性快照用例 | ${report.assets.regressionCases} |`,
    `| 归因规则（已批准 / 候选 / 驳回） | ${report.assets.rules.byStatus?.approved ?? 0} / ${report.assets.rules.byStatus?.candidate ?? 0} / ${report.assets.rules.byStatus?.rejected ?? 0} |`,
    `| 声学例外（待复听 / 需复听） | ${report.assets.acousticExceptions.byStatus?.['pending-listening'] ?? 0} / ${report.assets.acousticExceptions.needsReview ?? 0} |`,
    '',
    '## 门禁与回归',
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    `| 黄金集读音不一致 | ${report.regressions.golden?.mismatches ?? '—'}（校验 ${report.regressions.golden?.checked ?? '—'} 个读音点） |`,
    `| 规则编译冲突 | ${report.regressions.compileConflicts} |`,
    `| 全书影响面意外变化 | ${report.regressions.impactUnexpected ?? '未运行'} |`,
    `| 声学需复听 | ${report.assets.acousticExceptions.needsReview ?? 0} |`,
    '',
    '## 风险与人工成本',
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    `| 全书风险候选 | ${report.risks.candidates ?? '未扫描'} |`,
    `| 待人工确认线索 | ${report.risks.reviews ?? '未扫描'} |`,
    `| 人工决策点 | ${report.cost.humanDecisionPoints} |`,
    `| 已自动化资产 | ${report.cost.automatedAssets} |`,
    `| 自动化触达比 | ${report.cost.leverage} |`,
    '',
    `> ${report.cost.note}`,
    '',
    '## 收敛趋势（对比上一次 health 记录）',
    '',
  ]
  if (!report.trend.available) {
    lines.push('首次运行，暂无对比基线。')
  } else {
    lines.push(`上一次：${report.trend.previousAt}`, '')
    lines.push('| 指标 | 变化 |')
    lines.push('| --- | --- |')
    lines.push(`| 覆盖表条目 | ${arrow(report.trend.delta.overlayEntries)} |`)
    lines.push(`| 黄金集用例 | ${arrow(report.trend.delta.goldenCases)} |`)
    lines.push(`| 已批准规则 | ${arrow(report.trend.delta.approvedRules)} |`)
    lines.push(`| 风险候选 | ${arrow(report.trend.delta.candidates, true)} |`)
    lines.push(`| 待确认线索 | ${arrow(report.trend.delta.reviews, true)} |`)
    lines.push(`| 人工决策点 | ${arrow(report.trend.delta.humanDecisionPoints, true)} |`)
    lines.push(`| 门禁分 | ${arrow(report.trend.delta.gateScore)} |`)
  }
  lines.push('', '> 健康度衡量「体系是否正常运转」，不等于「错读已清零」；残留错读以风险清单与听音反馈为准。', '')
  return lines.join('\n')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
