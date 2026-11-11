#!/usr/bin/env node
// Dev-only: compile attribution rules (readingRules.v1.jsonl) into whole-word
// overlay lines, golden-set candidates and a compile report.
//
// Safety model:
//   * Rules never rewrite polyphones.v1.txt implicitly. The default output is a
//     candidate file for human review.
//   * --apply additionally requires --confirm, zero conflicts, and a whole-book
//     impact diff with zero unexpected changes.
//   * Rules of class `frontend` and scope `family` are reported as delegated,
//     never compiled (single-character entries are forbidden in this project).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pinyin } from 'pinyin-pro'
import { ROOT, loadMatchaAssets, phoneticPhones } from './lib/reading.mjs'
import { loadCorpus } from './lib/corpus.mjs'
import { applyOverlay, compareReadingChanges } from './lib/impact.mjs'

const RULES_PATH = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const OVERLAY_PATH = resolve(ROOT, 'src/core/tts/polyphones.v1.txt')
const OUT_PATH = resolve(ROOT, 'scripts/out/overlay-candidates.txt')
const REPORT_PATH = resolve(ROOT, 'scripts/out/compile-report.json')
const GOLDEN_PATH = resolve(ROOT, 'scripts/out/golden-candidates.jsonl')
const DEFAULT_CORPORA = ['scripts/out/ming.txt', 'public/sample.epub']
const PINYIN_OPTS = { toneType: 'num', v: true }
const COMPILABLE = new Set(['phone', 'boundary'])

function parseArgs(argv) {
  const options = {
    rules: RULES_PATH,
    target: OVERLAY_PATH,
    out: OUT_PATH,
    report: REPORT_PATH,
    golden: GOLDEN_PATH,
    corpora: [],
    limit: 0,
    includeCandidates: false,
    apply: false,
    confirm: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--rules=')) options.rules = resolve(ROOT, arg.slice(8))
    else if (arg.startsWith('--target-overlay=')) options.target = resolve(ROOT, arg.slice(17))
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--report=')) options.report = resolve(ROOT, arg.slice(9))
    else if (arg.startsWith('--golden=')) options.golden = resolve(ROOT, arg.slice(9))
    else if (arg.startsWith('--corpus=')) options.corpora.push(arg.slice(9))
    else if (arg.startsWith('--limit-sentences=')) options.limit = numberOption(arg, 0)
    else if (arg === '--include-candidates') options.includeCandidates = true
    else if (arg === '--apply') options.apply = true
    else if (arg === '--confirm') options.confirm = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  options.defaultCorpora = !options.corpora.length
  if (options.defaultCorpora) options.corpora = DEFAULT_CORPORA
  return options
}

function numberOption(arg, fallback) {
  const value = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

function printHelp() {
  console.log(`用法: node scripts/compile-overlay.mjs [选项]

把 src/core/tts/readingRules.v1.jsonl 的归因规则编译成整词覆盖行。默认只产出
候选文件，绝不自动改写 polyphones.v1.txt。

  --rules=<file>            规则资产（默认 src/core/tts/readingRules.v1.jsonl）
  --out=<file>              候选覆盖行（默认 scripts/out/overlay-candidates.txt）
  --report=<file>           编译报告 JSON（默认 scripts/out/compile-report.json）
  --golden=<file>           黄金集候选（默认 scripts/out/golden-candidates.jsonl）
  --include-candidates      把 status=candidate 的规则也纳入报告
  --apply --confirm         两个开关同时给出才写入覆盖表；写前强制跑全书影响面
                            diff，存在冲突或意外变化时拒绝写入
  --target-overlay=<file>   写入目标（默认 src/core/tts/polyphones.v1.txt）
  --corpus=<file>           影响面语料，可重复
  --limit-sentences=N       影响面只扫描前 N 句

合并后请执行 npm run regression:build && npm run audit:golden。`)
}

function normalizePhone(raw) {
  return String(raw ?? '').toLowerCase().replace(/ü/g, 'v')
}

async function loadRules(path) {
  const text = await readFile(path, 'utf8')
  const rules = []
  const errors = []
  const ids = new Set()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let rule
    try {
      rule = JSON.parse(trimmed)
    } catch {
      errors.push(`第 ${index + 1} 行不是合法 JSON`)
      continue
    }
    if (!rule?.id || ids.has(rule.id)) {
      errors.push(`第 ${index + 1} 行 id 缺失或重复：${rule?.id ?? '?'}`)
      continue
    }
    ids.add(rule.id)
    const problem = validateRule(rule)
    if (problem) errors.push(`${rule.id}: ${problem}`)
    rules.push(rule)
  }
  return { rules, errors }
}

function validateRule(rule) {
  if (!['approved', 'candidate', 'rejected'].includes(rule.status)) return 'status 非法'
  if (!['phone', 'boundary', 'frontend'].includes(rule.class)) return 'class 非法'
  if (!rule.source) return '缺少 source'
  if (rule.class === 'frontend') return rule.target ? null : 'frontend 规则缺少 target'
  if (!rule.word) return '缺少 word'
  const chars = Array.from(rule.word)
  if (!Number.isInteger(rule.offset) || rule.offset < 0 || rule.offset >= chars.length) {
    return 'offset 越界'
  }
  if (chars[rule.offset] !== rule.char) return `第 ${rule.offset} 字应为 ${rule.char}`
  if (!/^[a-z]+[0-5]?$/.test(String(rule.phone))) return 'phone 格式非法'
  if (!['keep', 'append', 'lead', 'both', 'remove', 'internal'].includes(rule.boundary)) {
    return 'boundary 非法'
  }
  // Word-internal boundaries are legacy only: they made 「便」 read with a
  // truncated tone. Kept so old records still parse, never auto-generated.
  if (rule.boundary === 'internal'
    && (!Number.isInteger(rule.internalAfter)
      || rule.internalAfter < 1
      || rule.internalAfter > chars.length - 1)) {
    return 'internal 边界必须给出 internalAfter（1..字数-1），且不得落在词尾'
  }
  if (!['word', 'family'].includes(rule.scope)) return 'scope 非法'
  if (!Array.isArray(rule.evidence) || !rule.evidence.length) return '缺少 evidence'
  return null
}

function baseReading(word, effective) {
  const current = effective.get(word)
  if (current) return phoneticPhones(current)
  return (pinyin(word, { ...PINYIN_OPTS, type: 'array' }) ?? []).map(normalizePhone)
}

/** Longer lexicon words sharing this prefix could change longest-match results. */
function segmentationRisks(word, effective) {
  const risks = []
  for (const candidate of effective.keys()) {
    if (candidate.length <= Array.from(word).length) continue
    if (candidate.startsWith(word)) risks.push(candidate)
  }
  return risks.slice(0, 5)
}

function compile({ rules, assets, includeCandidates }) {
  const rows = []
  const golden = []
  const grouped = new Map()

  for (const rule of rules) {
    if (rule.status !== 'approved' && !(includeCandidates && rule.status === 'candidate')) {
      rows.push({ id: rule.id, status: 'skipped', reason: `status=${rule.status}` })
      continue
    }
    if (rule.class === 'frontend') {
      rows.push({ id: rule.id, status: 'delegated', reason: '文本前端配置，不生成覆盖行', target: rule.target })
      continue
    }
    if (rule.scope !== 'word') {
      rows.push({ id: rule.id, status: 'needs-word', reason: `scope=${rule.scope}，禁止生成单字条目`, word: rule.word, phone: rule.phone })
      continue
    }
    const list = grouped.get(rule.word) ?? []
    list.push(rule)
    grouped.set(rule.word, list)
  }

  const candidates = []
  for (const [word, list] of grouped) {
    const chars = Array.from(word)
    const phones = baseReading(word, assets.effective)
    const row = {
      id: list.map((item) => item.id).join('+'),
      word,
      rules: list.map((item) => item.id),
      sources: [...new Set(list.map((item) => item.source))],
      evidence: [...new Set(list.flatMap((item) => item.evidence))].slice(0, 3),
    }
    if (phones.length !== chars.length) {
      rows.push({ ...row, status: 'invalid', reason: '音素数与字数不一致' })
      continue
    }
    for (const rule of list) {
      if (!assets.tokens.has(rule.phone)) {
        row.invalid = `模型不存在音素 ${rule.phone}`
        break
      }
      if (!/[0-5]$/.test(rule.phone) && !assets.neutrals.has(rule.phone)) {
        row.invalid = `模型未训练轻声 ${rule.phone}`
        break
      }
      phones[rule.offset] = rule.phone
    }
    if (row.invalid) {
      rows.push({ ...row, status: 'invalid', reason: row.invalid })
      continue
    }

    const internal = list.find((item) => item.boundary === 'internal')
    const lead = list.some((item) => item.boundary === 'lead' || item.boundary === 'both')
    const tail = list.some((item) => item.boundary === 'append' || item.boundary === 'both')
    let compiledReading
    if (internal) {
      // Legacy diagnosis path (词内边界). New records must use lead/both/tail:
      // a boundary inside a word truncates the syllable's tone (占便宜 「便」).
      const at = internal.internalAfter
      compiledReading = [
        ...phones.slice(0, at), '"', ...phones.slice(at),
      ].join(' ')
    } else {
      const tailBoundary = tail
        ? ' "'
        : list.some((item) => item.boundary === 'remove')
          ? ''
          : /\s"$/.test(assets.effective.get(word) ?? '') ? ' "' : ''
      compiledReading = `${lead ? '" ' : ''}${phones.join(' ')}${tailBoundary}`
    }
    const line = `${word} ${compiledReading}`
    const curated = assets.overlay.entries.get(word)
    const status = curated === compiledReading
      ? 'already'
      : curated !== undefined
        ? 'conflict'
        : assets.lexicon.has(word)
          ? 'override'
          : 'new'
    row.line = line
    row.status = status
    row.current = curated ?? assets.lexicon.get(word) ?? null
    row.segmentationRisks = segmentationRisks(word, assets.effective)
    if (status === 'conflict') {
      row.reason = `人工表已有「${curated}」，需人工决定是否覆盖`
    } else if (row.segmentationRisks.length) {
      row.reason = `存在更长的同前缀词条：${row.segmentationRisks.join('、')}；以影响面 diff 为准`
    }
    rows.push(row)
    if (status === 'new' || status === 'override') {
      candidates.push(row)
      const target = list[0]
      for (const evidence of row.evidence.slice(0, 1)) {
        const wordStart = evidence.indexOf(word)
        const charIndex = wordStart >= 0
          ? wordStart + Array.from(word).indexOf(target.char)
          : evidence.indexOf(target.char)
        const occurrence = charIndex < 0
          ? 1
          : Array.from(evidence.slice(0, charIndex + 1))
            .filter((item) => item === target.char).length
        golden.push({
          id: `rule-${word}`,
          word,
          text: evidence,
          readings: [[target.char, occurrence || 1, target.phone]],
        })
      }
    }
  }
  return { rows, candidates, golden }
}

async function impactOf(candidates, assets, options) {
  const overlayText = candidates.map((item) => item.line).join('\n')
  const { after, changedWords } = applyOverlay(assets.effective, overlayText)
  const results = []
  for (const path of options.corpora) {
    let corpus
    try {
      corpus = await loadCorpus(resolve(ROOT, path))
    } catch {
      // Try the next default corpus (sample.epub) when the book text is absent,
      // e.g. on a fresh CI checkout where scripts/out is not committed.
      continue
    }
    const report = compareReadingChanges({
      text: corpus.text,
      before: assets.effective,
      after,
      changedWords,
      limitSentences: options.limit,
    })
    results.push({ path, ...report })
    if (options.defaultCorpora) break
  }
  return {
    sentences: results.reduce((sum, item) => sum + item.sentences, 0),
    intended: results.reduce((sum, item) => sum + item.intended, 0),
    unexpected: results.reduce((sum, item) => sum + item.unexpected, 0),
    samples: results.flatMap((item) => item.samples.filter((sample) => !sample.intentional)).slice(0, 10),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()
  const { rules, errors } = await loadRules(options.rules)
  if (errors.length) {
    for (const error of errors) console.error(`  规则错误 ${error}`)
    throw new Error(`规则资产有 ${errors.length} 处格式错误，编译中止`)
  }

  const { rows, candidates, golden } = compile({ rules, assets, includeCandidates: options.includeCandidates })
  const conflicts = rows.filter((row) => row.status === 'conflict')
  const impact = candidates.length ? await impactOf(candidates, assets, options) : {
    sentences: 0, intended: 0, unexpected: 0, samples: [],
  }

  await mkdir(dirname(options.out), { recursive: true })
  const header = [
    '# 由 readingRules.v1.jsonl 编译，人工复核后再合并到 polyphones.v1.txt。',
    `# 生成时间 ${new Date().toISOString()} · 规则 ${rules.length} 条 · 候选 ${candidates.length} 行`,
    '# 冲突行不会出现在下面；合并后请执行 npm run regression:build && npm run audit:golden。',
  ]
  await writeFile(options.out, `${header.join('\n')}\n${candidates.map((item) => item.line).join('\n')}\n`, 'utf8')
  await writeFile(
    options.golden,
    `# 由规则编译生成，人工复核后追加到 tests/fixtures/pronunciation-golden.jsonl\n` +
      `${golden.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )
  const report = { rules: rules.length, rows, candidates, conflicts, impact, golden }
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const counts = new Map()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  console.log(`规则 ${rules.length} 条 → ${[...counts.entries()].map(([name, count]) => `${name} ${count}`).join(' · ')}`)
  console.log(`候选覆盖行 ${candidates.length} 条 / 冲突 ${conflicts.length} 条 / 黄金集候选 ${golden.length} 条`)
  console.log(`影响面：${impact.sentences} 句 / 目标变化 ${impact.intended} 处 / 意外变化 ${impact.unexpected} 处`)
  for (const conflict of conflicts) console.log(`  冲突  ${conflict.word}: ${conflict.reason}`)
  for (const sample of impact.samples.slice(0, 5)) {
    console.log(`  意外  ${sample.char} ${sample.before} → ${sample.after}（${sample.beforeWord} → ${sample.afterWord}）${sample.context}`)
  }
  console.log(`候选 ${options.out}`)
  console.log(`报告 ${options.report}`)

  if (options.apply) {
    if (!options.confirm) throw new Error('--apply 必须同时给出 --confirm')
    if (conflicts.length) throw new Error(`存在 ${conflicts.length} 条冲突，拒绝写入`)
    if (impact.unexpected > 0) throw new Error(`存在 ${impact.unexpected} 处意外变化，拒绝写入`)
    if (!candidates.length) {
      console.log('没有需要写入的候选行，覆盖表保持不变。')
      return
    }
    const target = await readFile(options.target, 'utf8')
    const block = [
      '',
      `# P1 规则编译产物 ${new Date().toISOString()}`,
      `# 规则 ${candidates.map((item) => item.rules.join('+')).join('、')}`,
      ...candidates.map((item) => item.line),
      '',
    ].join('\n')
    await writeFile(options.target, `${target.trimEnd()}\n${block}`, 'utf8')
    console.log(`\n已写入 ${options.target}（${candidates.length} 行）；请重建快照并跑读音门禁。`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
