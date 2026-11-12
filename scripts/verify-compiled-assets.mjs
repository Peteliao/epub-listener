#!/usr/bin/env node
// Single audit gate for all build-time generated pronunciation assets.
// Both compilers support --verify (regenerate and byte-compare), so a source
// change without recompilation fails the full audit instead of silently
// shipping a stale whitelist / phrase table to the runtime.
import { spawnSync } from 'node:child_process'
import { ROOT } from './lib/reading.mjs'

const checks = [
  { name: 'approvedOverrides.v1.ts', args: ['scripts/compile-approved-overrides.mjs', '--verify'] },
  { name: 'phraseReadings.v1.txt', args: ['scripts/compile-external-phrase.mjs', '--verify'] },
]

let failed = 0
for (const check of checks) {
  const result = spawnSync(process.execPath, check.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const ok = result.status === 0
  if (!ok) failed += 1
  console.log(`${ok ? '通过' : '失败'}  ${check.name}`)
  const output = (result.stdout ?? '').trim() || (result.stderr ?? '').trim()
  if (!ok && output) console.log(`    ${output.split(/\r?\n/).slice(-3).join(' / ')}`)
}

console.log(failed
  ? `编译产物校验失败 ${failed}/${checks.length} 项。`
  : `编译产物校验通过 ${checks.length}/${checks.length} 项。`)
if (failed) process.exitCode = 1
