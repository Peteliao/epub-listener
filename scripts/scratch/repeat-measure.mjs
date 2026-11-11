// Dev-only: repeat the same syllable-ablation measurement to expose run-to-run
// variance. The CI failure of `audit:all` happened after ~108s, i.e. around the
// word-family gate, whose 349ms value sits 1ms below the 350ms "merged" limit.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import {
  appSegments, buildRuntimeLexicon, loadWordLists, readAsset, streamFor, WORD_FAMILY,
} from '../lib/wordFamily.mjs'
import { phoneIndices } from '../lib/fusionRisk.mjs'
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
const lexiconPath = join(dir, 'scratch-repeat-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const words = process.argv.slice(2).length ? process.argv.slice(2) : ['小便宜', '贪便宜', '捡便宜']
const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  for (const name of words) {
    const item = WORD_FAMILY.find((entry) => entry.word === name)
    const segment = appSegments(item.contexts[0].sentence, name, lists)[0]
    const stream = streamFor(segment.text, name, runtime.runtimeMap)
    const indices = phoneIndices(stream.tokens, stream.range.start, stream.count)
    const runs = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      runs.push(summarizeContributions(synth.contributions(stream.tokens, indices)))
    }
    console.log(`\n${name} · ${segment.text}`)
    for (const [index, run] of runs.entries()) {
      console.log(`  #${index + 1} ${run.values.join('/')}ms · ${run.states.join('/')} · ${run.score}`)
    }
  }
} finally {
  synth.free()
}
