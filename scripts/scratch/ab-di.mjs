// Dev-only: boundary A/B for every 地 word in the seven feedback sentences.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const cases = [
  { word: '荒地', sentences: ['村里把荒地开垦成了良田。', '这片荒地一直没人耕种。'] },
  { word: '空地', sentences: ['楼前有一片空地可以停车。', '楼后的空地上堆满了杂物。'] },
  { word: '林地', sentences: ['这片林地受到严格保护。', '这片林地归村里所有。'] },
  { word: '本地', sentences: ['这家店只卖本地特产。', '本地特产很受欢迎。', '他是本地人。'] },
  { word: '地图', sentences: ['他打开地图寻找路线。', '墙上挂着一张地图。', '地图上标着路线。'] },
  { word: '地心', sentences: ['科学家在研究地心的结构。', '地心的温度非常高。', '地球的地心是滚烫的。'] },
  { word: '地洞', sentences: ['兔子钻进地洞里躲了起来。', '这个地洞通向山后。', '地洞里黑漆漆的。'] },
]

const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-di-ab-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

function measure(text, word, effective, synth) {
  const { tokens, ranges } = sentenceTokens(text, effective)
  const range = ranges.find((item) => item.word === word)
  if (!range) return null
  const offset = [...word].indexOf('地')
  const tokenIndex = phoneIndices(tokens, range.start, range.end - range.start)[offset]
  if (tokenIndex === undefined) return null
  const summary = summarizeContributions(synth.contributions(tokens, [tokenIndex]))
  return { word: range.word, value: summary.values[0], state: summary.states[0] }
}

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  for (const item of cases) {
    const base = runtime.runtimeMap.get(item.word)
    const phones = base.split(/\s+/).filter((phone) => phone !== '"').join(' ')
    const variants = [
      { label: 'none', reading: phones },
      { label: 'lead', reading: `" ${phones}` },
      { label: 'tail', reading: `${phones} "` },
      { label: 'both', reading: `" ${phones} "` },
    ]
    for (const sentence of item.sentences) {
      console.log(`\n${item.word} · ${sentence}`)
      for (const variant of variants) {
        const effective = new Map(runtime.runtimeMap)
        effective.set(item.word, variant.reading)
        const result = measure(sentence, item.word, effective, synth)
        console.log(`  ${variant.label.padEnd(5)} ${variant.reading.padEnd(24)} ${result ? `${result.word} 地=${result.value}ms ${result.state}` : 'no target'}`)
      }
    }
  }
} finally {
  synth.free()
}
