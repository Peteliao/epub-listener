#!/usr/bin/env node
// Dev-only: close the loop from a listening report to a reusable asset.
//
//   feedback JSONL -> reports-to-overlay triage -> match against approved
//   rules / acoustic exceptions / P0 risk inventory -> either "already closed"
//   (zero human work) or a candidate rule / exception / human decision.
//
// The measurable goal: adding a batch of reports must not add human work
// linearly. --verify proves it with the 2026-11-09 batch (all already closed).
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'

const OUT = resolve(ROOT, 'scripts/out/feedback-loop.json')
const RULE_CANDIDATES = resolve(ROOT, 'scripts/out/feedback-rule-candidates.jsonl')
const EXCEPTION_CANDIDATES = resolve(ROOT, 'scripts/out/feedback-exception-candidates.jsonl')
const RULES = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const EXCEPTIONS = resolve(ROOT, 'src/core/tts/acousticExceptions.v1.jsonl')
const RISKS = resolve(ROOT, 'scripts/out/pronunciation-risks.jsonl')

const VERIFY_FEEDBACK = [
  { sentence: '他向朱元璋建议，应立即度过长江。', word: '应立即', char: '应', expectedPinyin: 'ying1' },
  { sentence: '正因如此，一些会占便宜的有钱人长期地用盐不给钱。', word: '占便宜', char: '便', expectedPinyin: 'pian2' },
  { sentence: '重新壮大自己，原已处于低潮的起义开始转入高潮。', word: '原已', char: '已', expectedPinyin: 'yi3' },
  { sentence: '陈友谅还没有完全掌控天完国的政权，所有最先于朱元璋发生冲突的是张士诚。', word: '最先', char: '先', expectedPinyin: 'xian1' },
  { sentence: '朱元璋对张士诚极为头疼，自己只是占了点地盘；', word: '地盘', char: '地', expectedPinyin: 'di4' },
  { sentence: '千军易得，一将难求。', word: '易得', char: '得', expectedPinyin: 'de2' },
  { sentence: '而是率意而为，打到哪儿算哪儿。', word: '率意', char: '率', expectedPinyin: 'shuai4' },
  { sentence: '太平被攻破了，应天就像一个赤裸的孩子。', word: '应天', char: '应', expectedPinyin: 'ying4' },
  { sentence: '看来上天要抛弃朱元璋了。', word: '上天', char: '天', expectedPinyin: 'tian1' },
]

function parseArgs(argv) {
  const options = {
    reports: null,
    triage: null,
    out: OUT,
    ruleCandidates: RULE_CANDIDATES,
    exceptionCandidates: EXCEPTION_CANDIDATES,
    verify: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--reports=')) options.reports = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--triage=')) options.triage = resolve(ROOT, arg.slice(9))
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--rule-candidates=')) options.ruleCandidates = resolve(ROOT, arg.slice(18))
    else if (arg.startsWith('--exception-candidates=')) options.exceptionCandidates = resolve(ROOT, arg.slice(23))
    else if (arg === '--verify') options.verify = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function printHelp() {
  console.log(`用法: node scripts/feedback-loop.mjs --reports=<反馈.jsonl> [选项]

把听音反馈自动归类并判断闭环状态：已沉淀（零人工）/ 需新增规则 / 需新增
声学例外 / 需人工判定，同时输出可直接复核的规则与例外候选。

  --verify                用 2026-11-09 的 9 条反馈验收（应全部已沉淀）
  --reports=<file>        应用内导出的读音反馈 JSONL
  --triage=<file>         直接给 reports-to-overlay 的分类结果，跳过再次归类
  --out=<file>            JSON 报告（默认 scripts/out/feedback-loop.json）
  --rule-candidates=<file>      P1 规则候选 JSONL
  --exception-candidates=<file> P2 声学例外候选 JSONL

验收目标：新增一批反馈时，人工决策点不随反馈条数线性增长。`)
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
    return []
  }
}

function verifyReports() {
  return VERIFY_FEEDBACK.map((item, index) => {
    const wordStart = item.sentence.indexOf(item.word)
    const charOffset = Array.from(item.word).indexOf(item.char)
    const charIndex = wordStart + charOffset
    return {
      id: `verify-${index + 1}`,
      paragraph: { text: item.sentence },
      marks: [{
        char: item.char,
        charIndex,
        word: item.word,
        wordStart,
        wordEnd: wordStart + item.word.length,
        expectedPinyin: item.expectedPinyin,
      }],
      voice: { voiceLabel: '山岚' },
    }
  })
}

async function triageReports(options, tmpDir) {
  if (options.triage) return readJsonl(options.triage)
  const reportsPath = join(tmpDir, 'reports.jsonl')
  const triagePath = join(tmpDir, 'triage.jsonl')
  const reports = options.verify
    ? verifyReports()
    : await readJsonl(options.reports)
  if (!reports.length) throw new Error('没有可处理的反馈记录')
  await writeFile(reportsPath, `${reports.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  const result = spawnSync(
    process.execPath,
    ['scripts/reports-to-overlay.mjs', reportsPath, `--triage=${triagePath}`],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`反馈归类失败：${result.stdout}\n${result.stderr}`)
  }
  return readJsonl(triagePath)
}

function indexByWord(records) {
  const map = new Map()
  for (const record of records) {
    if (!record.word) continue
    const list = map.get(record.word) ?? []
    list.push(record)
    map.set(record.word, list)
  }
  return map
}

function ruleCandidate(row) {
  const word = row.word
  const chars = Array.from(word)
  const phones = String(row.phones ?? '').split(/\s+/)
  const sample = row.samples?.[0] ?? {}
  const offset = Math.max(0, chars.indexOf(sample.char ?? chars[0]))
  return {
    id: `loop-${word}`,
    status: 'candidate',
    class: 'phone',
    word,
    char: sample.char ?? chars[0],
    offset,
    phone: phones[offset] ?? row.phones,
    boundary: 'keep',
    scope: 'word',
    source: `feedback-loop:${row.reports ?? 1}`,
    confidence: 'likely',
    evidence: [sample.text].filter(Boolean),
    note: '由反馈闭环生成，需人工听音确认后改为 approved 并运行 rules:compile',
    createdAt: new Date().toISOString().slice(0, 10),
  }
}

function exceptionCandidate(row) {
  return {
    word: row.word,
    charCount: Array.from(row.word).length,
    class: 'boundary',
    currentBoundary: 'none',
    recommendation: 'needs-review',
    status: 'pending-listening',
    requiresHuman: true,
    source: 'feedback-loop',
    note: '读音已正确但仍被报错，属 C 类声学问题；请运行 audit:acoustics 做 A/B',
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.verify && !options.reports && !options.triage) {
    printHelp()
    process.exitCode = 1
    return
  }
  const tmpDir = await mkdtemp(join(tmpdir(), 'shusheng-loop-'))
  try {
    const [triage, rules, exceptions, risks] = await Promise.all([
      triageReports(options, tmpDir),
      readJsonl(RULES),
      readJsonl(EXCEPTIONS),
      readJsonl(RISKS),
    ])
    const approvedRules = indexByWord(rules.filter((item) => item.status === 'approved'))
    const exceptionIndex = indexByWord(exceptions)
    const riskIndex = indexByWord(risks)

    const items = []
    for (const row of triage) {
      if (!row.word || !row.class) continue
      const closedByRule = approvedRules.get(row.word)?.[0]?.id ?? null
      const closedByException = exceptionIndex.has(row.word)
      const riskCount = (riskIndex.get(row.word) ?? [])
        .reduce((sum, item) => sum + (item.count ?? 1), 0)
      let loopState
      if (closedByRule || closedByException) loopState = 'closed'
      else if (row.class === 'acoustic') loopState = 'acoustic-candidate'
      else if (row.class === 'new' || row.class === 'override-lexicon') loopState = 'rule-candidate'
      else loopState = 'needs-human'
      items.push({
        word: row.word,
        triageClass: row.class,
        phones: row.phones ?? null,
        loopState,
        closedBy: closedByRule ? `rule:${closedByRule}` : closedByException ? 'acoustic-exception' : null,
        riskMatches: riskCount,
        reports: row.reports ?? 1,
        samples: row.samples ?? [],
      })
    }

    const ruleRows = items.filter((item) => item.loopState === 'rule-candidate')
    const exceptionRows = items.filter((item) => item.loopState === 'acoustic-candidate')
    const human = items.filter((item) => item.loopState === 'needs-human')
    const closed = items.filter((item) => item.loopState === 'closed')
    const automation = items.length ? Math.round(closed.length / items.length * 100) : 100

    const report = {
      generatedAt: new Date().toISOString(),
      verify: options.verify,
      totals: {
        feedback: items.length,
        closed: closed.length,
        ruleCandidates: ruleRows.length,
        acousticCandidates: exceptionRows.length,
        humanDecisionPoints: human.length + ruleRows.length + exceptionRows.length,
        automationPercent: automation,
      },
      items,
      note: 'closed 表示该反馈已被已批准规则或声学例外覆盖，无需新增人工决策；候选需听音确认后才可批准。',
    }

    await mkdir(dirname(options.out), { recursive: true })
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await writeFile(
      options.ruleCandidates,
      `# 反馈闭环生成的规则候选，人工确认后追加到 src/core/tts/readingRules.v1.jsonl\n` +
        `${ruleRows.map((item) => JSON.stringify(ruleCandidate(item))).join('\n')}\n`,
      'utf8',
    )
    await writeFile(
      options.exceptionCandidates,
      `# 反馈闭环生成的声学例外候选，人工确认后追加到 src/core/tts/acousticExceptions.v1.jsonl\n` +
        `${exceptionRows.map((item) => JSON.stringify(exceptionCandidate(item))).join('\n')}\n`,
      'utf8',
    )

    console.log(`反馈 ${items.length} 条：已沉淀 ${closed.length} · 规则候选 ${ruleRows.length} · 声学候选 ${exceptionRows.length} · 需人工 ${human.length}`)
    console.log(`自动化闭环率 ${automation}% · 人工决策点 ${report.totals.humanDecisionPoints}`)
    for (const item of items) {
      console.log(`  ${item.loopState.padEnd(18)} ${item.word.padEnd(6)} ${item.triageClass.padEnd(18)} 风险同类 ${item.riskMatches} 处${item.closedBy ? ` · ${item.closedBy}` : ''}`)
    }
    console.log(`报告 ${options.out}`)

    if (options.verify) {
      const failures = []
      if (items.length !== VERIFY_FEEDBACK.length) failures.push(`应处理 ${VERIFY_FEEDBACK.length} 条，实际 ${items.length} 条`)
      if (automation !== 100) failures.push(`应全部已沉淀，实际 ${automation}%`)
      if (report.totals.humanDecisionPoints !== 0) failures.push(`应零人工决策点，实际 ${report.totals.humanDecisionPoints}`)
      console.log('\n验收（--verify）：')
      if (failures.length) {
        for (const failure of failures) console.log(`  未通过  ${failure}`)
        process.exitCode = 1
      } else {
        console.log(`  ${items.length}/${items.length} 通过：本批反馈已全部由 P1 规则与 P2 声学例外沉淀，新增反馈未增加人工决策点`)
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
