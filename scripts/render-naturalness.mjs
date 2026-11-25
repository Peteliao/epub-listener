#!/usr/bin/env node
/**
 * Real-WASM C2 punctuation / C4 full-factor naturalness renderer.
 *
 *   npm run naturalness:smoke   # first C2 sample (5 variants) + all 9 C4 cells
 *   npm run naturalness:render  # all 6 C2 samples + all 9 C4 cells
 *
 * Outputs stay under scripts/out/naturalness-{smoke,full}; WAVs are retained.
 * Noise waveforms are stochastic: filenames/protocol are reproducible, bytes are not.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadFrontendSpeech, prepareFrontendSpeechText } from './lib/frontendSpeech.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import {
  C2_SAMPLES, C2_VARIANTS, C4_SAMPLES, DEFAULT_SYNTH_CONFIG, NATURALNESS_PROTOCOL,
  NOISE_SCALES, PCM_PAUSE_POLICY, PARAMETER_GRID, buildTokenStream,
  experimentFilename, insertSilenceTokens, joinPcm, parameterGrid, pendingListeningStatus,
  planPcmSegments, runtimeEngineText, validateNaturalnessManifest, vocoderStatus,
} from './lib/naturalness.mjs'
import { currentProvenance } from './lib/provenance.mjs'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { buildRuntimeLexicon, readAsset } from './lib/wordFamily.mjs'

const OUT_ROOT = join(ROOT, 'scripts/out')
const EVIDENCE = join(OUT_ROOT, 'round12-punctuation-debug.log')

function parseArgs(argv) {
  const options = { mode: 'full' }
  for (const arg of argv) {
    if (arg === '--smoke') options.mode = 'smoke'
    else if (arg === '--full') options.mode = 'full'
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sourceVersions() {
  const files = [
    'scripts/render-naturalness.mjs',
    'scripts/lib/naturalness.mjs',
    'scripts/lib/matchaSynth.mjs',
    'scripts/lib/frontendSpeech.mjs',
  ]
  return Object.fromEntries(files.map((file) => [file, sha256File(join(ROOT, file))]))
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

function listeningHtml(manifest) {
  const labels = {
    'legacy-text': '旧 text 基线（绕过 C1）',
    'frontend-text': '生产前端 text',
    'runtime-tokens': '直接 token 基线',
    'boundary-token': '标点后插入 ID7 静音',
    'segmented-pcm': '分段 + PCM 停顿',
    'c4-grid': 'C4 全因子',
  }
  const rows = manifest.items.map((item) => `<tr>
<td>${htmlEscape(item.sampleId)}</td>
<td>${htmlEscape(labels[item.variant] ?? item.variant)}</td>
<td>noise=${item.actualConfig.noiseScale}<br>silence=${item.actualConfig.silenceScale}</td>
<td>${item.ms} ms</td>
<td><audio controls preload="none" src="${htmlEscape(item.file)}"></audio></td>
<td><details><summary>文本 / token</summary><pre>${htmlEscape(JSON.stringify({
  sourceText: item.sourceText,
  speechText: item.speechText,
  engineText: item.engineText,
  tokens: item.tokens,
  insertions: item.insertions,
  segments: item.segments,
}, null, 2))}</pre></details></td>
</tr>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>山岚 C2/C4 自然度试听（${htmlEscape(manifest.mode)}）</title>
<style>body{font:15px system-ui;margin:24px;color:#222;background:#fafafa}table{border-collapse:collapse;width:100%;background:white}th,td{border:1px solid #ddd;padding:9px;vertical-align:top}th{background:#eee;position:sticky;top:0}audio{width:280px}pre{white-space:pre-wrap;font-size:12px}.note{padding:12px;background:#fff4d6}</style>
<h1>山岚 C2/C4 自然度试听</h1>
<p class="note">${htmlEscape(manifest.status.note)} ${htmlEscape(manifest.status.randomWaveforms)}</p>
<p>协议 ${NATURALNESS_PROTOCOL}；C5：${htmlEscape(manifest.c5Vocoder.reason)}</p>
<table><thead><tr><th>样本</th><th>方案</th><th>实际参数</th><th>时长</th><th>试听</th><th>取证</th></tr></thead><tbody>${rows}</tbody></table>
</html>\n`
}

function concatenateWithPauses(results, segments) {
  const rate = results[0]?.sampleRate
  const pauses = segments.slice(0, -1).map((segment) => segment.pauseAfterMs)
  const parts = []
  results.forEach((result, index) => {
    parts.push(result)
    if (pauses[index] > 0) {
      parts.push({ samples: new Float32Array(Math.round(rate * pauses[index] / 1000)), sampleRate: rate })
    }
  })
  return joinPcm(parts, { sampleRate: rate })
}

function baseItem(sample, variant, prepared, config) {
  return {
    id: `${sample.id}__${variant}${variant === 'c4-grid' ? `__n${config.noiseScale}__s${config.silenceScale}` : ''}`,
    sampleId: sample.id,
    variant,
    sourceText: sample.text,
    normalizedText: prepared.normalizedText,
    plannedText: prepared.plannedText,
    speechText: prepared.speechText,
    engineText: runtimeEngineText(prepared.speechText),
    plannedConfig: { ...config },
    tokens: null,
    tokenStream: null,
    insertions: [],
    segments: [],
  }
}

async function renderC2(synth, sample, prepared, config, lexicon, inventory, dir, items) {
  const stream = buildTokenStream(prepared.speechText, lexicon, inventory)
  const boundary = insertSilenceTokens(stream, inventory)
  const pcmSegments = planPcmSegments(prepared.speechText, PCM_PAUSE_POLICY)
  for (const variant of C2_VARIANTS) {
    const item = baseItem(sample, variant, prepared, config)
    item.file = experimentFilename(sample.id, variant, config)
    let audio
    if (variant === 'legacy-text') {
      const legacyStream = buildTokenStream(sample.text, lexicon, inventory)
      item.engineText = runtimeEngineText(sample.text)
      item.tokens = legacyStream.tokens
      item.tokenStream = legacyStream
      audio = synth.generateText(sample.text, { silenceScale: config.silenceScale })
    } else if (variant === 'frontend-text') {
      item.tokens = stream.tokens
      item.tokenStream = stream
      audio = synth.generateText(prepared.speechText, { silenceScale: config.silenceScale })
    } else if (variant === 'runtime-tokens') {
      item.tokens = stream.tokens
      item.tokenStream = stream
      audio = synth.generate(stream.tokens, { silenceScale: config.silenceScale })
    } else if (variant === 'boundary-token') {
      item.tokens = boundary.tokens
      item.tokenStream = stream
      item.insertions = boundary.insertions
      audio = synth.generate(boundary.tokens, { silenceScale: config.silenceScale })
    } else {
      item.segments = pcmSegments
      item.tokens = pcmSegments.map((segment) => buildTokenStream(segment.text, lexicon, inventory).tokens)
      const rendered = pcmSegments.map((segment) => synth.generate(
        buildTokenStream(segment.text, lexicon, inventory).tokens,
        { silenceScale: config.silenceScale },
      ))
      audio = concatenateWithPauses(rendered, pcmSegments)
      audio.synthesisConfig = {
        ...rendered[0].synthesisConfig,
        sequenceEnd: rendered[rendered.length - 1].synthesisConfig.sequence,
      }
    }
    item.actualConfig = audio.synthesisConfig
    item.sampleRate = audio.sampleRate
    item.ms = Math.round(audio.samples.length / audio.sampleRate * 1000)
    synth.save(join(dir, item.file), audio)
    item.wavSha256 = sha256File(join(dir, item.file))
    items.push(item)
    console.log(`  ${item.id} ${item.ms}ms`)
  }
}

async function main(options) {
  const mode = options.mode
  const dir = join(OUT_ROOT, `naturalness-${mode}`)
  mkdirSync(dir, { recursive: true })
  const assets = await loadMatchaAssets()
  const runtime = buildRuntimeLexicon({
    lexiconText: assets.lexiconText,
    curatedText: readAsset('src/core/tts/polyphones.v1.txt'),
    bookText: '',
  })
  const lexiconPath = join(dir, 'naturalness-runtime-lexicon.txt')
  writeFileSync(lexiconPath, runtime.patchedText, 'utf8')
  const frontend = await loadFrontendSpeech()
  const c2Samples = mode === 'smoke' ? C2_SAMPLES.slice(0, 1) : C2_SAMPLES
  const c4Samples = mode === 'smoke' ? C4_SAMPLES.slice(0, 1) : C4_SAMPLES
  const prepared = new Map()
  for (const sample of [...C2_SAMPLES, ...C4_SAMPLES]) {
    prepared.set(sample.id, prepareFrontendSpeechText(sample.text, assets.overlayText, frontend))
  }
  const corpus = {
    protocol: NATURALNESS_PROTOCOL,
    frozen: true,
    c2: C2_SAMPLES,
    c4: C4_SAMPLES,
    selected: {
      c2: c2Samples.map((sample) => sample.id),
      c4: c4Samples.map((sample) => sample.id),
    },
    c2Variants: C2_VARIANTS,
    parameterGrid: parameterGrid(),
    pcmPausePolicy: PCM_PAUSE_POLICY,
    punctuationEvidence: {
      source: 'scripts/out/round12-punctuation-debug.log',
      sha256: existsSync(EVIDENCE) ? sha256File(EVIDENCE) : null,
      chinesePauseTokens: { '，': ',', '、': ',', '：': ',' },
      chineseSemicolon: { replacement: ';', emittedToken: null, reason: 'sentence-boundary-no-token' },
      silenceToken: { token: '"', id: 7 },
    },
  }
  writeFileSync(join(dir, 'naturalness-corpus.v1.json'), `${JSON.stringify(corpus, null, 2)}\n`, 'utf8')

  const items = []
  const initializations = []
  for (const noiseScale of NOISE_SCALES) {
    console.log(`初始化 noiseScale=${noiseScale}`)
    const synth = await createMatchaSynth({ quiet: true, lexiconPath, noiseScale })
    initializations.push(synth.config())
    try {
      const config = { ...DEFAULT_SYNTH_CONFIG, noiseScale }
      if (noiseScale === DEFAULT_SYNTH_CONFIG.noiseScale) {
        for (const sample of c2Samples) {
          await renderC2(synth, sample, prepared.get(sample.id), config, runtime.runtimeMap, assets.tokens, dir, items)
        }
      }
      for (const cell of PARAMETER_GRID.filter((entry) => entry.noiseScale === noiseScale)) {
        const cellConfig = { ...DEFAULT_SYNTH_CONFIG, ...cell }
        for (const sample of c4Samples) {
          const speech = prepared.get(sample.id)
          const item = baseItem(sample, 'c4-grid', speech, cellConfig)
          const stream = buildTokenStream(speech.speechText, runtime.runtimeMap, assets.tokens)
          item.tokens = stream.tokens
          item.tokenStream = stream
          item.file = experimentFilename(sample.id, item.variant, cellConfig)
          const audio = synth.generateText(speech.speechText, { silenceScale: cellConfig.silenceScale })
          item.actualConfig = audio.synthesisConfig
          item.sampleRate = audio.sampleRate
          item.ms = Math.round(audio.samples.length / audio.sampleRate * 1000)
          synth.save(join(dir, item.file), audio)
          item.wavSha256 = sha256File(join(dir, item.file))
          items.push(item)
          console.log(`  ${item.id} ${item.ms}ms`)
        }
      }
    } finally {
      synth.free()
    }
  }

  const manifest = {
    protocol: NATURALNESS_PROTOCOL,
    mode,
    generatedAt: new Date().toISOString(),
    outputDir: dir,
    corpus: 'naturalness-corpus.v1.json',
    corpusSha256: sha256File(join(dir, 'naturalness-corpus.v1.json')),
    sources: sourceVersions(),
    frontend: frontend.version,
    provenance: currentProvenance({ experimentId: `naturalness-${mode}` }),
    model: {
      packId: assets.pack.id,
      packVersion: assets.pack.version,
      runtime: assets.manifest.runtime,
      files: assets.pack.files.map(({ name, url, sha256 }) => ({ name, url, sha256 })),
      acousticModel: assets.pack.model.config.acousticModel,
      vocoder: assets.pack.model.config.vocoder,
      lexiconSha256: sha256File(lexiconPath),
      tokensSha256: sha256File(join(ROOT, 'public/models/matcha-icefall-zh-baker/tokens.txt')),
    },
    initializations,
    grid: { noiseScales: NOISE_SCALES, silenceScales: [0.8, 1, 1.2], cells: PARAMETER_GRID.length },
    c5Vocoder: vocoderStatus(),
    status: pendingListeningStatus(mode, items.length),
    items,
  }
  const errors = validateNaturalnessManifest(manifest, assets.tokens)
  if (errors.length) throw new Error(`自然度清单校验失败：\n${errors.join('\n')}`)
  writeFileSync(join(dir, 'naturalness-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'naturalness-status.json'), `${JSON.stringify({
    protocol: NATURALNESS_PROTOCOL,
    ...manifest.status,
    c5Vocoder: manifest.c5Vocoder,
    manifest: 'naturalness-manifest.json',
    listeningTable: 'naturalness-index.html',
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'naturalness-index.html'), listeningHtml(manifest), 'utf8')
  console.log(`自然度试听包：${join(dir, 'naturalness-index.html')}`)
  console.log(`保留 ${items.length} 个 WAV；listeningAccuracy=null；C5 BLOCKED（无 mel 接口）`)
}

main(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
