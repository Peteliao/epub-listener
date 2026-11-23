#!/usr/bin/env node
/**
 * Explain which source produced a word's final reading:
 *
 *   npm run explain:reading -- --word=长期
 *   npm run explain:reading -- --word=便宜 --book-overlay=scripts/out/book.txt
 *
 * This is diagnostic only; it never rewrites an overlay or the curated table.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { explainReading, formatExplanation } from './lib/readingSources.mjs'

const PATHS = {
  phrase: 'src/core/tts/phraseReadings.v1.txt',
  curated: 'src/core/tts/polyphones.v1.txt',
}

function parseArgs(argv) {
  const options = {
    word: '',
    book: '',
    ruby: '',
    live: '',
  }
  for (const arg of argv) {
    if (arg.startsWith('--word=')) options.word = arg.slice(7)
    else if (arg.startsWith('--book-overlay=')) options.book = arg.slice(15)
    else if (arg.startsWith('--ruby-overlay=')) options.ruby = arg.slice(15)
    else if (arg.startsWith('--live-overlay=')) options.live = arg.slice(15)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run explain:reading -- --word=词语 [--book-overlay=file] [--ruby-overlay=file] [--live-overlay=file]')
      process.exit(0)
    }
  }
  return options
}

function readOptional(path) {
  if (!path) return ''
  return readFileSync(resolve(ROOT, path), 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.word) throw new Error('必须提供 --word=词语')
  const assets = await loadMatchaAssets()
  const sources = {
    base: assets.lexiconText,
    phrase: readOptional(PATHS.phrase),
    book: readOptional(options.book),
    ruby: readOptional(options.ruby),
    live: readOptional(options.live),
    curated: readOptional(PATHS.curated),
  }
  console.log(formatExplanation(explainReading(options.word, sources)))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
