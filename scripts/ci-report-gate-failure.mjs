#!/usr/bin/env node
// CI helper. `npm run audit:all` keeps going after a gate fails and writes every
// gate's status to scripts/out/gate-results.json. Job logs need authentication,
// but check-run annotations are public, so surface the failed gates as
// `::error::` commands: a red deploy becomes diagnosable from the public API.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), 'scripts/out/gate-results.json')

function sanitize(text, limit = 6000) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/::/g, ':')
    .replace(/%/g, '%25')
    .slice(0, limit)
}

try {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const failed = (report.gates ?? []).filter((gate) => gate.status !== 0 && !gate.skipped)
  if (!failed.length) {
    console.log('::error::audit:all 失败，但 gate-results.json 里没有失败门禁（可能是脚本启动崩溃）')
  }
  for (const gate of failed) {
    const title = sanitize(gate.name, 120).replace(/,/g, '，')
    console.log(`::error file=scripts/audit-all.mjs,title=${title}::${sanitize(gate.output)}`)
  }
} catch (error) {
  console.log(`::error::无法读取 gate-results.json：${sanitize(error instanceof Error ? error.message : error)}`)
}
