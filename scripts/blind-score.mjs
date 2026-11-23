#!/usr/bin/env node
/**
 * Create or validate the fixed-weight blind-listening score sheet.
 *
 *   npm run blind:render -- --tag=before
 *   npm run blind:render -- --tag=after
 *   npm run blind:score -- --before=before --after=after
 *   # fill the 1–5 scores in scripts/out/blind/scores-before-after.json
 *   npm run blind:score -- --validate=scripts/out/blind/scores-before-after.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import {
  BLIND_WEIGHTS, createScoreSheet, validateScoreSheet,
} from './lib/blindScore.mjs'

const ROOT_OUT = resolve(ROOT, 'scripts/out/blind')

function parseArgs(argv) {
  const options = { before: 'before', after: 'after', out: '', validate: '' }
  for (const arg of argv) {
    if (arg.startsWith('--before=')) options.before = arg.slice(9)
    else if (arg.startsWith('--after=')) options.after = arg.slice(8)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--validate=')) options.validate = arg.slice(11)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run blind:score -- [--before=tag --after=tag] [--out=file] [--validate=file]')
      process.exit(0)
    }
  }
  return options
}

function readManifest(tag) {
  const file = join(ROOT_OUT, tag, 'manifest.json')
  if (!existsSync(file)) throw new Error(`找不到 ${file}，先运行 npm run blind:render -- --tag=${tag}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function printValidation(result) {
  for (const item of result.items) {
    console.log(
      `  ${item.id} ${item.category} before=${item.beforeTotal ?? '—'} after=${item.afterTotal ?? '—'}`,
    )
  }
  if (result.overall) {
    console.log(`总分：before ${result.overall.before} → after ${result.overall.after}`)
  }
  if (result.errors.length) {
    for (const error of result.errors) console.error(`  ! ${error}`)
  }
}

function main(options) {
  if (options.validate) {
    const file = resolve(ROOT, options.validate)
    const sheet = JSON.parse(readFileSync(file, 'utf8'))
    const result = validateScoreSheet(sheet)
    printValidation(result)
    if (!result.ok || !result.complete) {
      console.error('评分表未完成或含非法值。')
      process.exitCode = 1
    }
    return
  }

  const before = readManifest(options.before)
  const after = readManifest(options.after)
  const afterById = new Map(after.items.map((item) => [item.id, item]))
  const items = before.items
    .filter((item) => afterById.has(item.id))
    .map((item) => ({ id: item.id, category: item.category }))
  if (!items.length) throw new Error('before/after 没有相同 id，无法配对')
  if (before.items.length !== items.length || after.items.length !== items.length) {
    console.warn(`只配对 ${items.length} 条（before ${before.items.length} / after ${after.items.length}）`)
  }

  const out = options.out
    ? resolve(ROOT, options.out)
    : join(ROOT_OUT, `scores-${options.before}-${options.after}.json`)
  if (existsSync(out)) {
    const existing = JSON.parse(readFileSync(out, 'utf8'))
    const result = validateScoreSheet(existing)
    printValidation(result)
    console.log(`评分表已存在，未覆盖：${out}`)
    return
  }
  const sheet = createScoreSheet({ before: options.before, after: options.after, items })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  console.log(`已生成评分表：${out}`)
  console.log(`权重：${Object.entries(BLIND_WEIGHTS).map(([key, value]) => `${key} ${Math.round(value * 100)}%`).join(' · ')}`)
}

try {
  main(parseArgs(process.argv.slice(2)))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
