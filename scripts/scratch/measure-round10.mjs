// Dev-only: real-WASM measurement for the 2026-11-23 feedback round.
// Words: 立刻 (OOV + acoustic), 染发 (多音字 发), 长期 (被 里长 抢词),
// 那行 (多音字 行, 行业义). Prints per-syllable duration contributions for
// every boundary variant so the chosen fix is evidence-based, not guessed.
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
const lexiconPath = join(dir, 'scratch-round10-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

const synth = await createMatchaSynth({ quiet: true, debug: false, lexiconPath })

const CASES = [
  {
    word: '立刻', phones: ['li4', 'ke4'],
    contexts: [
      '来到此处，你立刻就会明白原因何在。',
      '你立刻就会明白。',
      '他立刻站了起来。',
    ],
  },
  {
    word: '染发', phones: ['ran3', 'fa4'],
    contexts: [
      '整个冬天，她始终没上美容院，也未染发。',
      '她决定去染发。',
      '染发之后她年轻了许多。',
    ],
  },
  {
    word: '长期', phones: ['chang2', 'qi1'],
    contexts: [
      '有几家公司在店里长期订餐，必须在十二点之前送到。',
      '这是长期积累的结果。',
      '他们长期保持合作关系。',
    ],
  },
  {
    word: '陪酒那行', phones: ['pei2', 'jiu3', 'na4', 'hang2'],
    contexts: [
      '你也不能永远干陪酒那行啊，美里也大了。',
      '她说陪酒那行太辛苦。',
      '干陪酒那行并不轻松。',
    ],
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

function measureSentence(sentence, word, phones, reading) {
  const effective = new Map(assets.effective)
  effective.set(word, reading)
  const { tokens, ranges } = sentenceTokens(sentence, effective, assets.maxLength)
  const range = ranges.find((item) => item.word === word)
  if (!range) return null
  const indices = phoneIndices(tokens, range.start, phones.length)
  const base = synth.duration(tokens)
  const contributions = synth.contributions(tokens, indices)
  return {
    tokens,
    base,
    contributions,
    balanced: contributions.every((value) => value >= 100 && value <= 350),
  }
}

const report = []
for (const item of CASES) {
  console.log(`\n========== ${item.word}`)
  for (const context of item.contexts) {
    console.log(`  -- ${context}`)
    for (const variant of variants(item.phones)) {
      const result = measureSentence(context, item.word, item.phones, variant.reading)
      if (!result) {
        console.log(`     ${variant.kind.padEnd(4)} 无法构造 token 序列`)
        continue
      }
      console.log(
        `     ${variant.kind.padEnd(4)} ${result.contributions.map((value) => `${value}ms`).join(' / ')}`
        + `  ${result.balanced ? 'normal' : 'ABNORMAL'}  tokens=${result.tokens.length}`,
      )
      report.push({ word: item.word, context, kind: variant.kind, ...result })
    }
  }
}

writeFileSync(join(dir, 'round10-measure.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
synth.free()
