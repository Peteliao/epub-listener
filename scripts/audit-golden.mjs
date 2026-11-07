#!/usr/bin/env node
// Pronunciation gate for the 山岚 (matcha) voice.
//
// The hand-labelled golden set pins the readings a listener actually hears.
// `--all` also checks the layered overlay-consistency snapshot, which catches
// silent drift in the lexicon or the curated overlay. Both are evaluated with
// longest-match over the *effective* lexicon; a mismatch exits non-zero.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  loadMatchaAssets,
  phoneticPhones,
  tokenizeSpans,
  ROOT,
} from './lib/reading.mjs'

const GOLDEN_PATH = join(ROOT, 'tests', 'fixtures', 'pronunciation-golden.jsonl')
const REGRESSION_PATH = join(
  ROOT,
  'tests',
  'fixtures',
  'pronunciation-regression.jsonl',
)
const verbose = process.argv.includes('--verbose')
const all = process.argv.includes('--all')

const assets = await loadMatchaAssets()
const files = [
  { path: GOLDEN_PATH, label: '人工黄金集' },
  ...(all ? [{ path: REGRESSION_PATH, label: '覆盖表一致性快照' }] : []),
]

const issues = []
const mismatches = []
const fallbacks = []
const seenIds = new Set()
const families = new Set()
const perFile = []
let caseCount = 0
let pointCount = 0

// 1800+ reading points share only ~800 sentences; tokenising each sentence
// once (and passing the pre-computed max word length) keeps the gate fast.
const spanCache = new Map()
function resolve(text, char, occurrence) {
  let spans = spanCache.get(text)
  if (!spans) {
    spans = tokenizeSpans(text, assets.effective, assets.maxLength)
    spanCache.set(text, spans)
  }
  const chars = Array.from(text)
  let seen = 0
  let target = -1
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] !== char) continue
    seen += 1
    if (seen === occurrence) {
      target = i
      break
    }
  }
  if (target < 0) {
    throw new Error(`“${char}”第 ${occurrence} 次未出现在 ${JSON.stringify(text)}`)
  }
  const span = spans.find((item) => target >= item.start && target < item.end)
  if (!span) throw new Error(`无法定位 ${JSON.stringify(text)} 第 ${target + 1} 个字`)
  const reading = assets.effective.get(span.word)
  if (!reading) throw new Error(`词条 ${span.word} 没有读音`)
  return {
    phone: phoneticPhones(reading)[target - span.start],
    word: span.word,
    fallback: Array.from(span.word).length === 1,
  }
}

for (const { path, label } of files) {
  const source = await readFile(path, 'utf8')
  let fileCases = 0
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const where = `${label} 第 ${index + 1} 行`
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      issues.push(`${where}：不是合法 JSON`)
      continue
    }
    if (typeof record.id !== 'string' || !record.id) {
      issues.push(`${where}：缺少 id`)
      continue
    }
    if (seenIds.has(record.id)) {
      issues.push(`${where}：id 重复 ${record.id}`)
      continue
    }
    seenIds.add(record.id)
    if (typeof record.text !== 'string' || !record.text.trim()) {
      issues.push(`${record.id}：缺少 text`)
      continue
    }
    if (!Array.isArray(record.readings) || record.readings.length === 0) {
      issues.push(`${record.id}：readings 为空`)
      continue
    }
    if (typeof record.family === 'string' && record.family !== 'other') {
      families.add(record.family)
    }
    fileCases += 1
    for (const reading of record.readings) {
      if (!Array.isArray(reading) || reading.length !== 3) {
        issues.push(`${record.id}：readings 需要 [字, 序号, 音素]`)
        continue
      }
      const [char, occurrence, phone] = reading
      if (typeof char !== 'string' || !/^\p{Script=Han}$/u.test(char)) {
        issues.push(`${record.id}：${JSON.stringify(char)} 不是单个汉字`)
        continue
      }
      if (!Number.isInteger(occurrence) || occurrence < 1) {
        issues.push(`${record.id}：${char} 的序号需要正整数`)
        continue
      }
      if (typeof phone !== 'string' || !/^[a-z]+[1-4]?$/.test(phone)) {
        issues.push(`${record.id}：${JSON.stringify(phone)} 不是合法音素`)
        continue
      }
      if (!assets.tokens.has(phone)) {
        issues.push(`${record.id}：音素 ${phone} 不在 tokens.txt 中`)
        continue
      }
      pointCount += 1
      const item = { id: record.id, text: record.text, char, occurrence, phone }
      let resolved
      try {
        resolved = resolve(item.text, item.char, item.occurrence)
      } catch (error) {
        issues.push(`${item.id}：${error.message}`)
        continue
      }
      if (resolved.fallback) fallbacks.push({ ...item, word: resolved.word })
      if (resolved.phone === item.phone) {
        if (verbose) {
          console.log(`  ✓ ${item.id}  ${item.char}=${resolved.phone}（${resolved.word}）`)
        }
        continue
      }
      mismatches.push({ ...item, actual: resolved.phone, word: resolved.word })
    }
  }
  caseCount += fileCases
  perFile.push(`${label} ${fileCases} 条`)
}

console.log('山岚读音回归门禁')
console.log(`  ${perFile.join(' · ')}`)
console.log(`  用例：${caseCount} 条 / 读音点 ${pointCount} 个 / 字族 ${families.size} 个`)
console.log(`  单字兜底：${fallbacks.length} 个（越低越好；兜底说明多字词没有被词库或覆盖表命中）`)
for (const item of fallbacks.slice(0, 12)) {
  console.log(`    · ${item.id}  「${item.text}」  ${item.char}=${item.phone}`)
}
console.log(`  格式问题：${issues.length} 处`)
for (const issue of issues) console.log(`    - ${issue}`)
console.log(`  不一致：${mismatches.length} 处`)
for (const item of mismatches) {
  console.log(
    `    ✗ ${item.id}  「${item.text}」  ${item.char}(${item.occurrence})  ` +
      `期望=${item.phone} 实际=${item.actual}（词=${item.word}）`,
  )
}

if (issues.length || mismatches.length) {
  console.log('提示：若词典或覆盖表刚改动，请人工复核后运行 npm run regression:build 重建快照。')
  process.exitCode = 1
}
