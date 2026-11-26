#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { loadFrontendSpeech } from './lib/frontendSpeech.mjs'
import { probeNativeTokens } from './lib/nativeTokens.mjs'
import { currentProvenance } from './lib/provenance.mjs'
import {
  MATCHA_FRONTEND_CASES,
  MATCHA_FRONTEND_PROTOCOL,
  MATCHA_FRONTEND_VERSION,
  planMatchaFrontendCase,
  renderMatchaFrontendSummary,
  validateMatchaFrontendReport,
} from './lib/matchaFrontendParity.mjs'

const OUT = resolve(ROOT, 'scripts/out/matcha-frontend-parity.json')
const SUMMARY = resolve(ROOT, 'scripts/out/matcha-frontend-parity.md')

function parseArgs(argv) {
  const options = { native: false, out: OUT, summary: SUMMARY }
  for (const arg of argv) {
    if (arg === '--native') options.native = true
    else if (arg === '--verify') options.native = false
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

function printHelp() {
  console.log(`用法: node scripts/audit-matcha-frontend.mjs [选项]

验证中文 Matcha 默认 G2P 与原生前端的一致性。冻结样本来自真实 WASM 的
Sentence token 调试日志；--verify 不加载模型，--native 用当前模型重新探针。

  --verify               比较生产文本链、完整 token 与冻结原生快照
  --native               重新运行真实 WASM 原生 token 探针
  --out/--summary=<path> 结果与摘要路径

数字/拉丁片段必须整句回退且不得伪装成完整 token；未覆盖汉字必须硬失败。
token 一致不代表听感结论，所有候选仍须用户亲耳验收。`)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const [assets, frontend] = await Promise.all([loadMatchaAssets(), loadFrontendSpeech()])
  const rows = MATCHA_FRONTEND_CASES.map((item) => planMatchaFrontendCase(item, {
    assets,
    frontend,
    overlayText: assets.overlayText,
  }))
  if (options.native) {
    const tempDir = await mkdtemp(join(tmpdir(), 'shusheng-frontend-parity-'))
    const lexiconPath = join(tempDir, 'lexicon.txt')
    const lexiconText = [...assets.effective].map(([word, reading]) => `${word} ${reading}`).join('\n')
    await writeFile(lexiconPath, `${lexiconText}\n`, 'utf8')
    try {
      for (const row of rows) {
        if (row.decision === 'reject') continue
        row.nativeComparison = await probeNativeTokens(row.speechText, lexiconPath)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  const report = {
    protocol: MATCHA_FRONTEND_PROTOCOL,
    mode: options.native ? 'native-probe' : 'frozen-snapshot',
    generatedAt: new Date().toISOString(),
    provenance: currentProvenance(),
    frontendVersion: MATCHA_FRONTEND_VERSION,
    frontendSources: frontend.version,
    model: {
      lexiconSha256: sha256(assets.lexiconText),
      tokensSha256: sha256(assets.tokensText),
      overlaySha256: sha256(assets.overlayText),
    },
    policy: {
      default: MATCHA_FRONTEND_VERSION,
      nativeFallback: 'whole-request',
      uncoveredHan: 'hard-error',
      listeningAccuracy: null,
    },
    cases: rows,
    listeningAccuracy: null,
  }
  const errors = validateMatchaFrontendReport(report, { requireNative: options.native })
  await Promise.all([
    mkdir(dirname(options.out), { recursive: true }),
    mkdir(dirname(options.summary), { recursive: true }),
    writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(options.summary, renderMatchaFrontendSummary(report), 'utf8'),
  ])
  if (errors.length) throw new Error(`Matcha 前端一致性失败：\n${errors.join('\n')}`)
  const g2p = rows.filter((row) => row.decision === 'g2p').length
  const fallback = rows.filter((row) => row.decision === 'native-fallback').length
  const rejected = rows.filter((row) => row.decision === 'reject').length
  console.log(`Matcha 前端一致性通过：${rows.length} 条 · G2P ${g2p} · 整句回退 ${fallback} · 硬失败 ${rejected}`)
  console.log(`结果 ${options.out}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
