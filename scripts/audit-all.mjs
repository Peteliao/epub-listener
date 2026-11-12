#!/usr/bin/env node
// Dev-only / CI: run every pronunciation gate in order and write a single
// machine-readable result for pronunciation-health.mjs to consume.
//
// Gates are designed to work on a fresh checkout: none of them requires the
// gitignored full-book corpus. The acoustic smoke test is optional by default
// because it loads a 130MB WASM model; use --strict to make it mandatory.
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'

const RESULTS = resolve(ROOT, 'scripts/out/gate-results.json')
const CANDIDATES = resolve(ROOT, 'scripts/out/overlay-candidates.txt')

function parseArgs(argv) {
  const options = { strict: false, out: RESULTS, only: null }
  for (const arg of argv) {
    if (arg === '--strict') options.strict = true
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--only=')) options.only = arg.slice(7)
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function printHelp() {
  console.log(`用法: node scripts/audit-all.mjs [选项]

按顺序运行山岚读音门禁，并把结果写入 scripts/out/gate-results.json 供
pronunciation-health.mjs 汇总。新鲜 checkout 也能运行（不依赖全书语料）。

  --strict    声学冒烟等可选门禁失败时也返回非零码
  --only=名称 只运行名称包含该字符串的门禁（调试用）
  --out=路径  结果文件

门禁：黄金集与快照 / 覆盖表格式 / 规则编译 / P0 扫描召回 / 反馈闭环 /
P3 自迭代召回 / 反馈原句可听性回归 / 词族逐词可听性 / 历史基线全量重放 /
影响面 diff（仅当有候选覆盖行）/ 声学冒烟 / 健康度。

新书接入（全在开发期本机执行，书籍内容不上传）：
  npm run scan:risks -- <新书.epub>          生成全书风险清单并排序
  npm run rules:compile                       把确认过的归因编成候选行
  npm run audit:impact -- --overlay=<候选> --corpus=<新书.epub> --fail-on-unexpected
  npm run audit:acoustics -- --corpus=<新书.epub> --limit=20
  npm run health                              查看沉淀量与收敛趋势
新书语料可直接传 .txt/.md/.epub/.fb2/.jsonl，无需改动仓库配置。`)
}

function tail(text, lines = 6) {
  return String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-lines).join(' | ')
}

async function hasCandidates() {
  try {
    return (await readFile(CANDIDATES, 'utf8')).split(/\r?\n/)
      .some((line) => line.trim() && !line.trim().startsWith('#'))
  } catch {
    return false
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const gates = [
    {
      name: '黄金集与一致性快照',
      args: ['scripts/audit-golden.mjs', '--all'],
      required: true,
    },
    {
      name: '覆盖表格式与音素',
      args: ['scripts/audit-polyphones.mjs', '--overlay-only'],
      required: true,
    },
    {
      name: '规则编译与冲突检测',
      args: ['scripts/compile-overlay.mjs'],
      required: true,
    },
    {
      name: '编译产物漂移（白名单/外部词表）',
      args: ['scripts/verify-compiled-assets.mjs'],
      required: true,
    },
    {
      name: 'P0 风险扫描召回',
      // --verify uses a 9-sentence sample; never let it overwrite the full-book
      // risk inventory that pronunciation-health.mjs reads.
      args: [
        'scripts/scan-pronunciation-risks.mjs', '--verify',
        '--out=scripts/out/gate-scan-risks.jsonl',
        '--summary=scripts/out/gate-scan-risks.md',
      ],
      required: true,
    },
    {
      name: '反馈闭环',
      args: [
        'scripts/feedback-loop.mjs', '--verify',
        '--out=scripts/out/gate-feedback-loop.json',
        '--rule-candidates=scripts/out/gate-feedback-rules.jsonl',
        '--exception-candidates=scripts/out/gate-feedback-exceptions.jsonl',
      ],
      required: true,
    },
    {
      name: 'P3 自迭代召回',
      // Fast, WASM-free: proves the fusion scanner still rediscovers every
      // recorded fix and that the overlay rows have not drifted.
      args: ['scripts/auto-pronunciation-loop.mjs', '--verify'],
      required: true,
    },
    {
      name: '反馈原句可听性回归',
      // The gate that was missing when 占便宜 passed every check three times:
      // rebuild the FULL feedback sentence, then prove with real WASM that
      // every syllable is voiced and the recorded repair has not been reverted.
      args: [
        'scripts/audit-omission.mjs', '--verify',
        '--out=scripts/out/omission-verify.json',
        '--summary=scripts/out/omission-verify.md',
      ],
      required: true,
    },
    {
      name: '词族逐词可听性',
      // Rebuild the runtime dictionary / prepared text / token stream for the
      // 便宜 and 地盘 word families, then verify every syllable with real WASM.
      // This is the gate the first five rounds lacked: the families were never
      // in the curated table, and every phone-only gate stayed green.
      args: [
        'scripts/audit-word-family.mjs', '--verify',
        '--out=scripts/out/word-family-verify.json',
        '--summary=scripts/out/word-family-verify.md',
      ],
      required: true,
    },
    {
      name: '历史基线全量重放',
      // Every historical listening fix, replayed against its pre-fix lexicon;
      // verifies all six attribution families can still rediscover their class.
      args: ['scripts/self-iterate.mjs', '--verify'],
      required: true,
    },
    {
      name: '全书影响面 diff',
      args: ['scripts/audit-impact.mjs', `--overlay=${CANDIDATES}`, '--fail-on-unexpected'],
      required: true,
      dynamic: true,
    },
    {
      name: '声学冒烟',
      // One-case smoke test must not replace the 7-case acoustic report.
      args: [
        'scripts/audit-acoustics.mjs', '--verify', '--limit=1', '--no-audio',
        '--out=scripts/out/gate-acoustics.json',
        '--summary=scripts/out/gate-acoustics.md',
        '--exceptions=scripts/out/gate-acoustics.jsonl',
      ],
      required: false,
    },
    {
      name: '健康度汇总',
      args: ['scripts/pronunciation-health.mjs', '--no-history'],
      required: true,
    },
  ]

  const results = []
  let failed = 0
  let optionalFailed = 0
  const flush = async (extra = {}) => {
    await mkdir(dirname(options.out), { recursive: true })
    await writeFile(options.out, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      strict: options.strict,
      gates: results,
      summary: {
        total: results.length,
        passed: results.filter((item) => item.status === 0 && !item.skipped).length,
        skipped: results.filter((item) => item.skipped).length,
      },
      ...extra,
    }, null, 2)}\n`, 'utf8')
  }

  for (const gate of gates) {
    if (options.only && !gate.name.includes(options.only)) continue
    // `compile-overlay` rewrites the candidate file, so decide *after* it ran.
    if (gate.dynamic && !(await hasCandidates())) {
      const reason = '规则编译无候选覆盖行，影响面无需检查'
      results.push({ name: gate.name, status: 0, skipped: true, reason, durationMs: 0 })
      console.log(`  跳过  ${gate.name.padEnd(20)} ${reason}`)
      continue
    }
    // Health reads gate-results.json; write the gates completed so far first.
    if (gate.name === '健康度汇总') await flush()
    const started = Date.now()
    const result = spawnSync(process.execPath, gate.args, { cwd: ROOT, encoding: 'utf8' })
    const durationMs = Date.now() - started
    const status = result.status ?? 1
    const ok = status === 0
    results.push({
      name: gate.name,
      status,
      skipped: false,
      required: gate.required,
      durationMs,
      output: ok ? '' : tail(result.stdout) + ' | ' + tail(result.stderr, 4),
    })
    console.log(`  ${ok ? '通过' : '失败'}  ${gate.name.padEnd(20)} ${String(durationMs).padStart(6)}ms${ok ? '' : `  ${results[results.length - 1].output}`}`)
    if (!ok) {
      if (gate.required) failed += 1
      else optionalFailed += 1
    }
  }

  await mkdir(dirname(options.out), { recursive: true })
  const payload = {
    generatedAt: new Date().toISOString(),
    strict: options.strict,
    gates: results,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.status === 0 && !item.skipped).length,
      failed: failed + optionalFailed,
      requiredFailed: failed,
      optionalFailed,
      skipped: results.filter((item) => item.skipped).length,
    },
  }
  await writeFile(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`\n门禁 ${payload.summary.passed}/${payload.summary.total - payload.summary.skipped} 通过 · 必需失败 ${failed} · 可选失败 ${optionalFailed} · 跳过 ${payload.summary.skipped}`)
  console.log(`结果 ${options.out}`)
  if (failed > 0 || (options.strict && optionalFailed > 0)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
