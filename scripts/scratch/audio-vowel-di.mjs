// Dev-only: render isolated syllables with the app-faithful lexicon so the
// vowel of 地 (di4) can be compared with 的 (de) and other di-tone tokens.
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib/reading.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import {
  mergeLexiconOverlays, normalizeOverlayText,
} from '../../src/core/tts/pinyinTones.ts'

const LEXICON = join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt')
const curated = readAsset('src/core/tts/polyphones.v1.txt')
const base = fs.readFileSync(LEXICON, 'utf8').replace(/^\uFEFF/, '')
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

const dir = join(ROOT, 'scripts/out/audio/vowel-di')
mkdirSync(dir, { recursive: true })
const lexiconPath = join(dir, 'lexicon.txt')
writeFileSync(lexiconPath, patched, 'utf8')

const cases = [
  { label: 'di4-地', text: '地。' },
  { label: 'de-的', text: '的。' },
  { label: 'di1-低', text: '低。' },
  { label: 'di2-敌', text: '敌。' },
  { label: 'di3-底', text: '底。' },
  { label: 'di4-第', text: '第。' },
  { label: 'huang1di4-荒地', text: '荒地。' },
  { label: 'di4tu2-地图', text: '地图。' },
  { label: 'di4xin1-地心', text: '地心。' },
  { label: 'di4dong4-地洞', text: '地洞。' },
]

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  const manifest = []
  for (const item of cases) {
    const result = synth.generateText(item.text)
    const file = join(dir, `${item.label}.wav`)
    synth.save(file, { samples: result.samples, sampleRate: synth.sampleRate })
    manifest.push({
      label: item.label, text: item.text,
      ms: Math.round(result.samples.length / synth.sampleRate * 1000),
      file: `${item.label}.wav`,
    })
    console.log(`${item.label.padEnd(16)} ${item.text}  ${manifest.at(-1).ms}ms  ${manifest.at(-1).file}`)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
} finally {
  synth.free()
}
