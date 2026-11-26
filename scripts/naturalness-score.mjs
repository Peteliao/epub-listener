#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import {
  createNaturalnessScoreSheet,
  renderNaturalnessScoreHtml,
  validateNaturalnessScoreSheet,
} from './lib/naturalnessScore.mjs'

const DEFAULT_MANIFEST = 'scripts/out/naturalness-full/naturalness-manifest.json'

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST, rater: '', out: '', html: '', validate: '',
  }
  for (const arg of argv) {
    if (arg.startsWith('--manifest=')) options.manifest = arg.slice(11)
    else if (arg.startsWith('--rater=')) options.rater = arg.slice(8)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--html=')) options.html = arg.slice(7)
    else if (arg.startsWith('--validate=')) options.validate = arg.slice(11)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run naturalness:score -- --rater=姓名 [--manifest=清单] [--out=评分表] [--html=页面]')
      console.log('      npm run naturalness:score -- --validate=评分表.json [--manifest=清单]')
      process.exit(0)
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function readJson(path) {
  const file = resolve(ROOT, path)
  if (!existsSync(file)) throw new Error(`找不到 ${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function printResult(result) {
  for (const error of result.errors) console.error(`  ! ${error}`)
  if (result.summary) console.log(JSON.stringify(result.summary, null, 2))
  if (!result.ok || !result.complete) {
    console.error('评分表未完成或含非法值。')
    process.exitCode = 1
  } else {
    console.log('评分表完整且通过清单指纹校验。')
  }
}

function create(options) {
  if (!options.rater.trim()) throw new Error('--rater 必须指定独立评分者')
  const manifestPath = resolve(ROOT, options.manifest)
  const manifest = readJson(manifestPath)
  const manifestSha256 = sha256File(manifestPath)
  const safeRater = options.rater.trim().replace(/[^\p{L}\p{N}_-]/gu, '-')
  const out = options.out
    ? resolve(ROOT, options.out)
    : join(dirname(manifestPath), `naturalness-score-${safeRater}.json`)
  const html = options.html
    ? resolve(ROOT, options.html)
    : join(dirname(manifestPath), 'naturalness-score.html')
  if (existsSync(out)) {
    console.log(`评分表已存在，未覆盖：${out}`)
    printResult(validateNaturalnessScoreSheet(readJson(out), { manifest, manifestSha256 }))
    return
  }
  const sheet = createNaturalnessScoreSheet({ manifest, manifestSha256, rater: options.rater })
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(dirname(html), { recursive: true })
  writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  writeFileSync(html, renderNaturalnessScoreHtml({ manifest, sheet }), 'utf8')
  console.log(`评分表：${out}`)
  console.log(`试听评分页：${html}`)
  console.log('页面不重渲染音频；填写后导出 JSON，再用 --validate 校验。')
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.validate) {
    const manifestPath = resolve(ROOT, options.manifest)
    const manifest = readJson(manifestPath)
    printResult(validateNaturalnessScoreSheet(readJson(options.validate), {
      manifest,
      manifestSha256: sha256File(manifestPath),
    }))
  } else {
    create(options)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
