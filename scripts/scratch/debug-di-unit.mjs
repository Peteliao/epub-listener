// Dev-only: print the full-sequence token durations for the real grouped unit.
import fs from 'node:fs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const unitText = '孩子们在草地上奔跑。村里把荒地开垦成了良田。楼前有一片空地可以停车。'
const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out/audio/di-grouped')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const synth = await createMatchaSynth({ quiet: false, debug: true, lexiconPath })
try {
  synth.generateText(unitText)
} finally {
  synth.free()
}
