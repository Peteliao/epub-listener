#!/usr/bin/env node
// Audit base-lexicon single-character rows whose toneless phone was never in
// the Baker model's training whitelist. Advisory only: no overlay is read or
// written, and finding a risk is not itself a failed audit.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import { loadCorpus } from './lib/corpus.mjs'
import {
  UNTRAINED_NEUTRALS_SCHEMA,
  findUntrainedNeutrals,
  selectCorpusHits,
  serializeNeutralReport,
  renderNeutralSummary,
} from './lib/untrainedNeutrals.mjs'

const OUT = resolve(ROOT, 'scripts/out/untrained-neutrals-report.json')
const SUMMARY = resolve(ROOT, 'scripts/out/untrained-neutrals-report.md')
const WHITELIST = resolve(ROOT, 'src/core/tts/trainedNeutrals.v1.txt')

function parseArgs(argv) {
  const options = {
    corpus: null, out: OUT, summary: SUMMARY, top: Infinity, verify: false, strict: false,
  }
  const positionals = []
  for (const arg of argv) {
    if (arg === '--verify') options.verify = true
    else if (arg === '--strict') options.strict = true
    else if (arg.startsWith('--corpus=') || arg.startsWith('--book=')) {
      options.corpus = arg.slice(arg.indexOf('=') + 1)
    } else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--top=')) {
      const value = Number(arg.slice(6))
      if (!Number.isInteger(value) || value < 1) throw new Error('--top 必须是正整数')
      options.top = value
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg.startsWith('--')) {
      throw new Error(`未知选项：${arg}`)
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length > 1 || (positionals.length && options.corpus)) {
    throw new Error('语料/书路径只能指定一次（位置参数或 --corpus=/--book=）')
  }
  options.corpus = positionals[0] ?? options.corpus
  return options
}

function printHelp() {
  console.log(`用法: node scripts/audit-untrained-neutrals.mjs [语料或书路径] [选项]

审计基础词典「单字 + 无调音素」且不在 trainedNeutrals.v1.txt 的风险字。
不读取人工覆盖表或本书覆盖表；只输出待复听清单，不自动改音。

  --corpus=<file>        仅列语料中实际命中（支持 .txt/.md/.epub/.fb2/.jsonl）
  --book=<file>           --corpus 的别名
  --out=<file>           JSON 报告（默认 scripts/out/untrained-neutrals-report.json）
  --summary=<file>       Markdown 风险字表
  --top=N               控制台只显示前 N 行；报告始终保留全量
  --verify              重复计算并逐字节比较，校验排序/过滤/命中不变量
  --strict              发现风险字时退出码 1（默认咨询审计退出码 0）

无语料参数时列全量。--verify 失败或输入/输出错误均非零退出。`)
}

async function loadBaseSources() {
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'public/models/manifest.json'), 'utf8'))
  const pack = manifest.packs?.find((item) => item.id === 'matcha-icefall-zh-baker')
  const lexiconName = pack?.model?.config?.lexicon
  const lexiconFile = pack?.files?.find((item) => item.name === lexiconName)
  if (!lexiconFile?.url) throw new Error('manifest 中找不到 matcha-icefall-zh-baker 基础词典')
  const lexiconPath = join(ROOT, 'public', lexiconFile.url.replace(/^\/+/, ''))
  const [lexiconText, whitelistText] = await Promise.all([
    readFile(lexiconPath, 'utf8'),
    readFile(WHITELIST, 'utf8'),
  ])
  return { lexiconPath, lexiconText, whitelistText }
}

async function buildReport(sources, corpusPath) {
  const fullRisks = findUntrainedNeutrals(sources.lexiconText, sources.whitelistText)
  let corpus = null
  let rows = fullRisks
  if (corpusPath) {
    const loaded = await loadCorpus(resolve(ROOT, corpusPath))
    corpus = { path: loaded.path, chars: loaded.chars, sections: loaded.sections }
    rows = selectCorpusHits(fullRisks, loaded.text)
  }
  const canonicalRows = JSON.stringify(rows)
  return {
    schemaVersion: UNTRAINED_NEUTRALS_SCHEMA,
    source: {
      lexicon: sources.lexiconPath,
      trainedNeutrals: WHITELIST,
    },
    corpus,
    rows,
    totals: {
      baseRiskChars: fullRisks.length,
      listedChars: rows.length,
      hits: rows.reduce((sum, row) => sum + (row.count ?? 0), 0),
    },
    sha256: createHash('sha256').update(canonicalRows).digest('hex'),
  }
}

function verifyReport(report, again, corpusText, sources) {
  const failures = []
  const first = serializeNeutralReport(report)
  const second = serializeNeutralReport(again)
  if (first !== second) failures.push('重复计算结果不一致')
  const chars = report.rows.map((row) => row.char)
  if (new Set(chars).size !== chars.length) failures.push('风险字重复')
  if (chars.some((char, index) => index > 0 && chars[index - 1] > char)) {
    failures.push('风险字未按码点稳定排序')
  }
  if (report.totals.listedChars !== report.rows.length) failures.push('风险字统计不一致')
  if (corpusText != null) {
    if (report.rows.some((row) => !row.count || !corpusText.includes(row.char))) {
      failures.push('语料模式包含未实际命中的字')
    }
    const expected = selectCorpusHits(
      findUntrainedNeutrals(sources.lexiconText, sources.whitelistText), corpusText,
    )
    if (JSON.stringify(expected) !== JSON.stringify(report.rows)) failures.push('语料过滤结果不一致')
  }
  if (failures.length) throw new Error(failures.join('；'))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  const sources = await loadBaseSources()
  let report = await buildReport(sources, options.corpus)
  if (options.verify) {
    const again = await buildReport(sources, options.corpus)
    const corpusText = options.corpus ? (await loadCorpus(resolve(ROOT, options.corpus))).text : null
    verifyReport(report, again, corpusText, sources)
    console.log(`确定性验收通过：${report.rows.length} 个风险字 / sha256 ${report.sha256.slice(0, 12)}`)
  }

  await mkdir(dirname(options.out), { recursive: true })
  await mkdir(dirname(options.summary), { recursive: true })
  await writeFile(options.out, serializeNeutralReport(report), 'utf8')
  await writeFile(options.summary, renderNeutralSummary(report), 'utf8')

  console.log(`基础词典未训练轻声：全量 ${report.totals.baseRiskChars} · 列出 ${report.rows.length}${report.corpus ? ` · 实际命中 ${report.totals.hits}` : ''}`)
  for (const row of report.rows.slice(0, options.top)) {
    console.log(`  ${row.char}  ${row.phone}  lexicon:${row.lexiconLine}${row.count ? `  ${row.count}×  ${row.firstContext}` : ''}`)
  }
  if (report.rows.length > options.top) console.log(`  …另有 ${report.rows.length - options.top} 个`)
  console.log(`报告 ${options.out}`)
  console.log(`字表 ${options.summary}`)
  if (options.strict && report.rows.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
