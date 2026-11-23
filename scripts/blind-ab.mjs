#!/usr/bin/env node
/**
 * Build a true double-blind A/B bundle from two blind:render outputs.
 *
 *   npm run blind:ab -- --before=before --after=after
 *
 * The bundle manifest contains only random codes. Version mapping is written to
 * a sibling .key.json file and must not be opened until scoring is finished.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import { buildBlindPlan, createBlindBundle } from './lib/blindAb.mjs'

function parseArgs(argv) {
  const options = {
    before: 'before',
    after: 'after',
    out: '',
    seed: 'shanlan-blind-v1',
  }
  for (const arg of argv) {
    if (arg.startsWith('--before=')) options.before = arg.slice(9)
    else if (arg.startsWith('--after=')) options.after = arg.slice(8)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--seed=')) options.seed = arg.slice(7)
  }
  if (!options.out) options.out = `scripts/out/blind/ab-${options.seed}`
  return options
}

function main(options) {
  const beforeDir = resolve(ROOT, 'scripts/out/blind', options.before)
  const afterDir = resolve(ROOT, 'scripts/out/blind', options.after)
  const outDir = resolve(ROOT, options.out)
  const before = JSON.parse(readFileSync(resolve(beforeDir, 'manifest.json'), 'utf8'))
  const plan = buildBlindPlan(before.items.map((item) => item.id), { seed: options.seed })
  const created = createBlindBundle({ beforeDir, afterDir, plan, outDir })
  console.log(`双盲评测包：${outDir}`)
  console.log(`评分清单（不含版本信息）：${created.manifestPath}`)
  console.log(`解盲密钥（评分完成前不要打开）：${created.keyPath}`)
}

Promise.resolve()
  .then(() => main(parseArgs(process.argv.slice(2))))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
