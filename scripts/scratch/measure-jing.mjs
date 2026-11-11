// Dev-only: rebuild the exact app speech block around the 饱经风霜 sentence and
// measure every 经 (饱经风霜 / 曾经 / 经历) with real Matcha WASM ablation.
//
// Pipeline mirrors ReaderController: splitSentences -> buildSpeechUnits
// (2-3 sentences, <=90 chars) -> zh language segment -> strip whitespace ->
// ensureSpeechEnd -> preparePronunciationText -> worker token stream.
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import {
  buildRuntimeLexicon, loadWordLists, prepareRuntimeText, readAsset,
} from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
// speechGroups.ts has no imports, so Node can load it directly; the other text
// helpers use extensionless imports that only Vite resolves. The sentence list
// here is a paragraph-local approximation (split on terminal punctuation), which
// is enough to reproduce the 2-3 sentence / <=90 char unit.
import { buildSpeechUnits } from '../../src/core/text/speechGroups.ts'

const corpus = process.env.TEMP + '/epub-out-backup/ming.txt'
const source = fs.readFileSync(corpus, 'utf8')
const paragraphs = source.split(/\r?\n/).filter((line) => line.includes('饱经风霜'))
const paragraph = paragraphs[0] ?? source.slice(Math.max(0, source.indexOf('饱经风霜') - 400),
  source.indexOf('饱经风霜') + 600)
const rawSentences = paragraph.split(/(?<=[。！？!?])/u).map((line) => line.trim()).filter(Boolean)
const sentences = rawSentences.map((text) => ({
  text, speechText: text, paragraphEnd: false, dialogue: false,
}))
const unit = buildSpeechUnits(sentences, { enabled: true, maxChars: 90 })
  .find((item) => item.speechText.includes('饱经风霜'))
if (!unit) throw new Error('block not found')
const block = prepareRuntimeText(
  unit.speechText.replace(/\s+/g, '').replace(/[，、；：]$/u, '。'),
  loadWordLists(),
)
console.log('paragraph sentences:', sentences.length)
console.log('block:', block)
console.log('block chars:', [...block].length)

const assets = await loadMatchaAssets()
const lists = loadWordLists()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-jing-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

function jingTargets(text, effective) {
  const chars = [...text]
  const { tokens, ranges } = sentenceTokens(text, effective)
  const targets = []
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== '经') continue
    const range = ranges.find((item) => index >= item.startChar && index < item.endChar)
    if (!range) {
      targets.push({ index, word: null, ok: false })
      continue
    }
    const offset = index - range.startChar
    const indices = phoneIndices(tokens, range.start, range.end - range.start)
    const tokenIndex = indices[offset]
    targets.push({
      index, word: range.word, offset, tokenIndex, ok: tokenIndex !== undefined,
      phones: tokens.slice(range.start, range.end).join(' '),
      context: chars.slice(Math.max(0, index - 8), index + 8).join(''),
    })
  }
  return { tokens, targets }
}

const userSentence = '饱经风霜的张学良曾经用他一生的经历对日本的年轻人说：不要相信暴力。'
const fullSentence = '饱经风霜的张学良曾经用他一生的经历对日本的年轻人说：不要相信暴力，历史已经证明，暴力不能解决问题。'
const blocks = [
  { label: 'app-unit', text: block },
  { label: 'user-sentence', text: prepareRuntimeText(userSentence, lists) },
  { label: 'full-sentence', text: prepareRuntimeText(fullSentence, lists) },
]

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  for (const item of blocks) {
    const { tokens, targets } = jingTargets(item.text, runtime.runtimeMap)
    const ok = targets.filter((entry) => entry.ok)
    console.log(`\n===== ${item.label} (${[...item.text].length} chars) =====`)
    console.log(item.text)
    const indices = ok.map((entry) => entry.tokenIndex)
    const summary = summarizeContributions(synth.contributions(tokens, indices))
    for (const [order, target] of ok.entries()) {
      console.log(`  ${target.word} · ${target.context} -> ${summary.values[order]}ms ${summary.states[order]}`)
    }
  }
} finally {
  synth.free()
}
