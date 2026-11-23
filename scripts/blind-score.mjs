#!/usr/bin/env node
/**
 * Create or validate fixed-weight listening score sheets.
 *
 * True double-blind flow:
 *   npm run blind:ab -- --before=before --after=after
 *   npm run blind:score -- --bundle=scripts/out/blind/ab-seed --rater=rater-1
 *   npm run blind:score -- --validate=scripts/out/blind/ab-seed.scores-rater-1.json
 *   npm run blind:score -- --reveal=scripts/out/blind/ab-seed.key.json \
 *       --sheets=scripts/out/blind/ab-seed.scores-rater-1.json
 *
 * Legacy before/after sheets remain supported for older renders.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import {
  BLIND_WEIGHTS,
  createBlindScoreSheet,
  createScoreSheet,
  validateBlindScoreSheet,
  validateScoreSheet,
} from './lib/blindScore.mjs'
import { revealScores } from './lib/blindAb.mjs'

const ROOT_OUT = resolve(ROOT, 'scripts/out/blind')

function parseArgs(argv) {
  const options = {
    before: 'before', after: 'after', out: '', validate: '',
    bundle: '', rater: 'rater-1', reveal: '', sheets: '',
  }
  for (const arg of argv) {
    if (arg.startsWith('--before=')) options.before = arg.slice(9)
    else if (arg.startsWith('--after=')) options.after = arg.slice(8)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--validate=')) options.validate = arg.slice(11)
    else if (arg.startsWith('--bundle=')) options.bundle = arg.slice(9)
    else if (arg.startsWith('--rater=')) options.rater = arg.slice(8)
    else if (arg.startsWith('--reveal=')) options.reveal = arg.slice(9)
    else if (arg.startsWith('--sheets=')) options.sheets = arg.slice(9)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run blind:score -- [--bundle=dir --rater=name] [--validate=file] [--reveal=key --sheets=a.json,b.json]')
      process.exit(0)
    }
  }
  return options
}

function readJson(path) {
  const file = path.startsWith('/') || /^[A-Za-z]:/.test(path)
    ? path
    : resolve(ROOT, path)
  if (!existsSync(file)) throw new Error(`找不到 ${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function printLegacy(result) {
  for (const item of result.items) {
    console.log(
      `  ${item.id} ${item.category} before=${item.beforeTotal ?? '—'} after=${item.afterTotal ?? '—'}`,
    )
  }
  if (result.overall) {
    console.log(`总分：before ${result.overall.before} → after ${result.overall.after}`)
  }
}

function printBlind(result) {
  // Never print before/after here: the scorer must not learn the mapping.
  for (const item of result.items) {
    const totals = item.codes.map((code) => `${code}=${item.totals[code] ?? '—'}`).join(' ')
    console.log(`  ${item.id} ${item.category} ${totals}`)
  }
}

function validate(options) {
  const sheet = readJson(options.validate)
  const blind = sheet.version === 2 || (Array.isArray(sheet.items) && sheet.items[0]?.codes)
  const result = blind ? validateBlindScoreSheet(sheet) : validateScoreSheet(sheet)
  if (blind) printBlind(result)
  else printLegacy(result)
  if (result.errors.length) {
    for (const error of result.errors) console.error(`  ! ${error}`)
  }
  if (!result.ok || !result.complete) {
    console.error('评分表未完成或含非法值。')
    process.exitCode = 1
  }
}

function reveal(options) {
  if (!options.sheets) throw new Error('--reveal 需要 --sheets=file1.json,file2.json')
  const keyPath = resolve(ROOT, options.reveal)
  const key = JSON.parse(readFileSync(keyPath, 'utf8'))
  const bundleDir = keyPath.replace(/\.key\.json$/, '')
  const bundle = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'))
  const sheets = options.sheets.split(',').map((file) => readJson(file.trim()))
  const result = revealScores(sheets, key, bundle)
  const out = join(dirname(resolve(ROOT, options.reveal)), 'reveal.json')
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log('解盲完成（仅限评分结束后）：')
  for (const rater of result.raters) {
    console.log(`  ${rater.rater}: ${rater.items.length} 条`)
  }
  if (result.agreement !== null) {
    console.log(`  评分者一致性：${Math.round(result.agreement * 100)}%`)
  }
  console.log(`报告 ${out}`)
}

function create(options) {
  if (options.bundle) {
    const bundleDir = resolve(ROOT, options.bundle)
    const bundle = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'))
    const out = options.out
      ? resolve(ROOT, options.out)
      : `${bundleDir}.scores-${options.rater}.json`
    if (existsSync(out)) {
      validate({ ...options, validate: out })
      console.log(`评分表已存在，未覆盖：${out}`)
      return
    }
    const sheet = createBlindScoreSheet({ bundle, rater: options.rater })
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
    console.log(`双盲评分表：${out}`)
    console.log('表里只有随机代号；评分结束后再用 --reveal 解盲。')
    return
  }

  const before = readJson(join(ROOT_OUT, options.before, 'manifest.json'))
  const after = readJson(join(ROOT_OUT, options.after, 'manifest.json'))
  const afterById = new Map(after.items.map((item) => [item.id, item]))
  const items = before.items
    .filter((item) => afterById.has(item.id))
    .map((item) => ({ id: item.id, category: item.category }))
  if (!items.length) throw new Error('before/after 没有相同 id，无法配对')
  const out = options.out
    ? resolve(ROOT, options.out)
    : join(ROOT_OUT, `scores-${options.before}-${options.after}.json`)
  if (existsSync(out)) {
    validate({ ...options, validate: out })
    console.log(`评分表已存在，未覆盖：${out}`)
    return
  }
  const sheet = createScoreSheet({ before: options.before, after: options.after, items })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  console.log(`已生成旧式评分表：${out}`)
  console.log(`权重：${Object.entries(BLIND_WEIGHTS).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(' · ')}`)
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.reveal) reveal(options)
  else if (options.validate) validate(options)
  else create(options)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
