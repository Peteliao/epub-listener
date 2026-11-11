#!/usr/bin/env node
// Dev-only / CI: the P3 self-iterating pronunciation loop for 山岚.
//
//   discover (static, no WASM) -> measure (real WASM A/B) -> apply (impact diff
//   + overlay/rules/asset write-back + snapshot rebuild + full gates) -> verify
//
// P0 (risk scan) only finds wrong phones; P1 (attribution rules) and P2
// (acoustic exceptions) intentionally stop at "candidate, human review". This
// script closes the loop for the C-class errors those layers cannot find:
// correct phones that the acoustic model fuses into a different syllable.
// Every fix is A/B-measured on a real corpus window and gated by a whole-book
// impact diff, then recorded in fusionFixes.v1.jsonl so the next --verify run
// keeps proving both discovery and repair. No listening report is required to
// find the next 「来到了」-style word.
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  BOUNDARY_PHONE, ROOT, loadMatchaAssets, maxWordLength,
} from './lib/reading.mjs'
import { loadCorpus } from './lib/corpus.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import { NORMAL_MAX_MS, SWALLOW_MS, summarizeContributions } from './lib/acousticScoring.mjs'
import {
  candidateSpan, contextWindow, fixLine, phoneIndices, scanFusionRisks,
} from './lib/fusionRisk.mjs'

const OVERLAY = resolve(ROOT, 'src/core/tts/polyphones.v1.txt')
const RULES = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const FIXES = resolve(ROOT, 'src/core/tts/fusionFixes.v1.jsonl')
const REGRESSION = resolve(ROOT, 'tests/fixtures/pronunciation-regression.jsonl')
const OUT = resolve(ROOT, 'scripts/out/auto-loop.json')
const SUMMARY = resolve(ROOT, 'scripts/out/auto-loop.md')
const RISKS = resolve(ROOT, 'scripts/out/fusion-risks.jsonl')
const MEASURED = resolve(ROOT, 'scripts/out/fusion-fixes.jsonl')
const CANDIDATES = resolve(ROOT, 'scripts/out/fusion-candidates.txt')
const HISTORY = resolve(ROOT, 'scripts/out/auto-loop-history.jsonl')
const DEFAULT_CORPORA = ['scripts/out/ming.txt', 'public/sample.epub']
const MARGIN = 20
const MAX_FIX_CHARS = 3

// Anchors used by --verify on a fresh checkout (no full-book corpus needed).
// They also prove the scanner generalises beyond the one reported sentence.
const VERIFY_SENTENCES = [
  '也就是在此前不久，一个人来到了洪都，他是受朱元璋委派来此地镇守的。',
  '他走到了门口，回头看了一眼。',
  '军队跑到了城下，却迟迟不进攻。',
  '朱棣回到了北平，开始重新布置防务。',
  '他看到了那封信，脸色一下子变了。',
]

function parseArgs(argv) {
  const options = {
    verify: false,
    measure: false,
    apply: false,
    corpora: [],
    limit: 20,
    limitSentences: 0,
    radius: 10,
    includeLow: false,
    words: null,
    out: OUT,
    summary: SUMMARY,
    risks: RISKS,
    measured: MEASURED,
    history: HISTORY,
  }
  for (const arg of argv) {
    if (arg === '--verify') options.verify = true
    else if (arg === '--measure') options.measure = true
    else if (arg === '--apply') options.apply = true
    else if (arg.startsWith('--corpus=')) options.corpora.push(arg.slice(9))
    else if (arg.startsWith('--limit=')) options.limit = numberOption(arg, 20)
    else if (arg.startsWith('--limit-sentences=')) options.limitSentences = numberOption(arg, 0)
    else if (arg.startsWith('--radius=')) options.radius = numberOption(arg, 10)
    else if (arg === '--include-low') options.includeLow = true
    else if (arg.startsWith('--words=')) options.words = resolve(ROOT, arg.slice(8))
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--risks=')) options.risks = resolve(ROOT, arg.slice(8))
    else if (arg.startsWith('--measured=')) options.measured = resolve(ROOT, arg.slice(11))
    else if (arg.startsWith('--history=')) options.history = resolve(ROOT, arg.slice(10))
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  if (!options.corpora.length) options.corpora = DEFAULT_CORPORA
  return options
}

function numberOption(arg, fallback) {
  const value = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function printHelp() {
  console.log(`用法: node scripts/auto-pronunciation-loop.mjs [选项]

P3 自迭代闭环：自动发现「音素正确但被声学模型融合成另一个音节」的词，
用真实 WASM A/B 验证修复，再把结果与回归资产一起写回并跑全部门禁。

  --verify             快速门禁（不加载 WASM）：验证扫描器仍能召回所有已修复词、
                       覆盖表修复行未漂移。audit:all 使用此模式
  --measure            对 top N 风险词做真实 WASM A/B（无边界 vs 词尾静音边界）
  --apply              把 --measure 已验证的修复写入覆盖表/规则/P3 资产，
                       重建快照并跑 audit:all；失败自动回滚
  --corpus=<file>      语料，可重复；默认 scripts/out/ming.txt 或 sample.epub
  --limit=N            最多测量 N 个词（默认 20）
  --limit-sentences=N  只扫描前 N 句
  --radius=N           证据句上下文窗口半径（默认 10 字）
  --include-low        把低置信线索（非 ao+轻声词尾）也纳入 WASM 测量
  --words=<file>       外部候选词表 JSONL（word/phones/evidence），跳过自动扫描；
                       供 npm run iterate 把 boundary 族新候选喂进同一条 A/B 流程
  --out/--summary/--risks/--measured/--history=<file>  产物路径

典型用法：
  npm run pronunciation:auto                        # 静态巡检全书，列出风险
  npm run pronunciation:auto -- --measure           # 加 WASM A/B，产出已验证修复
  npm run pronunciation:auto -- --measure --apply   # 自动写回 + 门禁
  npm run pronunciation:auto -- --verify            # CI 门禁

安全约束：≥4 字词不自动生成；词内边界永不推荐；必须在 ≥2 条真实证据句上复验，
平均评分提升 ≥${MARGIN} 且任一上下文下降不超过 ${MARGIN}，每个上下文末音节
<${NORMAL_MAX_MS}ms、最弱音节 ≥${SWALLOW_MS}ms；写回前必须零意外变化。
复验冲突的词撤销写入并标记 needs-listening。`)
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

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function loadCorpusText(corpora) {
  for (const path of corpora) {
    try {
      const corpus = await loadCorpus(resolve(ROOT, path))
      if (corpus.text.trim()) return { path, text: corpus.text }
    } catch {
      // Fresh checkouts have no gitignored full-book corpus; fall through.
    }
  }
  return { path: 'builtin-verify-sentences', text: VERIFY_SENTENCES.join('\n') }
}

/** Expected overlay line for a recorded P3 fix. */
function expectedLine(fix) {
  const phones = (fix.phones ?? []).join(' ')
  return `${fix.word} ${phones}${fix.boundary === 'append' ? ` ${BOUNDARY_PHONE}` : ''}`
}

// ---------------------------------------------------------------- verify ----

async function verify(assets) {
  const fixes = await readJsonl(FIXES)
  const baseline = new Map(assets.effective)
  for (const fix of fixes) {
    baseline.delete(fix.word)
    for (const pinned of fix.pinWords ?? []) baseline.delete(pinned)
  }
  const baselineAssets = { ...assets, effective: baseline, maxLength: maxWordLength(baseline) }
  const sentences = [
    ...VERIFY_SENTENCES,
    ...fixes.flatMap((fix) => fix.evidence ?? []),
  ]
  const discovered = scanFusionRisks(sentences.join('\n'), baselineAssets)
  const checks = []

  if (fixes.length) checks.push({ name: 'P3 资产非空', ok: true })
  else checks.push({ name: 'P3 资产非空', ok: false, detail: 'fusionFixes.v1.jsonl 无记录' })

  const distinct = new Set(discovered.map((item) => item.word))
  checks.push({
    name: '扫描器可泛化发现同类词',
    ok: distinct.size >= 3,
    detail: `修复前基线召回 ${distinct.size} 个融合风险词：${[...distinct].slice(0, 6).join('、')}`,
  })

  for (const fix of fixes) {
    const found = discovered.find((item) => item.word === fix.word)
    checks.push({
      name: `${fix.word} 修复前可召回`,
      ok: Boolean(found) && found.blend === fix.blend,
      detail: found ? `blend=${found.blend}` : '未召回',
    })
    if (fix.status === 'needs-listening') {
      checks.push({
        name: `${fix.word} 未被自动写入`,
        ok: !assets.overlay.entries.has(fix.word),
        detail: fix.note ?? '多上下文复验冲突，等待人工复听',
      })
      continue
    }
    const reading = assets.overlay.entries.get(fix.word)
    const expected = expectedLine(fix)
    checks.push({
      name: `${fix.word} 覆盖行未漂移`,
      ok: reading !== undefined && `${fix.word} ${reading}` === expected,
      detail: reading ?? '覆盖表缺少该词',
    })
    for (const pinned of fix.pinWords ?? []) {
      checks.push({
        name: `${pinned} 整词钉住仍在`,
        ok: assets.overlay.entries.has(pinned),
        detail: assets.overlay.entries.get(pinned) ?? '覆盖表缺少该词',
      })
    }
  }

  const passed = checks.filter((check) => check.ok).length
  const report = {
    generatedAt: new Date().toISOString(),
    verify: true,
    discovered: distinct.size,
    checks,
    passed,
    total: checks.length,
  }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(resolve(ROOT, 'scripts/out/fusion-verify.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`P3 自迭代验收：${passed}/${checks.length} 通过 · 修复前基线召回 ${distinct.size} 个融合风险词`)
  for (const check of checks) {
    console.log(`  ${check.ok ? '通过' : '未通过'}  ${check.name}  ${check.detail ?? ''}`)
  }
  if (passed !== checks.length) process.exitCode = 1
  return report
}

// -------------------------------------------------------------- discovery ---

async function discover(assets, options) {
  const fixes = await readJsonl(FIXES)
  const fixedWords = new Set([
    ...fixes.map((fix) => fix.word),
    ...fixes.flatMap((fix) => fix.pinWords ?? []),
  ])
  if (options.words) {
    const supplied = await readJsonl(options.words)
    const risks = supplied
      .filter((item) => item.word && Array.isArray(item.phones) && item.phones.length)
      .map((item) => ({
        ...item,
        count: item.count ?? 1,
        evidence: item.evidence ?? [],
        confidence: item.confidence ?? 'high',
        neutralTail: item.neutralTail ?? false,
      }))
    const open = risks.filter((risk) => !fixedWords.has(risk.word)
      && !assets.overlay.entries.has(risk.word))
    await writeJsonl(options.risks, risks)
    return { corpus: { path: options.words, text: '' }, risks, open }
  }
  const corpus = await loadCorpusText(options.corpora)
  const risks = scanFusionRisks(corpus.text, assets, {
    limitSentences: options.limitSentences,
  })
  const open = risks.filter((risk) => !fixedWords.has(risk.word)
    && !assets.overlay.entries.has(risk.word))
  await writeJsonl(options.risks, risks)
  return { corpus, risks, open }
}

// ------------------------------------------------------------- measurement --

function inserted(tokens, index, token) {
  const result = [...tokens]
  result.splice(index, 0, token)
  return result
}

async function measure(synth, open, assets, options) {
  const results = []
  const pool = options.includeLow ? open : open.filter((risk) => risk.confidence !== 'low')
  const subset = pool.slice(0, options.limit)
  for (const [index, risk] of subset.entries()) {
    const trials = []
    for (const evidence of (risk.evidence ?? []).slice(0, 3)) {
      const window = contextWindow(evidence, risk.word, options.radius)
      const span = candidateSpan(window, risk.word, assets.effective, assets.maxLength)
      if (!span) continue
      const currentTokens = span.tokens
      const fixedTokens = inserted(currentTokens, span.start + risk.phones.length, BOUNDARY_PHONE)
      const current = summarizeContributions(
        synth.contributions(currentTokens, phoneIndices(currentTokens, span.start, 2)),
      )
      const fixed = summarizeContributions(
        synth.contributions(fixedTokens, phoneIndices(fixedTokens, span.start, 2)),
      )
      trials.push({
        window,
        baselineMs: current.values,
        fixedMs: fixed.values,
        score: current.score,
        fixedScore: fixed.score,
        delta: Math.round((fixed.score - current.score) * 10) / 10,
        max: fixed.max,
        min: fixed.min,
      })
    }
    const meanDelta = trials.length
      ? Math.round(trials.reduce((sum, trial) => sum + trial.delta, 0) / trials.length * 10) / 10
      : 0
    const eligible = risk.phones.length <= MAX_FIX_CHARS
    // Syllable durations vary with context (see audit-acoustics.mjs). A single
    // flattering sentence is not enough: 受到了 improved +136 on its first
    // evidence sentence but regressed -52 on the second. Require two contexts,
    // a positive mean and no meaningful regression anywhere before auto-edits.
    const stable = trials.length >= 2
      && trials.every((trial) => trial.delta >= -MARGIN)
      && trials.every((trial) => trial.max <= NORMAL_MAX_MS && trial.min >= SWALLOW_MS)
    const accepted = eligible && stable && meanDelta >= MARGIN
    const first = trials[0]
    results.push({
      ...risk,
      trials,
      window: first?.window ?? null,
      baselineMs: first?.baselineMs ?? [],
      fixedMs: first?.fixedMs ?? [],
      score: first?.score ?? 0,
      fixedScore: first?.fixedScore ?? 0,
      delta: meanDelta,
      accepted,
      reason: !eligible
        ? '≥4 字词不自动生成整词边界'
        : !trials.length
          ? '证据句窗口无法定位该词'
          : trials.length < 2
            ? '证据句不足 2 条，无法多上下文复验'
            : !stable
              ? '存在上下文显著变差或音节时长越界，标记 needs-listening'
              : accepted
                ? '多上下文 A/B 稳定改善，可自动应用'
                : 'A/B 平均提升未达阈值，标记 needs-listening',
      status: accepted ? 'verified' : 'needs-listening',
    })
    console.log(`  ${String(index + 1).padStart(2)}/${subset.length}  ${risk.word.padEnd(6)} → ${risk.blend.padEnd(5)} ${trials.length} 个上下文 Δ均值 ${meanDelta >= 0 ? '+' : ''}${meanDelta}（${trials.map((trial) => trial.delta).join('/') || '无'}） ${accepted ? '可应用' : '待复听'}`)
  }
  await writeJsonl(options.measured, results)
  return results
}

// -------------------------------------------------------------------- apply --

function ruleFor(fix, tag, index, external = false) {
  return {
    id: `rr-auto-${fix.word}-${index + 1}`,
    status: 'approved',
    class: 'boundary',
    word: fix.word,
    char: Array.from(fix.word)[0],
    offset: 0,
    phone: fix.phones[0],
    boundary: 'append',
    scope: 'word',
    source: external ? `self-iterate-${tag}` : `auto-loop-${tag}`,
    confidence: 'confirmed',
    evidence: (fix.evidence ?? []).slice(0, 1),
    note: external
      ? `全量自迭代边界 A/B：音素不变，仅词尾静音边界；${(fix.trials ?? []).length} 个真实上下文均值 Δ${fix.delta}，首例 ${(fix.baselineMs ?? []).join('/')}ms → ${(fix.fixedMs ?? []).join('/')}ms。`
      : `P3 自动巡检：${fix.fromPhone} + ${fix.toPhone} 可融合成 ${fix.blend}；${(fix.trials ?? []).length} 个真实上下文 WASM A/B 均值 Δ${fix.delta}，首例 ${(fix.baselineMs ?? []).join('/')}ms → ${(fix.fixedMs ?? []).join('/')}ms。`,
    createdAt: tag,
  }
}

async function apply(results, assets, options) {
  const accepted = results.filter((item) => item.accepted
    && !assets.overlay.entries.has(item.word)
    && Array.from(item.word).length <= MAX_FIX_CHARS)
  if (!accepted.length) {
    console.log('没有通过 A/B 的新修复，覆盖表保持不变。')
    return { applied: 0, gates: null }
  }

  await mkdir(dirname(CANDIDATES), { recursive: true })
  await writeFile(CANDIDATES, accepted.map(fixLine).join('\n') + '\n', 'utf8')
  const impact = run('scripts/audit-impact.mjs', [
    `--overlay=${CANDIDATES}`,
    ...options.corpora.map((path) => `--corpus=${path}`),
    '--out=scripts/out/fusion-impact.json',
    '--fail-on-unexpected',
  ])
  if (impact.status !== 0) {
    console.error(impact.stdout + impact.stderr)
    throw new Error('全书影响面 diff 未通过，拒绝写入')
  }

  const tag = new Date().toISOString().slice(0, 10)
  const backups = new Map()
  for (const path of [OVERLAY, RULES, FIXES, REGRESSION]) {
    backups.set(path, await readFile(path, 'utf8'))
  }
  const existingIds = new Set((await readJsonl(RULES)).map((rule) => rule.id))
  // fusionFixes.v1.jsonl records *syllable-fusion* cases whose pre-fix recall
  // is proven by the fusion scanner. Fixes coming from an external word list
  // are boundary-family problems and belong in readingRules only; writing them
  // into the fusion asset makes its --verify (correctly) reject them.
  const external = Boolean(options.words)
  const newRules = accepted
    .map((fix, index) => ruleFor(fix, tag, index, external))
    .filter((rule) => !existingIds.has(rule.id))
  const fixRecords = external ? [] : accepted.map((fix) => ({
    word: fix.word,
    phones: fix.phones,
    boundary: 'append',
    blend: fix.blend,
    fromPhone: fix.fromPhone,
    toPhone: fix.toPhone,
    pinWords: [],
    source: `auto-loop-${tag}`,
    status: 'confirmed',
    confidence: 'confirmed',
    evidence: fix.evidence,
    baselineMs: fix.baselineMs,
    fixedMs: fix.fixedMs,
    deltas: (fix.trials ?? []).map((trial) => trial.delta),
    meanDelta: fix.delta,
    createdAt: tag,
  }))

  try {
    const overlayBlock = [
      '',
      `# 自迭代产物 ${new Date().toISOString()}（WASM A/B + 零意外变化）`,
      external
        ? '# 词尾静音边界：音素正确但音节被吞并/压短，来自全量历史自迭代。'
        : '# 音节融合：前字声母 + 后字韵母拼成模型训练过的另一个音节。',
      ...accepted.map(fixLine),
      '',
    ].join('\n')
    await writeFile(OVERLAY, `${backups.get(OVERLAY).trimEnd()}\n${overlayBlock}`, 'utf8')
    await writeFile(RULES, `${backups.get(RULES).trimEnd()}\n${newRules.map((rule) => JSON.stringify(rule)).join('\n')}\n`, 'utf8')
    if (fixRecords.length) {
      await writeFile(FIXES, `${backups.get(FIXES).trimEnd()}\n${fixRecords.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
    }

    const snapshot = run('scripts/build-pronunciation-regression.mjs', [])
    if (snapshot.status !== 0) throw new Error(`快照重建失败：${snapshot.stdout}${snapshot.stderr}`)
    const gates = run('scripts/audit-all.mjs', [])
    if (gates.status !== 0) {
      console.error(gates.stdout + gates.stderr)
      throw new Error('读音门禁未通过，已回滚本轮写入')
    }
    console.log(`\n已写入 ${accepted.length} 行覆盖、${newRules.length} 条规则${fixRecords.length ? `、${fixRecords.length} 条 P3 回归记录` : ''}；门禁通过。`)
    return { applied: accepted.length, gates: 'passed' }
  } catch (error) {
    for (const [path, content] of backups) await writeFile(path, content, 'utf8')
    throw error
  }
}

// --------------------------------------------------------------------- main --

function renderSummary({ corpus, risks, open, measured, applied, options }) {
  const lines = [
    '# 山岚读音 P3 自迭代报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 语料：${corpus.path} · 融合风险 ${risks.length} 个词（高置信 ${open.filter((risk) => risk.confidence === 'high').length} 个）· 未修复 ${open.length} 个`,
    `- 真实 WASM A/B：${measured ? measured.length : '未运行'} 个词 · 可自动应用 ${measured?.filter((item) => item.accepted).length ?? 0} 个 · 本轮写入 ${applied ?? 0} 行`,
    '',
    '> 风险判定：最长匹配把前字截成单字，且「前字声母 + 后字韵母」是模型训练过的合法音节。',
    '> 高置信 = 后字韵母 `ao` 且后接轻声（了）；低置信只作为线索，默认不测量、不自动应用。',
    `> 自动应用门槛：≥2 个真实上下文平均提升 ≥${MARGIN} 且任一上下文下降不超过 ${MARGIN}，每个上下文末音节 <${NORMAL_MAX_MS}ms、最弱音节 ≥${SWALLOW_MS}ms、词长 ≤${MAX_FIX_CHARS}、全书影响面零意外变化。`,
    '',
    '| 词 | 融合成 | 置信 | 出现次数 | 状态 | 证据 |',
    '| --- | --- | --- | ---: | --- | --- |',
  ]
  for (const risk of open.slice(0, options.limit)) {
    const result = measured?.find((item) => item.word === risk.word)
    const status = result ? (result.accepted ? 'A/B 通过' : '待复听') : '待测量'
    lines.push(`| ${risk.word} | ${risk.blend} | ${risk.confidence} | ${risk.count} | ${status} | ${String(risk.evidence[0] ?? '').replace(/\|/g, '\\|').slice(0, 60)} |`)
  }
  lines.push('', '下一步：`npm run pronunciation:auto -- --measure --apply`，或人工复听待复听词。', '')
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()

  if (options.verify) {
    await verify(assets)
    return
  }

  const { corpus, risks, open } = await discover(assets, options)
  const high = open.filter((risk) => risk.confidence === 'high').length
  console.log(`语料 ${corpus.path} · 融合风险 ${risks.length} 个词（高置信 ${high} 个）· 未修复 ${open.length} 个`)
  for (const risk of open.slice(0, 10)) {
    console.log(`  ${risk.word.padEnd(6)} → ${risk.blend.padEnd(5)} ×${String(risk.count).padStart(3)}  ${risk.evidence[0] ?? ''}`)
  }

  let measured = null
  let applied = 0
  if (options.measure) {
    const synth = await createMatchaSynth()
    try {
      measured = await measure(synth, open, assets, options)
    } finally {
      synth.free()
    }
  } else if (options.apply) {
    measured = await readJsonl(options.measured)
    console.log(`复用已测量结果 ${measured.length} 条（${options.measured}）`)
  }
  if (options.apply) {
    const outcome = await apply(measured ?? [], assets, options)
    applied = outcome.applied
  }

  const report = {
    generatedAt: new Date().toISOString(),
    corpus: corpus.path,
    discovered: risks.length,
    highConfidence: high,
    open: open.length,
    measured: measured?.length ?? 0,
    accepted: measured?.filter((item) => item.accepted).length ?? 0,
    applied,
    unresolved: open.length - applied,
  }
  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(options.summary, renderSummary({ corpus, risks, open, measured, applied, options }), 'utf8')
  await mkdir(dirname(options.history), { recursive: true })
  await appendFile(options.history, `${JSON.stringify(report)}\n`, 'utf8')
  console.log(`\n报告 ${options.out}`)
  console.log(`摘要 ${options.summary}`)
  console.log(`趋势 ${options.history}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
