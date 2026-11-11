// Dev-only: print the REAL Matcha front-end tokenisation (debug=1) for the
// 便宜 phrases whose 便 could be stolen by a longer X便 entry.
//
// Uses the patched runtime lexicon (base + curated overlay), i.e. exactly the
// file the app hands the worker, not the unpatched model lexicon.
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
const lexiconPath = join(dir, 'scratch-runtime-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const texts = process.argv.slice(2)
const synth = await createMatchaSynth({ quiet: false, debug: true, lexiconPath })
try {
  for (const text of texts.length ? texts : [
    '不便宜。', '得便宜。', '就便宜。', '以便宜。', '趁便宜。', '占便宜。', '便宜。',
  ]) {
    console.log(`\n===== ${text}`)
    synth.generateText(text)
  }
} finally {
  synth.free()
}
