#!/usr/bin/env node
// Dev-only / CI: one recursive self-iteration loop for every 山岚 fix so far.
//
//   history (all 4 assets) -> pre-fix replay -> family-wise discovery over a
//   whole book -> WASM A/B + impact diff + write-back -> next run replays the
//   enlarged history automatically.
//
// The five families mirror the attribution classes already used by the repo:
//   phone        多字/多音字读错（P0/P1）
//   boundary     音素对但音节被吞并/压短（P2）
//   fusion       相邻音节融合成另一个音节（P3）
//   frontend     短分句独立 utterance（worker 配置）
//   segmentation 最长匹配把整词截走
// Previously only `fusion` had an automated loop. This script gives all five a
// replay baseline and a whole-corpus discovery stage, and makes --verify a
// required gate so no historical fix can silently stop being discoverable.
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ROOT, loadMatchaAssets, maxWordLength } from './lib/reading.mjs'
import { loadCorpus } from './lib/corpus.mjs'
import {
  FAMILIES, PATHS, discoverBoundaryLeads, discoverOmissionLeads,
  discoverPhoneLeads, discoverSegmentationLeads, frontendConfigCheck,
  loadHistory, pinCases, replayAll,
} from './lib/iterationFamilies.mjs'
import { scanFusionRisks } from './lib/fusionRisk.mjs'

const OUT = resolve(ROOT, 'scripts/out/self-iteration.json')
const SUMMARY = resolve(ROOT, 'scripts/out/self-iteration.md')
const VERIFY_OUT = resolve(ROOT, 'scripts/out/self-iteration-verify.json')
const HISTORY = resolve(ROOT, 'scripts/out/self-iteration-history.jsonl')
const PHONE = resolve(ROOT, 'scripts/out/self-iteration-phone.jsonl')
const BOUNDARY = resolve(ROOT, 'scripts/out/self-iteration-boundary.jsonl')
const SEGMENTATION = resolve(ROOT, 'scripts/out/self-iteration-segmentation.jsonl')
const OMISSION = resolve(ROOT, 'scripts/out/self-iteration-omission.jsonl')
const CANDIDATES = resolve(ROOT, 'scripts/out/self-iteration-phone-candidates.txt')
const DEFAULT_CORPORA = ['scripts/out/ming.txt', 'public/sample.epub']

// Representative sentences from every historical feedback batch. Used by
// --verify on a fresh checkout, where the gitignored full-book corpus is absent.
const VERIFY_SENTENCES = [
  '千军易得，一将难求。',
  '而是率意而为，打到哪儿算哪儿。',
  '他向朱元璋建议，应立即度过长江。',
  '正因如此，一些会占便宜的有钱人长期地用盐不给钱。',
  '重新壮大自己，原已处于低潮的起义开始转入高潮。',
  '所有最先于朱元璋发生冲突的是张士诚。',
  '朱元璋对张士诚极为头疼，自己只是占了点地盘。',
  '看来上天要抛弃朱元璋了。',
  '天平被攻破了，应天就像一个赤裸的孩子。',
  '也就是在此前不久，一个人来到了洪都，他是受朱元璋委派来此地镇守的。',
]

function parseArgs(argv) {
  const options = {
    verify: false, measure: false, apply: false,
    corpora: [], limit: 20, limitSentences: 0, only: null,
    out: OUT, summary: SUMMARY, history: HISTORY,
  }
  for (const arg of argv) {
    if (arg === '--verify') options.verify = true
    else if (arg === '--measure') options.measure = true
    else if (arg === '--apply') options.apply = true
    else if (arg.startsWith('--corpus=')) options.corpora.push(arg.slice(9))
    else if (arg.startsWith('--limit=')) options.limit = numberOption(arg, 20)
    else if (arg.startsWith('--limit-sentences=')) options.limitSentences = numberOption(arg, 0)
    else if (arg.startsWith('--only=')) options.only = arg.slice(7)
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
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
  console.log(`用法: node scripts/self-iterate.mjs [选项]

把「之前发现并修复的全部山岚问题」纳入一个递归闭环：每次运行都把五类资产
（归因规则 / 声学例外 / 融合修复 / 漏读案例 / 黄金集）连同整张人工覆盖表，逐条在修复前
词典上重放，再按六个归因族把历史修复扩散到全书所有同类位置。

  --verify             快速 CI 门禁（无 WASM）：全量历史重放 + 五族发现能力自检
                       + 文本前端配置未漂移
  --measure            对 boundary 族新候选跑真实 WASM 多上下文 A/B
  --apply              应用已验证的 boundary 修复（写回覆盖表/规则/P3 资产、
                       重建快照、跑 audit:all；失败自动回滚）
  --corpus=<file>      语料，可重复；默认 scripts/out/ming.txt 或 sample.epub
  --limit=N            boundary 测量上限（默认 20）
  --limit-sentences=N  只扫描前 N 句
  --only=<族>          只运行指定族的发现（phone/boundary/segmentation/fusion/omission）
  --out/--summary/--history=<file>  产物路径

产物：
  scripts/out/self-iteration-phone.jsonl        音素族批量候选（需一次语义确认）
  scripts/out/self-iteration-boundary.jsonl     声学边界待测量词表
  scripts/out/self-iteration-segmentation.jsonl 最长匹配截走线索
  scripts/out/self-iteration-phone-candidates.txt  可直接做影响面 diff 的覆盖行

唯一保留人工判断的是 phone 族：同一个字有多个正确读音，音素对错没有客观
代理指标。但引擎会主动列出全书同类位置并自动跑影响面 diff，一次确认一批，
不需要先听出来再逐条反馈。其余四族均可自动验证并写回。`)
}

async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return []
      try { return [JSON.parse(trimmed)] } catch { return [] }
    })
  } catch { return [] }
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' })
}

async function loadCorpusText(corpora, limitSentences) {
  for (const path of corpora) {
    try {
      const corpus = await loadCorpus(resolve(ROOT, path))
      if (corpus.text.trim()) {
        const text = limitSentences > 0
          ? corpus.text.split(/(?<=[。！？!?；;…\n])/u).slice(0, limitSentences).join('\n')
          : corpus.text
        return { path, text }
      }
    } catch {
      // Fresh checkout: fall through to the built-in feedback sentences.
    }
  }
  return { path: 'builtin-feedback-sentences', text: VERIFY_SENTENCES.join('\n') }
}

async function loadSelfCheckText() {
  try {
    const corpus = await loadCorpus(resolve(ROOT, 'scripts/out/ming.txt'))
    const sentences = corpus.text.split(/(?<=[。！？!?；;…\n])/u).slice(0, 600)
    if (sentences.length >= 100) return { text: sentences.join('\n'), rich: true }
  } catch {
    // The full-book corpus is gitignored; CI uses the built-in sentences.
  }
  return { text: VERIFY_SENTENCES.join('\n'), rich: false }
}

// ---------------------------------------------------------------- verify ----

async function verify(assets) {
  const history = await loadHistory(ROOT)
  const cases = [...history, ...pinCases(assets)]
  const replays = replayAll(cases, assets)
  const failed = replays.filter((item) => !item.result.ok)
  const reproducible = replays.filter((item) => item.result.reproducible).length
  const byFamily = Object.fromEntries(
    FAMILIES.map((family) => [family, cases.filter((item) => item.family === family).length]),
  )

  const [workerText, aiModelText] = await Promise.all([
    readFile(resolve(ROOT, PATHS.worker), 'utf8').catch(() => ''),
    readFile(resolve(ROOT, PATHS.aiModel), 'utf8').catch(() => ''),
  ])
  const config = frontendConfigCheck(workerText, aiModelText)

  // A pre-fix lexicon proves each family still *finds* the class of problem,
  // not merely that the current rows are present. Use a real corpus slice when
  // available; on a fresh checkout fall back to the built-in feedback sentences
  // and only require the discovery stage to produce some recall at all.
  const selfCheck = await loadSelfCheckText()
  const before = new Map(assets.lexicon)
  const baseline = { ...assets, effective: before, maxLength: maxWordLength(before) }
  // A true pre-fix baseline has no curated overlay at all; otherwise the
  // omission discoverer skips the very word it is supposed to rediscover.
  // Keep this local: the other families' discoverers still need the real
  // overlay to enumerate curated words for their own replay checks.
  const omissionBaseline = {
    ...baseline,
    overlay: { ...assets.overlay, entries: new Map() },
  }
  const phone = discoverPhoneLeads(selfCheck.text, baseline, replays, { limit: 20 })
  const boundary = discoverBoundaryLeads(selfCheck.text, baseline, { limit: 20 })
  const segmentation = discoverSegmentationLeads(selfCheck.text, baseline, {
    limit: 5, ignoreCuratedLonger: false,
  })
  const fusion = scanFusionRisks(selfCheck.text, baseline)
  const omissionCases = cases.filter((item) => item.family === 'omission')
  // 20 keeps the same depth as the other families; at 10 the 地X compounds that
  // the 地盘 case now generalises pushed the confirmed words out of the list.
  const omission = discoverOmissionLeads(selfCheck.text, omissionBaseline, omissionCases, { limit: 20 })
  const totalRecall = phone.length + boundary.length + segmentation.length
    + fusion.length + omission.length

  const checks = [
    { name: `历史案例覆盖全部 ${FAMILIES.length} 个归因族`, ok: FAMILIES.every((f) => byFamily[f] > 0), detail: FAMILIES.map((f) => `${f} ${byFamily[f]}`).join(' · ') },
    { name: '修复前基线全量重放', ok: failed.length === 0, detail: `${cases.length} 条 / 失败 ${failed.length} 条` },
    { name: '问题可在修复前复现', ok: reproducible > 0, detail: `${reproducible} 条非预防性修复` },
    { name: '文本前端配置未漂移', ok: config.every((item) => item.ok), detail: config.filter((item) => !item.ok).map((item) => item.name).join('、') || 'min_words_in_sentence / matcha overlay 均在' },
    ...[
      { name: 'phone 族全书扩散可用', count: phone.length },
      { name: 'boundary 族新候选可用', count: boundary.length },
      { name: 'segmentation 族截走检测可用', count: segmentation.length },
    ].map((item) => ({
      name: item.name,
      ok: !selfCheck.rich || item.count > 0,
      detail: `修复前基线召回 ${item.count} 条${selfCheck.rich ? '' : '（内置验证语料）'}`,
    })),
    { name: 'fusion 族可召回已修复词', ok: fusion.some((item) => item.word === '来到了' && item.blend === 'lao'), detail: `修复前基线召回 ${fusion.length} 条融合风险词` },
    {
      name: 'omission 族可在修复前基线召回同类词',
      // Any confirmed omission word counts: pinning the check to one word made it
      // fail as soon as a different family member (地盘) outranked it.
      ok: omission.some((item) =>
        omissionCases.some((c) => c.status === 'confirmed' && c.word === item.word)),
      detail: `修复前基线召回 ${omission.length} 条漏读同形词（确认词 ${[...new Set(omissionCases.filter((c) => c.status === 'confirmed').map((c) => c.word))].join('/')}）`,
    },
    { name: '发现器基线总召回', ok: totalRecall > 0, detail: `共 ${totalRecall} 条` },
  ]
  const passed = checks.filter((item) => item.ok).length
  const report = {
    generatedAt: new Date().toISOString(),
    verify: true,
    cases: cases.length,
    byFamily,
    reproducible,
    failures: failed.map((item) => ({ id: item.id, ...item.result })),
    checks,
    passed,
    total: checks.length,
  }
  await mkdir(dirname(VERIFY_OUT), { recursive: true })
  await writeFile(VERIFY_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`全量历史基线重放：${passed}/${checks.length} 通过 · ${cases.length} 条历史案例 · ${reproducible} 条可复现`)
  for (const check of checks) {
    console.log(`  ${check.ok ? '通过' : '未通过'}  ${check.name}  ${check.detail ?? ''}`)
  }
  if (passed !== checks.length) process.exitCode = 1
  return report
}

// -------------------------------------------------------------- discovery ---

function familyEnabled(options, family) {
  return !options.only || options.only === family
}

function renderSummary({ corpus, replays, byFamily, phone, boundary, segmentation, fusion, omission = [], impact, applied, options }) {
  const lines = [
    '# 山岚读音递归自迭代报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 语料：${corpus.path}`,
    `- 历史案例 ${replays.length} 条 · 修复前可复现 ${replays.filter((item) => item.result.reproducible).length} 条 · 重放失败 ${replays.filter((item) => !item.result.ok).length} 条`,
    `- 归因族：${FAMILIES.map((f) => `${f} ${byFamily[f] ?? 0}`).join(' · ')}`,
    `- 本轮新发现：phone ${phone.length} · boundary ${boundary.length} · segmentation ${segmentation.length} · fusion 高置信 ${fusion} · omission ${omission.length} · 自动写入 ${applied ?? 0}`,
    '',
    '> 每次写回都会进入 readingRules / fusionFixes 资产，下一次 --verify 自动把它们',
    '> 加进重放基线；因此历史只增不减，不需要人工维护案例清单。',
    '> phone 族候选已自动跑全书影响面 diff；音素对错需语义判断，一次确认一批。',
    '',
    '## phone 族（历史错读音扩散到全书）',
    '',
    '| 词 | 字 | 当前 | 建议 | 出现 | 学自 | 候选覆盖行 |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
  ]
  for (const item of phone.slice(0, options.limit)) {
    lines.push(`| ${item.word} | ${item.char} | ${item.current} | ${item.expected} | ${item.count} | ${item.learnedFrom} | \`${item.suggestion}\` |`)
  }
  if (!phone.length) lines.push('| — | — | — | — | 0 | — | — |')
  lines.push('', '## boundary 族（未登录二字词，交给 WASM A/B）', '',
    '| 词 | 音素 | 出现 | 证据 |', '| --- | --- | ---: | --- |')
  for (const item of boundary.slice(0, options.limit)) {
    lines.push(`| ${item.word} | ${item.phones.join(' ')} | ${item.count} | ${String(item.evidence[0] ?? '').replace(/\|/g, '\\|').slice(0, 50)} |`)
  }
  if (!boundary.length) lines.push('| — | — | 0 | — |')
  lines.push('', '## segmentation 族（覆盖词被最长匹配截走）', '',
    '| 覆盖词 | 实际命中 | 证据 |', '| --- | --- | --- |')
  for (const item of segmentation.slice(0, options.limit)) {
    lines.push(`| ${item.word} | ${item.actual} | ${String(item.evidence[0] ?? '').replace(/\|/g, '\\|').slice(0, 60)} |`)
  }
  if (!segmentation.length) lines.push('| — | — | — |')
  lines.push('', '## omission 族（漏读同形词，完整原句 + 全边界位置 A/B）', '',
    '| 词 | 字 | 音素 | 学自 | 出现 | 完整原句 |', '| --- | --- | --- | --- | ---: | --- |')
  for (const item of omission.slice(0, options.limit)) {
    lines.push(`| ${item.word} | ${item.char} | ${item.phone} | ${item.learnedFrom} | ${item.count} | ${String(item.sentences[0] ?? '').replace(/\|/g, '\\|').slice(0, 60)} |`)
  }
  if (!omission.length) lines.push('| — | — | — | — | 0 | — |')
  lines.push('', `phone 候选影响面：${impact ?? '未运行'}`, '',
    '下一步：`npm run iterate -- --measure --apply` 自动验证并写回 boundary 修复；',
    '`scripts/out/self-iteration-phone-candidates.txt` 供批量确认音素候选。', '')
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()
  if (options.verify) {
    await verify(assets)
    return
  }

  const history = await loadHistory(ROOT)
  const cases = [...history, ...pinCases(assets)]
  const replays = replayAll(cases, assets)
  const byFamily = Object.fromEntries(
    FAMILIES.map((family) => [family, cases.filter((item) => item.family === family).length]),
  )
  const corpus = await loadCorpusText(options.corpora, options.limitSentences)

  const phone = familyEnabled(options, 'phone')
    ? discoverPhoneLeads(corpus.text, assets, replays, { limit: options.limit })
    : []
  const boundary = familyEnabled(options, 'boundary')
    ? discoverBoundaryLeads(corpus.text, assets, { limit: options.limit })
    : []
  const segmentation = familyEnabled(options, 'segmentation')
    ? discoverSegmentationLeads(corpus.text, assets, { limit: options.limit })
    : []
  const fusionRisks = familyEnabled(options, 'fusion')
    ? scanFusionRisks(corpus.text, assets).filter((item) => item.confidence === 'high'
      && !assets.overlay.entries.has(item.word))
    : []
  const omission = familyEnabled(options, 'omission')
    ? discoverOmissionLeads(
      corpus.text, assets,
      cases.filter((item) => item.family === 'omission' && item.status === 'confirmed'),
      { limit: options.limit },
    )
    : []

  await Promise.all([
    writeJsonl(PHONE, phone),
    writeJsonl(BOUNDARY, boundary),
    writeJsonl(SEGMENTATION, segmentation),
    writeJsonl(OMISSION, omission),
  ])
  await mkdir(dirname(CANDIDATES), { recursive: true })
  await writeFile(CANDIDATES,
    `# phone 族批量候选，由历史修复自动扩散；合并前请一次确认这一批\n${phone.map((item) => item.suggestion).join('\n')}\n`,
    'utf8')

  let impact = 'phone 候选为空，无需检查'
  if (phone.length) {
    const result = run('scripts/audit-impact.mjs', [
      `--overlay=${CANDIDATES}`,
      ...options.corpora.map((path) => `--corpus=${path}`),
      '--out=scripts/out/self-iteration-phone-impact.json',
      '--fail-on-unexpected',
    ])
    impact = result.status === 0 ? '零意外变化' : '存在意外变化，禁止合并'
    await writeFile(CANDIDATES,
      `# phone 族批量候选，由历史修复自动扩散；全书影响面：${impact}\n`
      + `# 音素对错需语义判断：${impact.includes('禁止') ? '禁止合并，请先剔除误报' : '合并前请一次确认这一批'}\n`
      + `${phone.map((item) => item.suggestion).join('\n')}\n`,
      'utf8')
  }

  let applied = 0
  if (options.measure) {
    const result = run('scripts/auto-pronunciation-loop.mjs', [
      `--words=${BOUNDARY}`, '--measure', `--limit=${options.limit}`,
    ])
    console.log(result.stdout.trim())
    if (result.status !== 0) throw new Error(`boundary A/B 失败：${result.stderr}`)
  }
  if (options.apply) {
    // External boundary fixes are recorded as attribution rules, not as
    // fusion cases; count the newly added rules for this iteration.
    const rulesPath = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
    const beforeCount = (await readJsonl(rulesPath)).length
    const result = run('scripts/auto-pronunciation-loop.mjs', [
      `--words=${BOUNDARY}`, '--apply',
    ])
    console.log(result.stdout.trim())
    if (result.status !== 0) throw new Error(`自动写回失败：${result.stderr}`)
    applied = (await readJsonl(rulesPath)).length - beforeCount
  }

  // P4: generalise every confirmed omission to all same-shape words in the
  // book, A/B every completion-boundary position on whole sentences, write back
  // verified repairs AND append them as new cases. The next --verify run then
  // replays a strictly larger history: that is the recursion.
  let omissionApplied = 0
  if ((options.measure || options.apply) && omission.length) {
    const casesPath = resolve(ROOT, PATHS.omissions)
    const before = (await readFile(casesPath, 'utf8')).split(/\r?\n/)
      .filter((line) => line.trim().startsWith('{')).length
    const args = [`--words=${OMISSION}`, `--limit=${options.limit}`]
    if (options.measure) args.push('--measure')
    if (options.apply) args.push('--apply')
    const result = run('scripts/audit-omission.mjs', args)
    console.log(result.stdout.trim())
    if (result.status !== 0) {
      console.error(result.stderr)
      throw new Error('omission 族多上下文 A/B / 写回失败')
    }
    const after = (await readFile(casesPath, 'utf8')).split(/\r?\n/)
      .filter((line) => line.trim().startsWith('{')).length
    omissionApplied = after - before
  }

  const report = {
    generatedAt: new Date().toISOString(),
    corpus: corpus.path,
    cases: cases.length,
    byFamily,
    reproducible: replays.filter((item) => item.result.reproducible).length,
    replayFailures: replays.filter((item) => !item.result.ok).length,
    discovered: {
      phone: phone.length, boundary: boundary.length,
      segmentation: segmentation.length, fusion: fusionRisks.length,
      omission: omission.length,
    },
    impact,
    applied,
    omissionApplied,
  }
  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(options.summary, renderSummary({
    corpus, replays, byFamily, phone, boundary, segmentation,
    fusion: fusionRisks.length, omission, impact, applied, options,
  }), 'utf8')
  await mkdir(dirname(options.history), { recursive: true })
  await appendFile(options.history, `${JSON.stringify(report)}\n`, 'utf8')

  console.log(`\n历史 ${cases.length} 条 / 重放失败 ${report.replayFailures} 条 / 可复现 ${report.reproducible} 条`)
  console.log(`新发现 phone ${phone.length} · boundary ${boundary.length} · segmentation ${segmentation.length} · fusion 高置信 ${fusionRisks.length} · omission ${omission.length}（新增基线 ${omissionApplied}）`)
  console.log(`报告 ${options.out}`)
  console.log(`摘要 ${options.summary}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
