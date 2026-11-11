// Dev-only: print the REAL Matcha front-end lexicon matches for the 地 sentences.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-di-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const sentences = process.argv.slice(2).length ? process.argv.slice(2) : [
  '村里把荒地开垦成了良田。',
  '楼前有一片空地可以停车。',
  '这片林地受到严格保护。',
  '这家店只卖本地特产。',
  '他打开地图寻找路线。',
  '科学家在研究地心的结构。',
  '兔子钻进地洞里躲了起来。',
  '地盘很小。',
]

const synth = await createMatchaSynth({ quiet: false, debug: true, lexiconPath })
try {
  for (const sentence of sentences) {
    console.log(`\n===== ${sentence}`)
    synth.generateText(sentence)
  }
} finally {
  synth.free()
}
