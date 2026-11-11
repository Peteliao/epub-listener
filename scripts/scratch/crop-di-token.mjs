// Dev-only: crop the 空地 「地」 token out of the app's real grouped unit.
// Prefix durations are deterministic, so start/end are the token's real span.
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const unitText = '孩子们在草地上奔跑。村里把荒地开垦成了良田。楼前有一片空地可以停车。'
const targetWord = '空地'
const dir = join(ROOT, 'scripts/out/audio/di-grouped')
mkdirSync(dir, { recursive: true })

const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const map = new Map(runtime.runtimeMap)
const { tokens, ranges } = sentenceTokens(unitText, map)
const range = ranges.find((item) => item.word === targetWord)
if (!range) throw new Error('target word not found')
const offset = [...targetWord].indexOf('地')
const index = phoneIndices(tokens, range.start, range.end - range.start)[offset]
if (index === undefined) throw new Error('target token not found')

const synth = await createMatchaSynth({ quiet: true })
try {
  // The prefix tells us where the token starts; the token itself is 338ms in
  // this context (debug log). duration(prefix+1)-duration(prefix) is only the
  // MARGINAL cost (93ms), not the token span.
  const start = synth.duration(tokens.slice(0, index))
  const tokenMs = 338
  const end = start + tokenMs
  const result = synth.generateText(unitText)
  const sr = synth.sampleRate
  const crop = result.samples.slice(
    Math.round(start * sr / 1000),
    Math.round(end * sr / 1000),
  )
  const file = join(dir, '空地-token.wav')
  synth.save(file, { samples: crop, sampleRate: sr })
  console.log(`unit tokens: ${tokens.length}`)
  console.log(`target token ${index} (${tokens[index]}) span: ${start}-${end}ms (${end - start}ms)`)
  console.log(`crop: ${Math.round(crop.length / sr * 1000)}ms -> ${file}`)
} finally {
  synth.free()
}
