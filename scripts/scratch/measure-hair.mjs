// Dev-only: choose the completion boundary for the 发=fà family words that
// measured "merged" in the round-10 gate (秀发 371/371ms). Same method as
// scripts/scratch/measure-round10.mjs: real WASM, app-length blocks, every word
// edge variant, per-syllable ablation.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'

const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-hair-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')
const synth = await createMatchaSynth({ quiet: true, debug: false, lexiconPath })

const CASES = [
  {
    word: '秀发', phones: ['xiu4', 'fa4'],
    contexts: ['她的秀发又黑又亮。', '秀发在风中轻轻飘动。', '那一头秀发让人羡慕。'],
  },
  {
    word: '黑发', phones: ['hei1', 'fa4'],
    contexts: ['他把黑发染成了棕色。', '她的黑发披在肩上。'],
  },
  {
    word: '美发', phones: ['mei3', 'fa4'],
    contexts: ['理发店新推出了一项美发服务。', '她每周都去做美发。'],
  },
  {
    word: '假发', phones: ['jia3', 'fa4'],
    contexts: ['她买了一顶假发。', '假发戴久了不舒服。'],
  },
]

function variants(phones) {
  const join = (list) => list.join(' ')
  return [
    { kind: 'none', reading: join(phones) },
    { kind: 'tail', reading: `${join(phones)} "` },
    { kind: 'lead', reading: `" ${join(phones)}` },
    { kind: 'both', reading: `" ${join(phones)} "` },
  ]
}

const report = []
for (const item of CASES) {
  console.log(`\n========== ${item.word}`)
  for (const context of item.contexts) {
    console.log(`  -- ${context}`)
    for (const variant of variants(item.phones)) {
      const effective = new Map(runtime.runtimeMap)
      effective.set(item.word, variant.reading)
      const { tokens, ranges } = sentenceTokens(context, effective, assets.maxLength)
      const range = ranges.find((entry) => entry.word === item.word)
      if (!range) {
        console.log(`     ${variant.kind.padEnd(4)} 无法构造 token 序列`)
        continue
      }
      const indices = phoneIndices(tokens, range.start, item.phones.length)
      const contributions = synth.contributions(tokens, indices)
      const normal = contributions.every((value) => value >= 100 && value <= 350)
      console.log(`     ${variant.kind.padEnd(4)} ${contributions.map((value) => `${value}ms`).join(' / ')}  ${normal ? 'normal' : 'ABNORMAL'}`)
      report.push({ word: item.word, context, kind: variant.kind, contributions })
    }
  }
}
writeFileSync(join(dir, 'hair-measure.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
synth.free()
