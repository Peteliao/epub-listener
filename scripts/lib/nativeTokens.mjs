import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from './reading.mjs'

const RESULT_PREFIX = 'ACOUSTIC_NATIVE_RESULT='

export function parseNativeTokenLog(text) {
  const sentences = []
  for (const match of String(text).matchAll(/Sentence \d+ tokens: \[([^\]]*)\]/g)) {
    const tokens = match[1].split(/,\s+/).filter(Boolean)
      .map((entry) => entry.replace(/\(\d+\)$/, ''))
    sentences.push(tokens)
  }
  return { captured: sentences.length > 0, sentences, tokens: sentences.flat() }
}

/** WASM writes debug logs directly to process streams, so isolation is required. */
export function probeNativeTokens(text, lexiconPath, { timeout = 180_000 } = {}) {
  const result = spawnSync(process.execPath, [
    join(ROOT, 'scripts/spike/acoustic-native-tokens.mjs'),
    `--lexicon=${lexiconPath}`,
    `--text=${text}`,
  ], { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const line = output.split(/\r?\n/).find((item) => item.startsWith(RESULT_PREFIX))
  if (result.status !== 0 || !line) {
    return {
      captured: false, sentences: [], tokens: [],
      reason: `原生 token 子进程失败：${result.error?.message ?? output.slice(-1200)}`,
    }
  }
  return {
    ...parseNativeTokenLog(output),
    durationMs: JSON.parse(line.slice(RESULT_PREFIX.length)).durationMs,
  }
}
