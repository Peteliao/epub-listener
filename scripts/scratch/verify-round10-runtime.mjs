// Dev-only: final real-front-end check for the 2026-11-23 round. Rebuilds the
// exact text SherpaDriver sends (overlay-derived U+200B + curated readings) and
// prints the REAL Matcha tokenisation (debug=1), so the fix is proven on the
// runtime path rather than only on the audit mirror.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import {
  buildRuntimeLexicon, prepareRuntimeTextWithOverlay, readAsset,
} from '../lib/wordFamily.mjs'

const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-round10-runtime-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const sentences = [
  '来到此处，你立刻就会明白原因何在。',
  '整个冬天，她始终没上美容院，也未染发。',
  '有几家公司在店里长期订餐，必须在十二点之前送到。',
  '你也不能永远干陪酒那行啊，美里也大了。',
]

const synth = await createMatchaSynth({ quiet: false, debug: true, lexiconPath })
try {
  for (const sentence of sentences) {
    const prepared = prepareRuntimeTextWithOverlay(sentence, assets)
      .replaceAll('\u200b', '⟦B⟧')
    console.log(`\n===== ${sentence}`)
    console.log(`PREPARED ${prepared}`)
    synth.generateText(prepareRuntimeTextWithOverlay(sentence, assets))
  }
} finally {
  synth.free()
}
