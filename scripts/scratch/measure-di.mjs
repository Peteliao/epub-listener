// Dev-only: measure every 地 in the seven feedback sentences plus 地盘 with real
// Matcha WASM. A phone-correct di4 that is swallowed still sounds like de.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import {
  appSegments, buildRuntimeLexicon, loadWordLists, readAsset,
} from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const assets = await loadMatchaAssets()
const lists = loadWordLists()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-di-measure-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const sentences = [
  '村里把荒地开垦成了良田。',
  '楼前有一片空地可以停车。',
  '这片林地受到严格保护。',
  '这家店只卖本地特产。',
  '他打开地图寻找路线。',
  '科学家在研究地心的结构。',
  '兔子钻进地洞里躲了起来。',
]

function diTargets(text, effective) {
  const chars = [...text]
  const { tokens, ranges } = sentenceTokens(text, effective)
  const targets = []
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== '地') continue
    const range = ranges.find((item) => index >= item.startChar && index < item.endChar)
    if (!range) continue
    const offset = index - range.startChar
    const tokenIndex = phoneIndices(tokens, range.start, range.end - range.start)[offset]
    if (tokenIndex === undefined) continue
    targets.push({
      index, word: range.word, tokenIndex,
      context: chars.slice(Math.max(0, index - 6), index + 7).join(''),
    })
  }
  return { tokens, targets }
}

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  for (const sentence of sentences) {
    const { tokens, targets } = diTargets(sentence, runtime.runtimeMap)
    const indices = targets.map((item) => item.tokenIndex)
    const summary = indices.length
      ? summarizeContributions(synth.contributions(tokens, indices))
      : { values: [], states: [] }
    console.log(`\n${sentence}`)
    for (const [order, target] of targets.entries()) {
      console.log(`  ${target.word} · ${target.context} -> ${summary.values[order]}ms ${summary.states[order]}`)
    }
  }

  // 地盘: the app resets before it; measure the real segment with the current
  // lead boundary and the tail alternative.
  console.log('\n===== 地盘 =====')
  for (const context of [
    '自己只是占了点地盘；',
    '朱元璋对张士诚极为头疼，自己只是占了点地盘；',
    '地盘越小，越难守住。',
  ]) {
    for (const segment of appSegments(context, '地盘', lists)) {
      for (const [label, reading] of [
        ['lead（当前）', '" di4 pan2'],
        ['tail', 'di4 pan2 "'],
        ['none', 'di4 pan2'],
      ]) {
        const effective = new Map(runtime.runtimeMap)
        effective.set('地盘', reading)
        const { tokens, targets } = diTargets(segment.text, effective)
        if (!targets.length) continue
        const summary = summarizeContributions(
          synth.contributions(tokens, targets.map((item) => item.tokenIndex)))
        console.log(`  ${label.padEnd(10)} ${context.slice(0, 10)}… ${targets[0].word} -> ${summary.values.join('/')}ms ${summary.states.join('/')}`)
      }
    }
  }
} finally {
  synth.free()
}
