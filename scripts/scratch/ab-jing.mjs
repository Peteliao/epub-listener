// Dev-only: boundary A/B for 经历, the syllable that merges (371ms) in the short
// feedback sentence while the 88-char app unit stays normal. Measures the 经 that
// is immediately followed by 历 in both contexts.
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadMatchaAssets } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import {
  appSegments, buildRuntimeLexicon, loadWordLists, prepareRuntimeText, readAsset,
} from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const userSentence = '饱经风霜的张学良曾经用他一生的经历对日本的年轻人说：不要相信暴力。'
const unitText = '当他的生存基础——暴力——被人掀翻后，他也就没有任何底牌了，等待他的只有灭亡。饱经风霜的张学良曾经用他一生的经历对日本的年轻人说：不要相信暴力，历史已经证明，暴力不能解决问题。'
const lists = loadWordLists()
const blocks = [
  { label: 'user-sentence', text: prepareRuntimeText(userSentence, lists) },
  { label: 'app-unit', text: prepareRuntimeText(unitText, lists) },
  // U+2060 splits the sentence here and synthesises the tail as its own
  // utterance; these two strings are what the worker would actually generate.
  { label: 'reset-before', text: prepareRuntimeText('饱经风霜的张学良曾经用他一生的', lists) },
  { label: 'reset-after', text: prepareRuntimeText('经历对日本的年轻人说：不要相信暴力。', lists) },
  { label: 'reset-after-long', text: prepareRuntimeText('经历对日本的年轻人说：不要相信暴力，历史已经证明，暴力不能解决问题。', lists) },
  { label: 'alone', text: prepareRuntimeText('经历。', lists) },
]

const assets = await loadMatchaAssets()
const runtime = buildRuntimeLexicon({
  lexiconText: assets.lexiconText,
  curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
  bookText: '',
})
const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'scratch-jing-ab-lexicon.txt')
writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

function targetOf(text, effective) {
  const chars = [...text]
  const { tokens, ranges } = sentenceTokens(text, effective)
  const index = chars.findIndex((char, position) => char === '经' && chars[position + 1] === '历')
  if (index < 0) return null
  const find = (charIndex) => {
    const range = ranges.find((item) => charIndex >= item.startChar && charIndex < item.endChar)
    if (!range) return undefined
    const indices = phoneIndices(tokens, range.start, range.end - range.start)
    return { tokenIndex: indices[charIndex - range.startChar], word: range.word }
  }
  return {
    tokens,
    jing: find(index),
    li: find(index + 1),
    chars,
    index,
  }
}

const variants = [
  { label: '当前（经+历 单字）', word: null, reading: null },
  { label: '整词 无边界', word: '经历', reading: 'jing1 li4' },
  { label: '词首边界', word: '经历', reading: '" jing1 li4' },
  { label: '词尾边界', word: '经历', reading: 'jing1 li4 "' },
  { label: '双端边界', word: '经历', reading: '" jing1 li4 "' },
]

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  // Final runtime path: overlay row " 经历 双端边界 + protectedWords + utteranceResets.
  const finalEffective = new Map(runtime.runtimeMap)
  finalEffective.set('经历', '" jing1 li4 "')
  const finalLists = {
    ...lists,
    protectedWords: [...lists.protectedWords, '经历'],
    resetWords: [...lists.resetWords, '经历'],
  }
  console.log('\n===== FINAL PATH (reset + both-end) =====')
  for (const source of [userSentence, unitText]) {
    const segments = appSegments(source, '经历', finalLists)
    console.log(`source (${[...source].length} chars) -> ${segments.length} segment(s)`)
    for (const segment of segments) {
      const target = targetOf(segment.text, finalEffective)
      if (!target || !target.jing) {
        console.log('  segment without target:', segment.text.slice(0, 30))
        continue
      }
      const indices = [target.jing.tokenIndex, target.li?.tokenIndex]
        .filter((item) => item !== undefined)
      const summary = summarizeContributions(synth.contributions(target.tokens, indices))
      const show = (entry) => {
        if (!entry) return '—'
        return `${summary.values[indices.indexOf(entry.tokenIndex)]}ms ${summary.states[indices.indexOf(entry.tokenIndex)]}`
      }
      console.log(`  ${segment.label}: 经=${show(target.jing)} · 历=${show(target.li)}`)
    }
  }

  for (const block of blocks) {
    console.log(`\n===== ${block.label} (${[...block.text].length} chars) =====`)
    for (const variant of variants) {
      const effective = new Map(runtime.runtimeMap)
      if (variant.word) effective.set(variant.word, variant.reading)
      const target = targetOf(block.text, effective)
      if (!target || !target.jing) {
        console.log(`  ${variant.label}: no target`)
        continue
      }
      const indices = [target.jing.tokenIndex, target.li?.tokenIndex]
        .filter((item) => item !== undefined)
      const summary = summarizeContributions(synth.contributions(target.tokens, indices))
      const show = (entry) => {
        if (!entry) return '—'
        const order = indices.indexOf(entry.tokenIndex)
        return `${summary.values[order]}ms ${summary.states[order]}`
      }
      console.log(`  ${variant.label.padEnd(16)} 经=${show(target.jing)} · 历=${show(target.li)}`)
    }
  }
} finally {
  synth.free()
}
