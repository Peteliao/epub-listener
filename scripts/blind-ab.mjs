#!/usr/bin/env node
/**
 * Build a true double-blind A/B bundle from two blind:render outputs.
 *
 *   npm run blind:ab -- --before=before --after=after
 *
 * Each round gets a new crypto-random seed and experiment id. The bundle
 * manifest contains only codes and playback order; the seed and version mapping
 * live in a sibling .key.json and must not be opened until scoring is finished.
 * `--seed=` exists only for reproducing an incident, never for a real round.
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
    seed: '',
  }
  for (const arg of argv) {
    if (arg.startsWith('--before=')) options.before = arg.slice(9)
    else if (arg.startsWith('--after=')) options.after = arg.slice(8)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--seed=')) options.seed = arg.slice(7)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run blind:ab -- [--before=tag] [--after=tag] [--out=dir] [--seed=仅复现故障]')
      process.exit(0)
    }
  }
  return options
}

function main(options) {
  const beforeDir = resolve(ROOT, 'scripts/out/blind', options.before)
  const afterDir = resolve(ROOT, 'scripts/out/blind', options.after)
  const before = JSON.parse(readFileSync(resolve(beforeDir, 'manifest.json'), 'utf8'))
  const plan = buildBlindPlan(before.items.map((item) => item.id), {
    ...(options.seed ? { seed: options.seed } : {}),
  })
  const outDir = resolve(ROOT, options.out || `scripts/out/blind/${plan.experimentId}`)
  const created = createBlindBundle({ beforeDir, afterDir, plan, outDir })
  console.log(`实验 ID：${plan.experimentId}`)
  if (options.seed) {
    console.log('提示：--seed 仅供复现故障，不要把种子或 .key.json 放进评分目录。')
  }
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
