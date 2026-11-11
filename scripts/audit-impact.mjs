#!/usr/bin/env node
// Dev-only gate: report every position whose reading changes after a candidate
// overlay edit. Anything outside the words the edit intends to change is an
// unexpected regression (usually longest-match segmentation drift).
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { loadCorpus } from './lib/corpus.mjs'
import { applyOverlay, compareReadingChanges, summarizeImpact } from './lib/impact.mjs'

const DEFAULT_OUT = resolve(ROOT, 'scripts/out/pronunciation-impact.json')
const DEFAULT_CORPORA = ['scripts/out/ming.txt', 'public/sample.epub']

function parseArgs(argv) {
  const options = {
    overlay: null,
    corpora: [],
    out: DEFAULT_OUT,
    limit: 0,
    failOnUnexpected: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--overlay=')) options.overlay = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--corpus=')) options.corpora.push(arg.slice(9))
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--limit-sentences=')) options.limit = numberOption(arg, 0)
    else if (arg === '--fail-on-unexpected') options.failOnUnexpected = true
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
  console.log(`用法: node scripts/audit-impact.mjs --overlay=<候选覆盖表> [选项]

比较「当前有效词典」与「应用候选行之后」的逐字读音，报出所有变化位置：
  --overlay=<file>        必需，候选覆盖表文本（词 音素，可含 # 注释）
  --corpus=<file>         语料，可重复；默认 scripts/out/ming.txt 或 sample.epub
  --out=<file>            JSON 报告（默认 scripts/out/pronunciation-impact.json）
  --limit-sentences=N     只扫描前 N 句
  --fail-on-unexpected    意外变化 > 0 时以非零码退出，用于 CI 门禁

「目标变化」= 变化位置落在候选词上；其它都是意外变化，通常是新增词改变了
最长匹配切分。合并前要求意外变化为 0。`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.overlay) {
    printHelp()
    process.exitCode = 1
    return
  }

  const assets = await loadMatchaAssets()
  const overlayText = await readFile(options.overlay, 'utf8')
  const { after, changedWords } = applyOverlay(assets.effective, overlayText)
  if (!changedWords.size) {
    console.log('候选文件里没有可解析的覆盖行。')
    process.exitCode = 1
    return
  }

  const corpora = []
  for (const path of options.corpora) {
    try {
      const corpus = await loadCorpus(resolve(ROOT, path))
      if (corpus.text.trim()) corpora.push(corpus)
      if (options.defaultCorpora) break
    } catch (error) {
      console.warn(`  跳过语料 ${path}: ${error.message}`)
    }
  }
  if (!corpora.length) throw new Error('没有可读语料')

  const report = { corpora: [], changes: [] }
  for (const corpus of corpora) {
    const result = compareReadingChanges({
      text: corpus.text,
      before: assets.effective,
      after,
      changedWords,
      limitSentences: options.limit,
    })
    const summary = summarizeImpact(result)
    report.corpora.push({ path: corpus.path, ...summary })
    report.changes.push(...summary.samples)
    console.log(`${corpus.path}: ${summary.sentences} 句 / 读音变化 ${summary.total} 处（目标 ${summary.intended} / 意外 ${summary.unexpected}）`)
  }
  report.changedWords = [...changedWords]
  report.total = {
    intended: report.corpora.reduce((sum, item) => sum + item.intended, 0),
    unexpected: report.corpora.reduce((sum, item) => sum + item.unexpected, 0),
  }
  console.log(`\n候选词 ${changedWords.size} 个：${[...changedWords].slice(0, 12).join('、')}${changedWords.size > 12 ? '…' : ''}`)
  const first = report.corpora[0]
  if (first?.byWord.length) {
    console.log('\n变化最多的词：')
    for (const item of first.byWord.slice(0, 8)) {
      console.log(`  ${String(item.count).padStart(5)}  ${item.word}`)
    }
  }
  const unexpected = report.changes.filter((item) => !item.intentional).slice(0, 8)
  if (unexpected.length) {
    console.log('\n意外变化样例：')
    for (const item of unexpected) {
      console.log(`  ${item.char} ${item.before} → ${item.after}（${item.beforeWord} → ${item.afterWord}）${item.context}`)
    }
  }

  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\n报告 ${options.out}`)
  console.log(report.total.unexpected === 0
    ? '结论：零意外变化，可复核后合并。'
    : `结论：发现 ${report.total.unexpected} 处意外变化，禁止合并。`)
  if (options.failOnUnexpected && report.total.unexpected > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
