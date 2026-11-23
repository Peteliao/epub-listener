#!/usr/bin/env node
/**
 * Advisory audit against the user-provided ByteDance/zh-wiki derived corpus.
 *
 * The derived data lives in scripts/data/bytedance-zh-wiki and is text-only:
 * it never patches the runtime lexicon and never changes generated audio.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import {
  auditG2pContext, loadG2pContext, loadProsodyBoundaries, summarizeProsody,
} from './lib/externalData.mjs'

const DATA = resolve(ROOT, 'scripts/data/bytedance-zh-wiki')
const OUT = resolve(ROOT, 'scripts/out/external-g2p-report.json')
const SUMMARY = resolve(ROOT, 'scripts/out/external-g2p-report.md')

async function main() {
  const assets = await loadMatchaAssets()
  const examples = loadG2pContext(resolve(DATA, 'g2pContext.v1.jsonl'))
  const boundaries = loadProsodyBoundaries(resolve(DATA, 'prosodyBoundary.v1.jsonl'))
  const g2p = auditG2pContext(examples, assets, { limit: 80 })
  const prosody = summarizeProsody(boundaries)
  const report = { generatedAt: new Date().toISOString(), g2p, prosody }
  mkdirSync(resolve(ROOT, 'scripts/out'), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const byChar = new Map()
  for (const item of g2p.mismatches) {
    const key = `${item.char}: ${item.expected} → ${item.actual}`
    byChar.set(key, (byChar.get(key) ?? 0) + 1)
  }
  const lines = [
    '# 外部语料对照（advisory）',
    '',
    '- 来源：用户提供的 ByteDance API / zh-wiki 生成资料（精简派生，仅开发审计）。',
    '- 这不是错误清单：模型输出与本项目人工覆盖不一致时应人工复听，不自动改表。',
    '',
    `G2P 上下文：${g2p.matches}/${g2p.total} 与当前词典一致，抽样不一致 ${g2p.mismatches.length} 条。`,
    `韵律边界：${prosody.total} 条样本，#3 ${prosody.level3} / #4 ${prosody.level4}，连接词边界 ${prosody.connectives}。`,
    '',
  ]
  for (const [key, count] of [...byChar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`- ${key} ×${count}`)
  }
  writeFileSync(SUMMARY, `${lines.join('\n')}\n`, 'utf8')
  console.log(`外部语料对照：g2p ${g2p.matches}/${g2p.total}；韵律边界 ${prosody.total}`)
  console.log(`报告 ${SUMMARY}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
