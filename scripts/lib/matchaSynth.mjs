// Dev-only: real Matcha WASM synthesis for acoustic audits.
//
// The runtime files in public/sherpa/runtime are CommonJS but the repository is
// ESM ("type": "module"), so a plain import would fail. Executing their source
// in a CommonJS-shaped scope keeps this library self-contained: it depends only
// on committed files, never on the gitignored scripts/out probe scripts.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const RUNTIME_DIR = join(ROOT, 'public', 'sherpa', 'runtime')
const MODEL_DIR = join(ROOT, 'public', 'models', 'matcha-icefall-zh-baker')

function loadCommonJs(source, filename) {
  const module = { exports: {} }
  const run = new Function(
    'module', 'exports', 'require', 'process', 'Buffer', '__dirname', '__filename',
    source,
  )
  run(module, module.exports, require, process, Buffer, process.cwd(), filename)
  return module.exports
}

/**
 * The merge threshold the shipped worker uses (public/workers/sherpa-tts.worker.js,
 * `min_words_in_sentence`). Audits MUST measure the same value: with 5 the front
 * end splits a 72-character book sentence differently than the app does, and the
 * syllable durations differ accordingly (地盘 128 vs 105ms).
 */
export const APP_MIN_WORDS_IN_SENTENCE = 12

/**
 * Creates a synth session. All measurements use pre-phonemized token input,
 * which is exactly the flat sequence the Matcha front end hands the acoustic
 * model — word boundaries never reach it.
 */
export async function createMatchaSynth({
  quiet = true,
  minWordsInSentence = APP_MIN_WORDS_IN_SENTENCE,
  lexiconPath = join(MODEL_DIR, 'lexicon.v3.txt'),
  // Front-end debug logs (real toy tokenisation) are the ground truth for
  // longest-match questions; leave off for measurements.
  debug = false,
} = {}) {
  const gluePath = join(RUNTIME_DIR, 'sherpa-onnx-wasm-tts.js')
  const apiPath = join(RUNTIME_DIR, 'sherpa-onnx-tts.js')
  const wasmPath = join(RUNTIME_DIR, 'sherpa-onnx-wasm-tts.wasm')
  const factory = loadCommonJs(readFileSync(gluePath, 'utf8'), gluePath)
  const api = loadCommonJs(readFileSync(apiPath, 'utf8'), apiPath)
  const Module = await factory({
    locateFile: () => wasmPath,
    print: quiet ? () => {} : (text) => console.log(text),
    printErr: quiet ? () => {} : (text) => console.error(text),
  })
  const tts = api.createOfflineTts(Module, {
    offlineTtsModelConfig: {
      offlineTtsMatchaModelConfig: {
        acousticModel: join(MODEL_DIR, 'model-steps-3.onnx'),
        vocoder: join(MODEL_DIR, 'vocos-22khz-univ.onnx'),
        lexicon: lexiconPath,
        tokens: join(MODEL_DIR, 'tokens.txt'),
        noiseScale: 0.667,
        lengthScale: 1,
      },
      numThreads: 1,
      debug: debug ? 1 : 0,
      provider: 'cpu',
    },
    ruleFsts: '',
    ruleFars: '',
    maxNumSentences: 20,
    silenceScale: 1,
  })
  const sampleRate = tts.sampleRate || 22050

  function generate(tokens) {
    return tts.generateWithConfig('', {
      sid: 0,
      speed: 1,
      silenceScale: 1,
      tokens: [tokens],
      extra: {
        max_words_in_sentence: 1000,
        min_words_in_sentence: minWordsInSentence,
      },
    })
  }

  /**
   * Real text path: lets the runtime run its own lexicon lookup, so a probe can
   * prove that the token stream the audits assume is the stream the app gets.
   */
  function generateText(text, speed = 1) {
    return tts.generateWithConfig(String(text), {
      sid: 0,
      speed,
      silenceScale: 1,
      extra: {
        max_words_in_sentence: 1000,
        min_words_in_sentence: minWordsInSentence,
      },
    })
  }

  function duration(tokens) {
    const result = generate(tokens)
    return Math.round(result.samples.length / (result.sampleRate || sampleRate) * 1000)
  }

  /**
   * Time a phone actually occupies: dur(sequence) - dur(sequence without it).
   * A swallowed syllable contributes only a few tens of ms; a syllable that
   * absorbed its neighbour contributes well over 350ms.
   */
  function contribution(tokens, index) {
    if (index < 0 || index >= tokens.length) return 0
    const without = tokens.filter((_, position) => position !== index)
    return duration(tokens) - duration(without)
  }

  function contributions(tokens, indices) {
    // Durations are deterministic even though waveforms are stochastic, so the
    // baseline only needs to be synthesised once for the whole ablation set.
    const base = duration(tokens)
    return indices.map((index) => {
      const without = tokens.filter((_, position) => position !== index)
      return base - duration(without)
    })
  }

  return {
    sampleRate,
    generate,
    generateText,
    duration,
    contribution,
    contributions,
    save: (file, result) => tts.save(file, result),
    free: () => tts.free(),
  }
}

export function acousticModelPaths() {
  return { ROOT, MODEL_DIR, RUNTIME_DIR }
}
