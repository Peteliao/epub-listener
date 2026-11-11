// Dev-only: reproduce the app's 2-3 sentence speech units for the six 地
// sentences in the user's cess.txt and measure/record the 地 syllable.
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import { buildSpeechUnits } from '../../src/core/text/speechGroups.ts'

const targets = [
  '村里把荒地开垦成了良田。',
  '楼前有一片空地可以停车。',
  '这片林地受到严格保护。',
  '这家店只卖本地特产。',
  '他打开地图寻找路线。',
  '科学家在研究地心的结构。',
  '兔子钻进地洞里躲了起来。',
]

const source = fs.readFileSync('c:/Users/liaoh/Desktop/cess.txt', 'utf8')
const paragraphs = source.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean)
const sentences = []
for (const paragraph of paragraphs) {
  const parts = paragraph.split(/(?<=[。！？!?])/u).map((part) => part.trim()).filter(Boolean)
  parts.forEach((text, index) => {
    sentences.push({
      text,
      speechText: text,
      paragraphEnd: index === parts.length - 1,
      dialogue: false,
    })
  })
}
const units = buildSpeechUnits(sentences, { enabled: true, maxChars: 90 })
console.log(`paragraphs=${paragraphs.length} sentences=${sentences.length} units=${units.length}`)

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

function targetOf(text, effective) {
  const chars = [...text]
  const { tokens, ranges } = sentenceTokens(text, effective)
  const targets = []
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== '地') continue
    const range = ranges.find((item) => index >= item.startChar && index < item.endChar)
    if (!range) continue
    const offset = index - range.startChar
    const tokenIndex = phoneIndices(tokens, range.start, range.end - range.start)[offset]
    if (tokenIndex === undefined) continue
    targets.push({
      index, word: range.word, tokenIndex,
      context: chars.slice(Math.max(0, index - 8), index + 9).join(''),
    })
  }
  return { tokens, targets }
}

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  for (const target of targets) {
    const unit = units.find((item) => item.speechText.includes(target))
    if (!unit) {
      console.log(`\n${target} -> NO UNIT`)
      continue
    }
    const text = unit.speechText
    const { tokens, targets: found } = targetOf(text, runtime.runtimeMap)
    const targetDe = text.indexOf(target) + target.indexOf('地')
    const targetIndex = [...text.slice(0, targetDe)].length
    const targetHit = found.find((item) => item.index === targetIndex)
    const summary = targetHit
      ? summarizeContributions(synth.contributions(tokens, [targetHit.tokenIndex]))
      : { values: [], states: [] }
    const file = join(dir, `${target.slice(0, 4)}.wav`)
    const result = synth.generateText(text)
    synth.save(file, { samples: result.samples, sampleRate: synth.sampleRate })
    console.log(`\nTARGET ${target}`)
    console.log(`  unit (${[...text].length} chars): ${text}`)
    console.log(`  地: ${targetHit?.word ?? '?'} -> ${summary.values[0]}ms ${summary.states[0]}  ${file}`)
  }
} finally {
  synth.free()
}
