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
import { pinyin } from 'pinyin-pro'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import {
  analyzeEnvelope, evaluateTarget, severityFor, voicedBounds,
} from './lib/envelope.mjs'
import {
  alignPrefix, decisionFor, joinPcmParts, partStartsMs,
} from './lib/alignment.mjs'
import { analyzeF0, analyzeTargetF0 } from './lib/f0.mjs'
import {
  buildRuntimeLexicon, loadWordLists, prepareRuntimeTextWithOverlay, readAsset,
  utteranceParts, WORD_BOUNDARY,
} from './lib/wordFamily.mjs'
import { currentProvenance } from './lib/provenance.mjs'

const CASES = resolve(ROOT, 'src/core/tts/omissionCases.v1.jsonl')
const OUT = resolve(ROOT, 'scripts/out/envelope-report.json')
const SUMMARY = resolve(ROOT, 'scripts/out/envelope-report.md')

function parseArgs(argv) {
  const options = { caseId: 'om-0007', strict: false, minHz: 70, maxHz: 400 }
  for (const arg of argv) {
    if (arg === '--strict') options.strict = true
    else if (arg.startsWith('--case=')) options.caseId = arg.slice(7)
    else if (arg.startsWith('--min-hz=')) options.minHz = Number(arg.slice(8)) || 70
    else if (arg.startsWith('--max-hz=')) options.maxHz = Number(arg.slice(8)) || 400
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

/** Stop initials have a near-silent closure; their audible burst is shorter. */
function stopSecond(word) {
  try {
    const phones = pinyin(word, { toneType: 'num', v: true, type: 'array' })
    return /^(b|p|d|t|g|k)/.test(String(phones[1] ?? '').toLowerCase())
  } catch {
    return false
  }
}

/** Render the sentence the way the worker would and locate `word` in time. */
function renderAligned(synth, sentence, word, assets, lists) {
  const prepared = prepareRuntimeTextWithOverlay(sentence, assets, lists)
  const parts = utteranceParts(prepared)
  if (parts && parts.length > 1) {
    const rendered = parts.map((part) => synth.generateText(part))
    const sampleRate = rendered[0].sampleRate
    const fullSamples = joinPcmParts(rendered)
    const starts = partStartsMs(rendered)
    const targetIndex = parts.findIndex((part) =>
      part.replaceAll(WORD_BOUNDARY, '').includes(word))
    if (targetIndex >= 0) {
      const targetText = parts[targetIndex].replaceAll(WORD_BOUNDARY, '')
      if (targetText.startsWith(word)) {
        // U+2060 immediately before the whole word gives an exact boundary;
        // no envelope guess is needed.
        return {
          samples: fullSamples,
          sampleRate,
          prefixEndMs: starts[targetIndex],
          alignment: {
            method: 'worker-reset',
            confidence: 'high',
            correlation: 1,
            margin: 1,
            partStartMs: starts[targetIndex],
          },
        }
      }
      const wordIndex = targetText.indexOf(word)
      const partPrefix = targetText.slice(0, wordIndex)
      const prefixAudio = synth.generateText(
        prepareRuntimeTextWithOverlay(partPrefix, assets, lists))
      const aligned = alignPrefix(
        prefixAudio.samples,
        rendered[targetIndex].samples,
        sampleRate,
        { expectedMs: voicedBounds(prefixAudio.samples, sampleRate).endMs },
      )
      return {
        samples: fullSamples,
        sampleRate,
        prefixEndMs: starts[targetIndex] + aligned.endMs,
        alignment: { ...aligned, method: 'worker-reset+envelope', partStartMs: starts[targetIndex] },
      }
    }
  }

  const fullAudio = synth.generateText(prepared)
  const index = sentence.indexOf(word)
  const prefix = index >= 0 ? sentence.slice(0, index) : ''
  if (!prefix.trim()) {
    return {
      samples: fullAudio.samples,
      sampleRate: fullAudio.sampleRate,
      prefixEndMs: 0,
      alignment: {
        method: 'sentence-start',
        confidence: 'high',
        correlation: 1,
        margin: 1,
        offsetMs: 0,
        endMs: 0,
      },
    }
  }
  const prefixAudio = synth.generateText(prepareRuntimeTextWithOverlay(prefix, assets, lists))
  const aligned = alignPrefix(
    prefixAudio.samples,
    fullAudio.samples,
    fullAudio.sampleRate,
    { expectedMs: voicedBounds(prefixAudio.samples, fullAudio.sampleRate).endMs },
  )
  return {
    samples: fullAudio.samples,
    sampleRate: fullAudio.sampleRate,
    prefixEndMs: aligned.endMs,
    alignment: aligned,
  }
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
        if (!sentence.includes(item.word)) continue
        const rendered = renderAligned(synth, sentence, item.word, assets, lists)
        const envelope = analyzeEnvelope(rendered.samples, rendered.sampleRate)
        const target = evaluateTarget(envelope, rendered.prefixEndMs, {
          minSecondMs: stopSecond(item.word) ? 20 : 60,
        })
        const f0 = analyzeF0(rendered.samples, rendered.sampleRate, {
          minHz: options.minHz,
          maxHz: options.maxHz,
        })
        const targetF0 = target.first && target.second
          ? analyzeTargetF0(f0, target.first.startMs, target.second.endMs)
          : analyzeTargetF0(f0, rendered.prefixEndMs, rendered.prefixEndMs + 200)
        const decision = decisionFor(target.verdict, rendered.alignment)
        results.push({
          caseId: item.id,
          word: item.word,
          sentence,
          prefixEndMs: rendered.prefixEndMs,
          alignment: rendered.alignment,
          first: target.first,
          second: target.second,
          gapMs: target.gapMs,
          verdict: target.verdict,
          severity: severityFor(target),
          decision,
          runs: envelope.runs,
          f0: {
            voicedRatio: f0.voicedRatio,
            jumpRatio: f0.jumpRatio,
            maxJump: f0.maxJump,
            octaveJumps: f0.octaveJumps,
            finalSlopeHzPerSec: f0.finalSlopeHzPerSec,
            meanF0: f0.meanF0,
          },
          targetF0,
        })
      }
    }
  } finally {
    synth.free()
  }
  writeFileSync(OUT, `${JSON.stringify({
    provenance: currentProvenance(),
    strict: options.strict,
    results,
  }, null, 2)}\n`, 'utf8')
  const lines = [
    '# 山岚整句包络报告（advisory）',
    '',
    `- 案例：${cases.map((item) => item.id).join(', ')}`,
    '- 口径：优先用 U+2060 的 Worker 拼接边界定位；无边界时用前缀包络相关性对齐，并给出置信度。低置信度列为 NEEDS_LISTENING。',
    '- 目标词前缀结束时间之后的第一个强 burst 为第一音节，下一个 burst 为第二音节；第二音节 <60ms 或峰值 <第一音节 25% 记为 weak-second；没有第二个 burst 记为 merged。',
    '- 包络不能替代听感：粘连/弱爆破是排序线索；FAIL 只用于高置信度定位下的确定性异常。',
    '',
    '| 案例 | 词 | 前缀结束 | 对齐方式 | 置信度 | 第一音节 | 第二音节 | 间隔 | 等级 | 判定 | 状态 |',
    '| --- | --- | ---: | --- | --- | --- | --- | ---: | --- | --- | --- |',
  ]
  for (const item of results) {
    const first = item.first ? `${pct(item.first.ms)} / peak ${Math.round(item.first.peak * 100)}%` : '—'
    const second = item.second ? `${pct(item.second.ms)} / peak ${Math.round(item.second.peak * 100)}%` : '—'
    lines.push(`| ${item.caseId} | ${item.word} | ${pct(item.prefixEndMs)} | ${item.alignment.method} | ${item.alignment.confidence} | ${first} | ${second} | ${item.gapMs == null ? '—' : pct(item.gapMs)} | ${item.severity} | ${item.verdict} | ${item.decision} |`)
  }
  lines.push('', '## F0 连续性（advisory）', '',
    `- 搜索范围：${options.minHz}–${options.maxHz}Hz（可用 --min-hz / --max-hz 按音色配置）`,
    '- 句末斜率只反映整句尾部；目标词声调请看「目标斜率」。',
    '',
    '| 案例 | 词 | voiced | 跳变帧 | 最大跳变 | 八度跳 | 句末斜率 | 目标均值 | 目标斜率 | 目标置信度 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const item of results) {
    const f0 = item.f0
    const target = item.targetF0
    lines.push(`| ${item.caseId} | ${item.word} | ${Math.round(f0.voicedRatio * 100)}% | ${Math.round(f0.jumpRatio * 100)}% | ${Math.round(f0.maxJump * 100)}% | ${f0.octaveJumps} | ${f0.finalSlopeHzPerSec == null ? '—' : `${f0.finalSlopeHzPerSec.toFixed(1)}Hz/s`} | ${target.meanF0 == null ? '—' : target.meanF0.toFixed(0)} | ${target.slopeHzPerSec == null ? '—' : `${target.slopeHzPerSec.toFixed(1)}Hz/s`} | ${target.confidence} |`)
  }
  writeFileSync(SUMMARY, `${lines.join('\n')}\n`, 'utf8')
  console.log(`整句包络报告：${results.length} 条`)
  for (const item of results) {
    console.log(`  ${item.caseId} ${item.word} → ${item.decision} (${item.verdict}, ${item.alignment.confidence} alignment)`)
  }
  console.log(`报告 ${OUT}`)
  if (options.strict && results.some((item) => item.decision === 'FAIL')) {
    process.exitCode = 1
  }
}

main(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
