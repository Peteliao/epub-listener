// Dev-only: phone/boundary A/B for the 2026-11-11 word-family repair.
//
// Uses pre-phonemized token streams, so one WASM session can measure every
// variant without rebuilding the 130MB model. Prints per-syllable contribution
// durations (swallowed <100ms, merged >350ms, normal otherwise).
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { phoneIndices } from '../lib/fusionRisk.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import { stripWordBoundaries } from '../lib/omission.mjs'
import { appSegments, streamFor, WORD_FAMILY } from '../lib/wordFamily.mjs'

const target = process.argv[2] ?? '便宜货'
const X = WORD_FAMILY.find((item) => item.word === target)
if (!X) throw new Error(`未知词条 ${target}`)

function tokensWithReading(stream, reading) {
  const phones = reading.split(/\s+/).filter(Boolean)
  const base = stripWordBoundaries(stream.tokens, stream.range.start, stream.count)
  const indices = phoneIndices(base, stream.range.start, stream.count)
  const first = indices[0]
  const next = [...base]
  next.splice(first, indices.length, ...phones)
  const focus = phoneIndices(next, stream.range.start, stream.count)
  return { tokens: next, focus }
}

const assets = await loadMatchaAssets()
const current = assets.overlay.entries.get(X.word) ?? assets.lexicon.get(X.word) ?? ''
const basePhones = current.split(/\s+/).filter((phone) => phone && phone !== '"').join(' ')
const variants = X.word.includes('便宜')
  ? [
    { label: '轻声 yi（当前）', reading: X.word === '便宜货' ? 'pian2 yi huo4' : null },
    { label: '全调 yi2（修复前）', reading: X.word === '便宜货' ? 'pian2 yi2 huo4' : null },
    { label: '轻声 + 词尾边界', reading: X.word === '便宜货' ? 'pian2 yi huo4 "' : null },
    { label: '全调 + 词尾边界', reading: X.word === '便宜货' ? 'pian2 yi2 huo4 "' : null },
    { label: '词首边界 + 轻声', reading: X.word === '便宜货' ? '" pian2 yi huo4' : null },
  ].filter((item) => item.reading)
  : [
    { label: '当前（无边界）', reading: basePhones },
    { label: '词首边界', reading: `" ${basePhones}` },
    { label: '词尾边界', reading: `${basePhones} "` },
    { label: '双端边界', reading: `" ${basePhones} "` },
  ]

const synth = await createMatchaSynth({ quiet: true })
try {
  for (const context of X.contexts) {
    // Measure the segments the app really synthesises (U+2060 split included).
    for (const segment of appSegments(context.sentence, X.word)) {
      const stream = streamFor(segment.text, X.word, assets.effective)
      if (!stream) {
        console.log(`${context.label} · ${segment.label}: 无法构造 token 序列`)
        continue
      }
      console.log(`\n${X.word} · ${context.label} · ${segment.label}：${segment.text}`)
      for (const variant of variants) {
        const { tokens, focus } = tokensWithReading(stream, variant.reading)
        const summary = summarizeContributions(synth.contributions(tokens, focus))
        console.log(`  ${variant.label.padEnd(18)} ${variant.reading.padEnd(22)} ${summary.values.join('/')}ms · ${summary.states.join('/')} · ${summary.score}`)
      }
    }
  }
} finally {
  synth.free()
}
console.log(`\n报告目录 ${join(ROOT, 'scripts/out')}`)
