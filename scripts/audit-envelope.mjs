#!/usr/bin/env node
/**
 * Full-sentence envelope report for the 立刻-shaped class: a word whose phones
 * are correct but whose second syllable is only a weak burst, or is merged into
 * the first. This is ADVISORY: Chinese syllables can merge without a silent gap,
 * so use it to rank candidates and to compare before/after, not as a hard gate.
 *
 * Usage:
 *   node scripts/audit-envelope.mjs
 *   node scripts/audit-envelope.mjs --case=om-0007
 *   node scripts/audit-envelope.mjs --strict
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import { analyzeEnvelope, evaluateTarget, voicedBounds } from './lib/envelope.mjs'
import { analyzeF0 } from './lib/f0.mjs'
import {
  buildRuntimeLexicon, loadWordLists, prepareRuntimeTextWithOverlay, readAsset,
} from './lib/wordFamily.mjs'

const CASES = resolve(ROOT, 'src/core/tts/omissionCases.v1.jsonl')
const OUT = resolve(ROOT, 'scripts/out/envelope-report.json')
const SUMMARY = resolve(ROOT, 'scripts/out/envelope-report.md')

function parseArgs(argv) {
  const options = { caseId: 'om-0007', strict: false }
  for (const arg of argv) {
    if (arg === '--strict') options.strict = true
    else if (arg.startsWith('--case=')) options.caseId = arg.slice(7)
  }
  return options
}

function readCases() {
  return readFileSync(CASES, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line))
}

function pct(value) {
  return `${Math.round(value)}ms`
}

async function main(options) {
  const cases = readCases().filter((item) => item.id === options.caseId)
  if (!cases.length) {
    throw new Error(`找不到案例 ${options.caseId}`)
  }
  const lists = loadWordLists()
  const assets = await loadMatchaAssets()
  const runtime = buildRuntimeLexicon({
    lexiconText: assets.lexiconText,
    curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
    bookText: '',
  })
  const dir = dirname(OUT)
  mkdirSync(dir, { recursive: true })
  const lexiconPath = join(dir, 'envelope-lexicon.txt')
  writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

  const results = []
  const synth = await createMatchaSynth({ quiet: true, lexiconPath })
  try {
    for (const item of cases) {
      for (const sentence of item.sentences ?? []) {
        const index = sentence.indexOf(item.word)
        if (index < 0) continue
        const prefix = sentence.slice(0, index)
        const prefixAudio = synth.generateText(prepareRuntimeTextWithOverlay(prefix, assets, lists))
        const prefixEndMs = voicedBounds(prefixAudio.samples, prefixAudio.sampleRate).endMs
        const fullAudio = synth.generateText(prepareRuntimeTextWithOverlay(sentence, assets, lists))
        const envelope = analyzeEnvelope(fullAudio.samples, fullAudio.sampleRate)
        const target = evaluateTarget(envelope, prefixEndMs)
        const f0 = analyzeF0(fullAudio.samples, fullAudio.sampleRate)
        results.push({
          caseId: item.id,
          word: item.word,
          sentence,
          prefixEndMs,
          first: target.first,
          second: target.second,
          gapMs: target.gapMs,
          verdict: target.verdict,
          runs: envelope.runs,
          f0: {
            voicedRatio: f0.voicedRatio,
            jumpRatio: f0.jumpRatio,
            maxJump: f0.maxJump,
            octaveJumps: f0.octaveJumps,
            finalSlopeHzPerSec: f0.finalSlopeHzPerSec,
            meanF0: f0.meanF0,
          },
        })
      }
    }
  } finally {
    synth.free()
  }
  writeFileSync(OUT, `${JSON.stringify({ strict: options.strict, results }, null, 2)}\n`, 'utf8')
  const lines = [
    '# 山岚整句包络报告（advisory）',
    '',
    `- 案例：${cases.map((item) => item.id).join(', ')}`,
    '- 口径：目标词前缀结束时间之后的第一个强 burst 为第一音节，下一个 burst 为第二音节；第二音节 <60ms 或峰值 <第一音节 25% 记为 weak-second；没有第二个 burst 记为 merged。',
    '- 包络不能替代听感：粘连/弱爆破是排序线索，不是硬性判错。',
    '',
    '| 案例 | 词 | 前缀结束 | 第一音节 | 第二音节 | 间隔 | 判定 |',
    '| --- | --- | ---: | --- | --- | ---: | --- |',
  ]
  for (const item of results) {
    const first = item.first ? `${pct(item.first.ms)} / peak ${Math.round(item.first.peak * 100)}%` : '—'
    const second = item.second ? `${pct(item.second.ms)} / peak ${Math.round(item.second.peak * 100)}%` : '—'
    lines.push(`| ${item.caseId} | ${item.word} | ${pct(item.prefixEndMs)} | ${first} | ${second} | ${item.gapMs == null ? '—' : pct(item.gapMs)} | ${item.verdict} |`)
  }
  lines.push('', '## F0 连续性（advisory）', '',
    '| 案例 | 词 | voiced | 跳变帧 | 最大跳变 | 八度跳 | 句末斜率 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |')
  for (const item of results) {
    const f0 = item.f0
    lines.push(`| ${item.caseId} | ${item.word} | ${Math.round(f0.voicedRatio * 100)}% | ${Math.round(f0.jumpRatio * 100)}% | ${Math.round(f0.maxJump * 100)}% | ${f0.octaveJumps} | ${f0.finalSlopeHzPerSec == null ? '—' : `${f0.finalSlopeHzPerSec.toFixed(1)}Hz/s`} |`)
  }
  writeFileSync(SUMMARY, `${lines.join('\n')}\n`, 'utf8')
  console.log(`整句包络报告：${results.length} 条`)
  for (const item of results) {
    console.log(`  ${item.caseId} ${item.word} → ${item.verdict}`)
  }
  console.log(`报告 ${OUT}`)
  if (options.strict && results.some((item) => item.verdict !== 'ok')) {
    process.exitCode = 1
  }
}

main(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
