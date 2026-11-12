#!/usr/bin/env node
// Chinese polyphone baseline for the 山岚 (Matcha) voice.
//
// This is a MEASUREMENT, not a gate. It reports static phoneme agreement
// between the effective Matcha lexicon (base lexicon + curated overlay) and
// the labelled fixtures. It is NOT listening accuracy: the acoustic model can
// still swallow, fuse or mispronounce a syllable whose lexicon row is correct.
// Listening accuracy needs a real-WASM A/B with human judgement (npm run lab:ab),
// which cannot be automated here; see `listeningAccuracy` below.
//
// Every computation reuses scripts/lib/reading.mjs — the same functions behind
// npm run audit:golden — so the baseline and the gate can never disagree about
// what "the current reading" is.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  loadMatchaAssets,
  tokenizeSpans,
  phoneticPhones,
  ROOT,
} from './lib/reading.mjs'

const GOLDEN_PATH = join(ROOT, 'tests', 'fixtures', 'pronunciation-golden.jsonl')
const REGRESSION_PATH = join(
  ROOT,
  'tests',
  'fixtures',
  'pronunciation-regression.jsonl',
)
const DEFAULT_OUT = join(ROOT, 'scripts', 'out', 'baseline-polyphones.json')

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log(
    '用法: node scripts/baseline-polyphones.mjs [--out=<path>] [--json] [--with-audits] [--strict]\n' +
      '  --out=<path>     结果 JSON 路径（默认 scripts/out/baseline-polyphones.json）\n' +
      '  --json           只打印 JSON，不打印中文摘要\n' +
      '  --with-audits    额外跑 audit:golden / audit:coverage 做交叉校验（较慢）\n' +
      '  --strict         出现不一致或格式问题时退出码 1（默认只测量不判失败）',
  )
  process.exit(0)
}
const outArg = args.find((arg) => arg.startsWith('--out='))
const outPath = outArg ? resolve(ROOT, outArg.slice('--out='.length)) : DEFAULT_OUT
const jsonOnly = args.includes('--json')
const strict = args.includes('--strict')
const withAudits = args.includes('--with-audits')

function emptyStats(label, kind) {
  return {
    label,
    kind,
    cases: 0,
    points: 0,
    matched: 0,
    mismatched: 0,
    unresolved: 0,
    fallbackPoints: 0,
    accuracy: 0,
    fallbackRate: 0,
    families: 0,
    byFamily: {},
    mismatches: [],
    fallbacks: [],
  }
}

function finish(stats) {
  const scored = stats.matched + stats.mismatched
  stats.accuracy = scored ? Number((stats.matched / scored).toFixed(6)) : 0
  stats.fallbackRate = stats.points
    ? Number((stats.fallbackPoints / stats.points).toFixed(6))
    : 0
  stats.families = Object.keys(stats.byFamily).length
  return stats
}

function bumpFamily(stats, family) {
  if (!family) return
  stats.byFamily[family] = (stats.byFamily[family] ?? 0) + 1
}

async function measure(path, label, kind, assets) {
  const stats = emptyStats(label, kind)
  const source = await readFile(path, 'utf8')
  const spanCache = new Map()
  const seenIds = new Set()

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      stats.unresolved += 1
      continue
    }
    if (
      typeof record.id !== 'string' || !record.id ||
      seenIds.has(record.id) ||
      typeof record.text !== 'string' || !record.text.trim() ||
      !Array.isArray(record.readings) || record.readings.length === 0
    ) {
      stats.unresolved += 1
      continue
    }
    seenIds.add(record.id)
    stats.cases += 1
    const family = typeof record.family === 'string' && record.family !== 'other'
      ? record.family
      : null

    for (const reading of record.readings) {
      if (!Array.isArray(reading) || reading.length !== 3) {
        stats.unresolved += 1
        continue
      }
      const [char, occurrence, expected] = reading
      if (
        typeof char !== 'string' || !/^\p{Script=Han}$/u.test(char) ||
        !Number.isInteger(occurrence) || occurrence < 1 ||
        typeof expected !== 'string' || !/^[a-z]+[1-4]?$/.test(expected)
      ) {
        stats.unresolved += 1
        continue
      }
      stats.points += 1
      bumpFamily(stats, family)

      let spans = spanCache.get(record.text)
      if (!spans) {
        spans = tokenizeSpans(record.text, assets.effective, assets.maxLength)
        spanCache.set(record.text, spans)
      }
      const chars = Array.from(record.text)
      let seen = 0
      let target = -1
      for (let i = 0; i < chars.length; i += 1) {
        if (chars[i] !== char) continue
        seen += 1
        if (seen === occurrence) { target = i; break }
      }
      if (target < 0) {
        stats.unresolved += 1
        continue
      }
      const span = spans.find((item) => target >= item.start && target < item.end)
      const row = span ? assets.effective.get(span.word) : undefined
      if (!span || !row) {
        stats.unresolved += 1
        continue
      }
      const actual = phoneticPhones(row)[target - span.start]
      const fallback = Array.from(span.word).length === 1
      if (fallback) {
        stats.fallbackPoints += 1
        if (stats.fallbacks.length < 20) {
          stats.fallbacks.push({ id: record.id, char, word: span.word, expected, actual })
        }
      }
      if (actual === expected) {
        stats.matched += 1
      } else {
        stats.mismatched += 1
        if (stats.mismatches.length < 20) {
          stats.mismatches.push({ id: record.id, char, word: span.word, expected, actual })
        }
      }
    }
  }
  return finish(stats)
}

function runAudits(root) {
  const targets = [
    { name: 'audit:golden', args: ['scripts/audit-golden.mjs', '--all'] },
    { name: 'audit:coverage', args: ['scripts/audit-coverage.mjs', '--top=5'] },
  ]
  return targets.map(({ name, args: commandArgs }) => {
    const result = spawnSync(process.execPath, commandArgs, {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return {
      name,
      status: result.status,
      timedOut: result.error?.code === 'ETIMEDOUT',
      stdoutTail: (result.stdout ?? '').trim().split(/\r?\n/).slice(-8).join('\n'),
    }
  })
}

async function main() {
  const assets = await loadMatchaAssets()
  const golden = await measure(GOLDEN_PATH, '人工黄金集', 'human-labelled', assets)
  const regression = await measure(
    REGRESSION_PATH,
    '覆盖表一致性快照',
    'self-generated-snapshot',
    assets,
  )

  const combined = finish({
    ...emptyStats('合计', 'combined'),
    cases: golden.cases + regression.cases,
    points: golden.points + regression.points,
    matched: golden.matched + regression.matched,
    mismatched: golden.mismatched + regression.mismatched,
    unresolved: golden.unresolved + regression.unresolved,
    fallbackPoints: golden.fallbackPoints + regression.fallbackPoints,
    byFamily: (() => {
      const merged = {}
      for (const [family, count] of Object.entries(golden.byFamily)) {
        merged[family] = (merged[family] ?? 0) + count
      }
      for (const [family, count] of Object.entries(regression.byFamily)) {
        merged[family] = (merged[family] ?? 0) + count
      }
      return merged
    })(),
  })

  const report = {
    generatedAt: new Date().toISOString(),
    metric: 'static-lexicon-phoneme-agreement',
    packId: assets.pack.id,
    disclaimer:
      '本指标是「有效词典的最长匹配音素」与标注音素的一致率，不等于真实听感正确率。' +
      '声学模型吞音、音节融合、抢词造成的错读都可能在本指标为 100% 时仍然发生。',
    assets: {
      lexiconEntries: assets.lexicon.size,
      curatedOverlayEntries: assets.overlay.entries.size,
      effectiveEntries: assets.effective.size,
      maxWordLength: assets.maxLength,
    },
    // Deliberately null: the only true listening metric is a human A/B over
    // real WASM audio (npm run lab:ab / lab:diagnose). It cannot be automated.
    listeningAccuracy: null,
    listeningAccuracyNote:
      '需真实 WASM + 人工盲听；tests/browser/run-ab.mjs 起浏览器采集客观指标，' +
      'tts-ab.html 的 A/B 打分与 tts-diagnose.html 的对/错判定都由人点击，无法自动产出正确率。',
    golden,
    regression,
    combined,
    audits: withAudits ? runAudits(ROOT) : null,
  }

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('中文多音字读音基线（山岚 / 静态词典层）')
    console.log(`  音色包：${report.packId}`)
    console.log(
      `  词典：基础 ${report.assets.lexiconEntries} 条 + 人工覆盖 ${report.assets.curatedOverlayEntries} 条` +
        ` = 有效 ${report.assets.effectiveEntries} 条`,
    )
    for (const item of [golden, regression, combined]) {
      console.log(
        `  ${item.label}：用例 ${item.cases} 条 / 读音点 ${item.points} 个 / ` +
          `一致 ${item.matched} / 不一致 ${item.mismatched} / 静态一致率 ` +
          `${(item.accuracy * 100).toFixed(2)}% / 单字兜底 ${item.fallbackPoints} 个 ` +
          `(${(item.fallbackRate * 100).toFixed(2)}%) / 字族 ${item.families} 个`,
      )
    }
    console.log(`  真实听感正确率：未测量（需人工 A/B，见 listeningAccuracyNote）`)
    console.log(`  结果：${outPath}`)
  }

  if (strict && (combined.mismatched || combined.unresolved)) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
