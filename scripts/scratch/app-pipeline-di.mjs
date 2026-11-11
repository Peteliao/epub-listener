// Dev-only: reproduce the app's exact runtime lexicon path for the six 地
// sentences:
//   polyphones.v1.txt -> mergeLexiconOverlays(curated, book) ->
//   normalizeOverlayText -> worker patchLexicon (delete base rows, append) ->
//   real Matcha WASM debug (which line was matched).
// Also diff the resulting rows against the audit mirror (buildRuntimeLexicon).
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib/reading.mjs'
import { sentenceTokens, phoneIndices } from '../lib/fusionRisk.mjs'
import { buildRuntimeLexicon, loadWordLists, readAsset } from '../lib/wordFamily.mjs'
import { summarizeContributions } from '../lib/acousticScoring.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import {
  mergeLexiconOverlays, normalizeOverlayText,
} from '../../src/core/tts/pinyinTones.ts'

const LEXICON = join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt')
const curated = readAsset('src/core/tts/polyphones.v1.txt')
const base = fs.readFileSync(LEXICON, 'utf8').replace(/^\uFEFF/, '')

// Exactly what AiModel.ts hands to the worker for a matcha pack.
const appOverlay = normalizeOverlayText(mergeLexiconOverlays(curated, ''))
const overlayLines = appOverlay.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
const overlayWords = new Set(overlayLines.map((line) => line.split(/\s+/)[0]))
const kept = base.split(/\r?\n/).filter((line) => {
  const trimmed = line.trim()
  return trimmed && !overlayWords.has(trimmed.split(/\s+/)[0])
})
const patched = `${kept.join('\n')}\n${overlayLines.join('\n')}\n`

const audit = buildRuntimeLexicon({
  lexiconText: base,
  curatedText: curated,
  bookText: '',
})
const auditPatched = audit.patchedText

const dir = join(ROOT, 'scripts/out')
mkdirSync(dir, { recursive: true })
const appLexiconPath = join(dir, 'app-pipeline-di-lexicon.txt')
writeFileSync(appLexiconPath, patched, 'utf8')
writeFileSync(join(dir, 'audit-pipeline-di-lexicon.txt'), auditPatched, 'utf8')

const words = ['荒地', '空地', '林地', '本地', '地图', '地心', '地洞']
console.log('===== 六词在 App 补丁词典 / 审计镜像中的行 =====')
for (const word of words) {
  const row = (text) => text.split(/\r?\n/).find((line) => line.split(/\s+/)[0] === word) ?? '(none)'
  const appRow = row(patched)
  const auditRow = row(auditPatched)
  console.log(`${word}: app=${appRow} | audit=${auditRow} | same=${appRow === auditRow}`)
}
console.log(`patched lines: ${patched.split(/\n/).length} · audit lines: ${auditPatched.split(/\n/).length}`)

const sentences = [
  '村里把荒地开垦成了良田。',
  '楼前有一片空地可以停车。',
  '这家店只卖本地特产。',
  '他打开地图寻找路线。',
  '科学家在研究地心的结构。',
  '兔子钻进地洞里躲了起来。',
]

// Expected spans from the same patched text the app gives the worker.
const map = new Map()
for (const line of patched.split(/\r?\n/)) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const [word, ...phones] = trimmed.split(/\s+/)
  map.set(word, phones.join(' '))
}
for (const sentence of sentences) {
  const { ranges } = sentenceTokens(sentence, map, 12)
  const hits = ranges.filter((range) => Array.from(range.word).includes('地'))
  console.log(`\n${sentence}`)
  for (const hit of hits) console.log(`  span: ${hit.word} -> ${map.get(hit.word)}`)
}

const synth = await createMatchaSynth({ quiet: false, debug: true, lexiconPath: appLexiconPath })
try {
  const lists = loadWordLists()
  for (const sentence of sentences) {
    console.log(`\n### ${sentence}`)
    synth.generateText(sentence)
  }
} finally {
  synth.free()
}
