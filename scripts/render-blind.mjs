#!/usr/bin/env node
/**
 * Render the fixed blind-listening corpus into a timestamped WAV folder.
 * Run once before a change and once after; keep both folders for A/B listening.
 *
 * Usage:
 *   npm run blind:render -- --tag=before
 *   npm run blind:render -- --tag=after --limit=8
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import {
  buildRuntimeLexicon, loadWordLists, prepareRuntimeTextWithOverlay, readAsset,
} from './lib/wordFamily.mjs'

const CORPUS = resolve(ROOT, 'tests/fixtures/blind-listening.v1.jsonl')
const OUT_ROOT = resolve(ROOT, 'scripts/out/blind')

function parseArgs(argv) {
  const options = { tag: new Date().toISOString().replace(/[:.]/g, '-'), limit: 0, corpus: CORPUS }
  for (const arg of argv) {
    if (arg.startsWith('--tag=')) options.tag = arg.slice(6)
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8)) || 0
    else if (arg.startsWith('--corpus=')) options.corpus = resolve(ROOT, arg.slice(9))
  }
  return options
}

function loadCorpus(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line))
}

async function main(options) {
  const all = loadCorpus(options.corpus)
  const items = options.limit > 0 ? all.slice(0, options.limit) : all
  const assets = await loadMatchaAssets()
  const lists = loadWordLists()
  const runtime = buildRuntimeLexicon({
    lexiconText: assets.lexiconText,
    curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
    bookText: '',
  })
  const dir = join(OUT_ROOT, options.tag)
  mkdirSync(dir, { recursive: true })
  const lexiconPath = join(dir, 'lexicon.txt')
  writeFileSync(lexiconPath, runtime.patchedText, 'utf8')

  const synth = await createMatchaSynth({ quiet: true, lexiconPath })
  const rendered = []
  try {
    for (const item of items) {
      const speechText = prepareRuntimeTextWithOverlay(item.text, assets, lists)
      const audio = synth.generateText(speechText)
      const file = join(dir, `${item.id}.wav`)
      synth.save(file, audio)
      rendered.push({
        id: item.id,
        category: item.category,
        file,
        speechText,
        ms: Math.round((audio.samples.length / audio.sampleRate) * 1000),
      })
      console.log(`  ${item.id} ${item.category} ${rendered[rendered.length - 1].ms}ms`)
    }
  } finally {
    synth.free()
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    tag: options.tag,
    corpus: options.corpus,
    count: rendered.length,
    items: rendered,
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`盲听语料已渲染：${dir}`)
}

main(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
