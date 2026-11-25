#!/usr/bin/env node
/**
 * Render the fixed blind-listening corpus into a timestamped WAV folder.
 * Run once before a change and once after; keep both folders for A/B listening.
 *
 * Usage:
 *   npm run blind:render -- --tag=before
 *   npm run blind:render -- --tag=after --limit=8
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadFrontendSpeech, prepareFrontendSpeechText } from './lib/frontendSpeech.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import { joinPcm, vocoderStatus } from './lib/naturalness.mjs'
import { currentProvenance, sha256Text } from './lib/provenance.mjs'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { buildRuntimeLexicon, readAsset } from './lib/wordFamily.mjs'

const CORPUS = resolve(ROOT, 'tests/fixtures/blind-listening.v1.jsonl')
const OUT_ROOT = resolve(ROOT, 'scripts/out/blind')
const UTTERANCE_RESET_GAP_MS = 120

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function parseArgs(argv) {
  const options = { tag: new Date().toISOString().replace(/[:.]/g, '-'), limit: 0, corpus: CORPUS }
  for (const arg of argv) {
    if (arg.startsWith('--tag=')) options.tag = arg.slice(6)
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8)) || 0
    else if (arg.startsWith('--corpus=')) options.corpus = resolve(ROOT, arg.slice(9))
    else if (arg === '--full') options.limit = 0
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
  const frontend = await loadFrontendSpeech()
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
      const prepared = prepareFrontendSpeechText(item.text, assets.overlayText, frontend)
      // Match the worker's U+2060 split and 120ms PCM join. The saved audio is
      // raw WASM PCM (not the worker's enhancePcm), so acoustic audits remain
      // comparable; the text/utterance chain is the production one.
      const segments = prepared.speechText.split(frontend.UTTERANCE_RESET)
        .map((part) => part.trim()).filter(Boolean)
      const results = segments.map((text) => synth.generateText(text))
      const audio = results.length > 1
        ? joinPcm(results, { gapMs: UTTERANCE_RESET_GAP_MS })
        : results[0]
      if (results.length > 1) {
        audio.synthesisConfig = {
          ...results[0].synthesisConfig,
          segments: results.map((result) => result.synthesisConfig),
          joinGapMs: UTTERANCE_RESET_GAP_MS,
        }
      }
      const file = join(dir, `${item.id}.wav`)
      synth.save(file, audio)
      rendered.push({
        id: item.id,
        category: item.category,
        focus: item.focus,
        file,
        wavSha256: sha256File(file),
        sourceText: item.text,
        normalizedText: prepared.normalizedText,
        plannedText: prepared.plannedText,
        speechText: prepared.speechText,
        workerSegments: segments,
        actualConfig: audio.synthesisConfig,
        sampleRate: audio.sampleRate,
        ms: Math.round((audio.samples.length / audio.sampleRate) * 1000),
      })
      console.log(`  ${item.id} ${item.category} ${rendered[rendered.length - 1].ms}ms`)
    }
  } finally {
    synth.free()
  }

  // Freeze the entire versioned fixture, whatever its current row count. The
  // checked-in v1 file has 48 JSON records (the apparent 53 lines include blanks).
  const complete = options.limit === 0 && all.length > 0 && rendered.length === all.length
  const corpusSha256 = sha256File(options.corpus)
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    tag: options.tag,
    corpus: options.corpus,
    corpusSha256,
    expectedCount: all.length,
    sourceCount: all.length,
    count: rendered.length,
    complete,
    frozen: complete,
    status: complete ? 'FROZEN_PENDING_LISTENING' : 'SMOKE_NOT_FOR_SCORING',
    listeningAccuracy: null,
    listeningAccuracyNote: '尚未进行真人独立听感评分；冻结 manifest 不构成正确率或偏好基线。',
    textPipeline: [
      'normalizeSpeechText',
      'planSpeechPhrasing',
      'overlayProtectedWords + preparePronunciationText',
      'worker U+2060 split + 120ms PCM join',
    ],
    normalizerVersion: frontend.version.sources['src/core/text/TextNormalizer.ts'],
    phrasingVersion: frontend.version.sources['src/core/text/SpeechPhrasing.ts'],
    frontendVersion: frontend.version,
    overlaySha256: sha256Text(assets.overlayText),
    runtimeLexiconSha256: sha256File(lexiconPath),
    audioProcessing: 'raw Matcha WASM PCM; worker enhancePcm intentionally not applied',
    synthesisDefaults: synth.config(),
    c5Vocoder: vocoderStatus(),
    freeze: complete ? {
      protocol: 'blind-listening.v1',
      corpusSha256,
      note: 'manifest 写盘后哈希记录在 frozen.json；WAV 哈希逐条记录在 items。',
    } : null,
    provenance: currentProvenance(),
    items: rendered,
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(join(dir, 'manifest.json'), manifestText, 'utf8')
  if (complete) {
    const frozen = {
      protocol: 'blind-listening.v1',
      frozenAt: manifest.generatedAt,
      corpusSha256,
      manifestSha256: sha256Text(manifestText),
      frontendVersion: manifest.frontendVersion,
      normalizerVersion: manifest.normalizerVersion,
      phrasingVersion: manifest.phrasingVersion,
      overlaySha256: manifest.overlaySha256,
      runtimeLexiconSha256: manifest.runtimeLexiconSha256,
      listeningAccuracy: null,
      c5Vocoder: manifest.c5Vocoder,
    }
    writeFileSync(join(dir, 'frozen.json'), `${JSON.stringify(frozen, null, 2)}\n`, 'utf8')
  }
  console.log(`盲听语料已渲染：${dir}（${manifest.status}，listeningAccuracy=null）`)
}

main(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
