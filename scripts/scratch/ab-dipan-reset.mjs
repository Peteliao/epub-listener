// Dev-only: 地盘 boundary A/B on the RESET segment (the app splits at U+2060
// and synthesises 地盘... as its own utterance). Exposed by the omission audit
// change that measures the app segment instead of the raw sentence.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import {
  buildRuntimeLexicon, loadWordLists, prepareRuntimeText, readAsset, utteranceParts,
} from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const contexts = [
  '朱元璋对张士诚极为头疼，自己只是占了点地盘，',
  '当时徐寿辉的地盘很小，只有黄州和浠水这一片地方，',
  '自己只是占了点地盘；',
]
const lists = loadWordLists()
const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-dipan-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const variants = [
  { label: '当前（lead）', reading: '" di4 pan2' },
  { label: '无边界', reading: 'di4 pan2' },
  { label: '词尾', reading: 'di4 pan2 "' },
  { label: '双端', reading: '" di4 pan2 "' },
]

function resetPart(text) {
  const prepared = prepareRuntimeText(text, lists)
  const parts = utteranceParts(prepared)
  return parts ? parts.find((part) => part.includes('地盘')) : prepared
}

function measure(text, effective, synth) {
  const { tokens, ranges } = sentenceTokens(text, effective)
  const chars = [...text]
  const index = chars.findIndex((char, position) => char === '地'
    && chars[position + 1] === '盘')
  if (index < 0) return null
  const range = ranges.find((item) => index >= item.startChar && index < item.endChar)
  if (!range) return null
  const indices = [0, 1].map((offset) => {
    const phoneIndex = phoneIndices(tokens, range.start, range.end - range.start)[offset]
    return phoneIndex
  }).filter((item) => item !== undefined)
  const summary = summarizeContributions(synth.contributions(tokens, indices))
  return { word: range.word, values: summary.values, states: summary.states }
}

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  for (const context of contexts) {
    const text = resetPart(context)
    console.log(`\n${context}\n  reset part: ${text}`)
    for (const variant of variants) {
      const effective = new Map(runtime.runtimeMap)
      effective.set('地盘', variant.reading)
      const result = measure(text, effective, synth)
      console.log(`  ${variant.label.padEnd(8)} ${result?.word ?? '—'} ${result ? result.values.join('/') + ' · ' + result.states.join('/') : 'no target'}`)
    }
  }
} finally {
  synth.free()
}
