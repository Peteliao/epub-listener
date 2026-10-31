/* Classic worker: Sherpa-onnx TTS runtime is loaded with importScripts and
   expects the Emscripten glue to publish `Module` and `createOfflineTts`
   on the global scope.

   One Worker hosts up to two TTS instances (Chinese and English) inside the
   same WASM module, so loading a second language does not allocate a second
   512 MB heap. Each language keeps its own MEMFS directory to avoid model,
   token, and lexicon collisions. */

'use strict'

const MODEL_CONFIG_KEYS = {
  vits: 'offlineTtsVitsModelConfig',
  matcha: 'offlineTtsMatchaModelConfig',
  kokoro: 'offlineTtsKokoroModelConfig',
}

const RUNTIME_ROOT = '/models'
const LANGS = ['zh', 'en']

let runtime = null
let runtimePromise = null
let lastRuntimeError = ''
let initChain = Promise.resolve()
const cancelledJobs = new Set()

function createSlot(lang) {
  return {
    lang,
    dir: `${RUNTIME_ROOT}/${lang}`,
    tts: null,
    sampleRate: 0,
    numSpeakers: 0,
    speakerId: 0,
    ready: false,
    initializing: false,
    modelType: '',
    files: [],
    oovWords: null,
  }
}

const slots = {
  zh: createSlot('zh'),
  en: createSlot('en'),
}

// The published runtime is built for Node and unconditionally imports
// `path` inside its MEMFS layer. Workers need a small POSIX shim instead.
const posixPath = {
  isAbsolute(path) {
    return typeof path === 'string' && path.length > 0 && path.charAt(0) === '/'
  },
  normalize(path) {
    let value = String(path)
    if (!value) return '.'
    const absolute = value.charCodeAt(0) === 47
    const trailing = value.charCodeAt(value.length - 1) === 47
    const segments = value.split('/')
    const output = []
    for (const segment of segments) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (output.length > 0 && output[output.length - 1] !== '..') output.pop()
        else if (!absolute) output.push('..')
      } else {
        output.push(segment)
      }
    }
    let result = output.join('/')
    if (!result && !absolute) result = '.'
    if (result && trailing && result !== '/') result += '/'
    return (absolute ? '/' : '') + result
  },
  dirname(path) {
    const value = String(path)
    if (!value) return '.'
    const normalized = posixPath.normalize(value)
    if (normalized === '/') return '/'
    const index = normalized.lastIndexOf('/')
    if (index < 0) return '.'
    if (index === 0) return '/'
    return normalized.slice(0, index)
  },
  basename(path) {
    const value = String(path).replace(/\/+$/, '')
    const index = value.lastIndexOf('/')
    return index < 0 ? value : value.slice(index + 1)
  },
  join(...parts) {
    return posixPath.normalize(parts.filter(Boolean).join('/'))
  },
  join2(left, right) {
    return posixPath.join(left, right)
  },
  resolve(...parts) {
    let output = ''
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (!parts[i]) continue
      output = `${parts[i]}/${output}`
      if (String(parts[i]).startsWith('/')) break
    }
    return posixPath.normalize(output.startsWith('/') ? output : `/${output}`)
  },
  relative(from, to) {
    const fromParts = posixPath.normalize(from).split('/').filter(Boolean)
    const toParts = posixPath.normalize(to).split('/').filter(Boolean)
    let shared = 0
    while (
      shared < fromParts.length &&
      shared < toParts.length &&
      fromParts[shared] === toParts[shared]
    ) {
      shared += 1
    }
    const up = new Array(fromParts.length - shared).fill('..')
    return up.concat(toParts.slice(shared)).join('/')
  },
}

posixPath.posix = posixPath
posixPath.sep = '/'

self.require = (id) => {
  if (id === 'path') return posixPath
  if (id === 'crypto') {
    return {
      randomFillSync(view) {
        self.crypto.getRandomValues(view)
        return view
      },
    }
  }
  throw new Error(`Unsupported runtime module in worker: ${id}`)
}

function post(message, transfer) {
  self.postMessage(message, transfer || [])
}

function normalizeLang(value) {
  return value === 'en' ? 'en' : 'zh'
}

self.onmessage = (event) => {
  const data = event.data
  if (!data || typeof data !== 'object') return

  if (data.type === 'init') {
    // Serialise initialisation: both languages share one WASM module, and
    // writing large files while another instance boots would interleave.
    const task = () => init(data)
    initChain = initChain.then(task, task).catch(() => undefined)
  } else if (data.type === 'synth') {
    void synthesize(data)
  } else if (data.type === 'cancel-job') {
    // Queued behind a running synthesis is fine: when the job is finally
    // dequeued, synthesize() skips it instead of burning a second of CPU.
    if (typeof data.jobId === 'string') {
      cancelledJobs.add(data.jobId)
      if (cancelledJobs.size > 32) {
        const oldest = cancelledJobs.values().next().value
        if (oldest !== undefined) cancelledJobs.delete(oldest)
      }
    }
  } else if (data.type === 'dispose-lang') {
    const lang = normalizeLang(data.lang)
    disposeSlot(slots[lang])
    post({ type: 'disposed', lang })
  } else if (data.type === 'dispose') {
    dispose()
  }
}

async function loadRuntime(data) {
  if (runtime) return runtime
  if (!runtimePromise) {
    runtimePromise = (async () => {
      importScripts(data.glueUrl, data.apiUrl)

      const factory = self.Module
      if (
        typeof factory !== 'function' ||
        typeof self.createOfflineTts !== 'function'
      ) {
        throw new Error('TTS runtime did not expose its factory.')
      }

      return await factory({
        locateFile: () => data.wasmUrl,
        print: () => {},
        printErr: (text) => {
          lastRuntimeError = String(text).slice(0, 500)
        },
      })
    })().catch((error) => {
      runtimePromise = null
      throw error
    })
  }
  runtime = await runtimePromise
  return runtime
}

async function init(data) {
  const lang = normalizeLang(data.lang)
  const slot = slots[lang]

  if (slot.ready) {
    postReady(slot, 0, 0)
    return
  }
  if (slot.initializing) return
  slot.initializing = true

  try {
    const module = await loadRuntime(data)
    const fs = module.FS
    if (!fs) throw new Error('TTS runtime did not expose a filesystem.')
    ensureDir(fs, RUNTIME_ROOT)
    ensureDir(fs, slot.dir)

    await writeModelFiles(fs, data, slot.dir)

    const startedAt = performance.now()
    const instance = self.createOfflineTts(module, buildTtsConfig(data, slot.dir))
    if (!instance || !instance.handle) {
      throw new Error('TTS instance could not be created.')
    }

    slot.tts = instance
    slot.sampleRate = instance.sampleRate || data.sampleRate || 0
    slot.numSpeakers = instance.numSpeakers || 1
    slot.speakerId = normalizeSpeaker(data.speakerId, slot.numSpeakers)
    slot.modelType =
      typeof data.model?.type === 'string' ? data.model.type : ''
    slot.files = (Array.isArray(data.files) ? data.files : [])
      .map((file) => file?.name)
      .filter((name) => typeof name === 'string')
    if (lang === 'en') slot.oovWords = buildOovWords(fs, data, slot.dir)

    const warmupStart = performance.now()
    try {
      instance.generate({
        text:
          typeof data.model?.warmupText === 'string'
            ? data.model.warmupText
            : '你好。',
        sid: slot.speakerId,
        speed: 1,
      })
    } catch {
      // A failed warmup is reported when the first real sentence is requested.
    }

    slot.ready = true
    slot.initializing = false
    post({
      type: 'ready',
      lang,
      sampleRate: slot.sampleRate,
      numSpeakers: slot.numSpeakers,
      initMs: Math.round(warmupStart - startedAt),
      warmupMs: Math.round(performance.now() - warmupStart),
      heapBytes: module.HEAPF32 ? module.HEAPF32.byteLength : 0,
      speakerId: slot.speakerId,
    })
  } catch (error) {
    slot.initializing = false
    cleanupSlot(slot)
    post({
      type: 'error',
      lang,
      code: 'init-failed',
      message: `${error instanceof Error ? error.message : String(error)}${
        lastRuntimeError ? ` · ${lastRuntimeError}` : ''
      }`,
      stack: error instanceof Error ? error.stack : null,
    })
  }
}

function ensureDir(fs, dir) {
  try {
    fs.mkdir(dir)
  } catch {
    // Already present after a retry.
  }
}

async function writeModelFiles(fs, data, dir) {
  if (!Array.isArray(data.files) || data.files.length === 0) {
    throw new Error('离线音色文件清单为空。')
  }
  if (typeof data.cacheName !== 'string' || !data.cacheName) {
    throw new Error('离线音色缓存信息缺失。')
  }
  if (typeof caches === 'undefined') {
    throw new Error('当前浏览器无法读取离线音色缓存。')
  }

  const cache = await caches.open(data.cacheName)
  for (const file of data.files) {
    if (
      !file ||
      typeof file.name !== 'string' ||
      typeof file.url !== 'string' ||
      typeof file.bytes !== 'number' ||
      typeof file.sha256 !== 'string'
    ) {
      throw new Error('离线音色文件清单格式不正确。')
    }

    const response = await cache.match(file.url)
    if (!response) {
      throw new Error(`离线音色文件 ${file.name} 缺失，请重新下载音色包。`)
    }

    let buffer
    try {
      buffer = await response.arrayBuffer()
    } catch {
      throw new Error(`无法读取离线音色文件 ${file.name}，请重新下载音色包。`)
    }
    if (buffer.byteLength !== file.bytes) {
      throw new Error(`离线音色文件 ${file.name} 大小不符，请重新下载音色包。`)
    }

    const digest = await sha256Hex(buffer)
    if (digest !== file.sha256.toLowerCase()) {
      throw new Error(`离线音色文件 ${file.name} 校验失败，请重新下载音色包。`)
    }

    const lexiconName =
      typeof data.model?.config?.lexicon === 'string'
        ? data.model.config.lexicon
        : ''
    const patch =
      data.model?.type === 'matcha' &&
      file.name === lexiconName &&
      typeof data.lexiconOverlay === 'string'

    fs.writeFile(
      `${dir}/${file.name}`,
      patch ? patchLexicon(buffer, data.lexiconOverlay) : new Uint8Array(buffer),
    )
  }
}

// sherpa-onnx ignores duplicate lexicon words (first entry wins), so overrides
// only take effect after the original lines for those words are removed.
function patchLexicon(buffer, overlay) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const original = decoder.decode(buffer).replace(/^\uFEFF/, '')
  const overlayLines = String(overlay)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (overlayLines.length === 0) return new Uint8Array(buffer)

  const overlayWords = new Set(
    overlayLines.map((line) => line.split(/\s+/)[0]),
  )
  const kept = original
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed && !overlayWords.has(trimmed.split(/\s+/)[0])
    })
  return encoder.encode(`${kept.join('\n')}\n${overlayLines.join('\n')}\n`)
}

async function sha256Hex(buffer) {
  if (!self.crypto?.subtle) {
    throw new Error('当前环境无法校验离线音色文件。')
  }
  const digest = await self.crypto.subtle.digest('SHA-256', buffer)
  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function buildTtsConfig(data, dir) {
  const type = data.model?.type
  const configKey = MODEL_CONFIG_KEYS[type]
  if (!configKey) {
    throw new Error(`不支持的离线音色类型：${type || '未知'}。`)
  }
  if (!data.model.config || typeof data.model.config !== 'object') {
    throw new Error('离线音色模型配置缺失。')
  }

  const fileNames = new Set(
    (Array.isArray(data.files) ? data.files : []).map((file) => file.name),
  )
  const modelConfig = {}
  for (const [field, value] of Object.entries(data.model.config)) {
    if (Array.isArray(value)) {
      modelConfig[field] = value
        .map((item) => resolveModelValue(item, fileNames, dir))
        .join(',')
    } else {
      modelConfig[field] = resolveModelValue(value, fileNames, dir)
    }
  }

  const ruleFsts = Array.isArray(data.model.ruleFsts) ? data.model.ruleFsts : []
  const ruleFstPaths = ruleFsts.map((name) => {
    if (!fileNames.has(name)) {
      throw new Error(`规则文件 ${name} 不在音色包中。`)
    }
    return `${dir}/${name}`
  })

  return {
    offlineTtsModelConfig: {
      [configKey]: modelConfig,
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    },
    ruleFsts: ruleFstPaths.join(','),
    ruleFars: '',
    // The app already splits text into sentence-sized utterances, so let each
    // utterance reach the model in one piece instead of being cut again every
    // 20 words. Natural punctuation pauses survive at the default scale.
    maxNumSentences: 20,
    silenceScale: 1,
  }
}

function resolveModelValue(value, fileNames, dir) {
  if (typeof value === 'string' && fileNames.has(value)) {
    return `${dir}/${value}`
  }
  return value
}

function normalizeSpeaker(value, count) {
  const requested = Number.isFinite(value) ? Math.trunc(value) : 0
  const max = Math.max(0, (count || 1) - 1)
  return Math.min(Math.max(0, requested), max)
}

function buildOovWords(fs, data, dir) {
  const name = data.model?.config?.lexicon
  if (typeof name !== 'string') return null
  try {
    const text = new TextDecoder().decode(fs.readFile(`${dir}/${name}`))
    const words = new Set()
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const separator = line.indexOf('||')
      if (separator < 0) continue
      const word = line.slice(0, separator).trim().toLowerCase()
      if (word && !word.includes(' ')) words.add(word)
    }
    return words
  } catch {
    // Without the word list the model still reads known words; it only skips
    // unknown ones as before.
    return null
  }
}

const WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g

/**
 * Piper VITS drops out-of-vocabulary tokens silently, so proper nouns vanish
 * from the audio. Spelling unknown words letter by letter keeps them audible:
 * "Hermione" becomes "H e r m i o n e".
 */
function spellOovWords(text, words) {
  if (!words || words.size === 0) return text
  return text.replace(WORD_PATTERN, (match) => {
    const lower = match.toLowerCase().replace(/’/g, "'")
    if (words.has(lower)) return match

    if (lower.includes("'")) {
      const base = lower.replace(/'[a-z]+$/, '')
      if (base && words.has(base)) return match
      const withoutApostrophe = lower.replace(/'/g, '')
      if (words.has(withoutApostrophe)) return match
    }

    if (lower.includes('-')) {
      const parts = lower.split('-')
      if (parts.every((part) => !part || words.has(part))) return match
      return parts
        .map((part) => {
          if (!part || words.has(part)) return part
          return spellLetters(part)
        })
        .join(' ')
    }

    return spellLetters(lower)
  })
}

function spellLetters(word) {
  const letters = word.toUpperCase().match(/[A-Z]/g)
  if (!letters || letters.length === 0) return word
  return letters.join(' ')
}

async function synthesize(data) {
  if (cancelledJobs.delete(data.jobId)) return

  const lang = normalizeLang(data.lang)
  const slot = slots[lang]

  if (!slot.ready || !slot.tts) {
    post({
      type: 'error',
      lang,
      epoch: data.epoch,
      jobId: data.jobId,
      code: 'not-ready',
      message:
        lang === 'en' ? '英文离线音色尚未准备好。' : '离线音色尚未准备好。',
    })
    return
  }

  try {
    const startedAt = performance.now()
    const sid = normalizeSpeaker(
      typeof data.speakerId === 'number' ? data.speakerId : slot.speakerId,
      slot.numSpeakers,
    )
    const config = {
      sid,
      speed: data.speed || 1,
      silenceScale:
        typeof data.silenceScale === 'number'
          ? Math.min(1.5, Math.max(0.5, data.silenceScale))
          : 1,
    }
    if (slot.modelType === 'matcha') {
      config.extra = { max_words_in_sentence: 1000, min_words_in_sentence: 5 }
    }

    const text =
      lang === 'en'
        ? spellOovWords(data.text, slot.oovWords)
        : data.text

    // generate() drops silenceScale/extra, so use the full generation config.
    // Without this every comma/period pause is squeezed to 20% of its length.
    const result =
      typeof slot.tts.generateWithConfig === 'function'
        ? slot.tts.generateWithConfig(text, config)
        : slot.tts.generate({ text, sid, speed: config.speed })
    if (!result || !result.samples || result.samples.length === 0) {
      throw new Error('The model returned an empty audio buffer.')
    }

    const volume =
      lang === 'en' && typeof data.volume === 'number'
        ? Math.min(1.3, Math.max(0.3, data.volume))
        : 1
    const samples = enhancePcm(
      result.samples,
      result.sampleRate || slot.sampleRate,
      volume,
    )
    const buffer = samples.buffer
    post(
      {
        type: 'result',
        lang,
        epoch: data.epoch,
        jobId: data.jobId,
        samples: buffer,
        sampleRate: result.sampleRate || slot.sampleRate,
        synthMs: Math.round(performance.now() - startedAt),
      },
      [buffer],
    )
  } catch (error) {
    post({
      type: 'error',
      lang,
      epoch: data.epoch,
      jobId: data.jobId,
      code: 'synth-failed',
      message: error instanceof Error ? error.message : '语音合成失败。',
      detail: lastRuntimeError,
    })
  }
}

const TRIM_THRESHOLD = 0.0018 // -55 dBFS keeps breath and decay tails
const TARGET_RMS = 0.115 // about -18.8 dBFS, even loudness across sentences
const MAX_GAIN = 2.5
const LIMIT_KNEE = 0.7
const LIMIT_CEILING = 0.841 // -1.5 dBFS

// Peak normalisation made a sentence as loud as its loudest syllable, so quiet
// passages jumped in volume and stressed syllables got squashed. Match loudness
// by RMS instead, then round off the peaks with a soft limiter.
function enhancePcm(input, rate, volume = 1) {
  let start = 0
  let end = input.length

  while (start < input.length && Math.abs(input[start]) < TRIM_THRESHOLD) start += 1
  while (end > start && Math.abs(input[end - 1]) < TRIM_THRESHOLD) end -= 1

  if (end - start < rate * 0.05) {
    start = 0
    end = input.length
  } else {
    const padding = Math.round(rate * 0.03)
    start = Math.max(0, start - padding)
    end = Math.min(input.length, end + padding)
  }

  const trimmed = input.subarray(start, end)
  // Pauses inside the sentence must not drag loudness down, otherwise a
  // comma-heavy line is boosted and then flattened by the limiter.
  let sumSquares = 0
  let active = 0
  for (let i = 0; i < trimmed.length; i += 1) {
    const value = trimmed[i]
    if (Math.abs(value) < TRIM_THRESHOLD) continue
    sumSquares += value * value
    active += 1
  }

  const rms = active > 0 ? Math.sqrt(sumSquares / active) : 0
  const gain = rms > 1e-4 ? Math.min(MAX_GAIN, TARGET_RMS / rms) : 1
  const output = new Float32Array(trimmed.length)
  const fade = Math.min(Math.round(rate * 0.006), Math.floor(trimmed.length / 2))
  const kneeRange = LIMIT_CEILING - LIMIT_KNEE

  for (let i = 0; i < trimmed.length; i += 1) {
    let value = trimmed[i] * gain * volume
    const magnitude = Math.abs(value)
    if (magnitude > LIMIT_KNEE) {
      const limited =
        LIMIT_KNEE + kneeRange * Math.tanh((magnitude - LIMIT_KNEE) / kneeRange)
      value = value < 0 ? -limited : limited
    }
    if (fade > 0) {
      if (i < fade) value *= i / fade
      const tail = trimmed.length - 1 - i
      if (tail < fade) value *= tail / fade
    }
    output[i] = Math.max(-1, Math.min(1, value))
  }

  return output
}

function postReady(slot, initMs, warmupMs) {
  post({
    type: 'ready',
    lang: slot.lang,
    sampleRate: slot.sampleRate,
    numSpeakers: slot.numSpeakers,
    initMs,
    warmupMs,
    heapBytes: runtime?.HEAPF32 ? runtime.HEAPF32.byteLength : 0,
    speakerId: slot.speakerId,
  })
}

function cleanupSlot(slot) {
  if (slot.tts) {
    try {
      slot.tts.free()
    } catch {
      // The runtime may already be partially torn down.
    }
    slot.tts = null
  }
  slot.ready = false
  slot.numSpeakers = 0
  slot.modelType = ''
  slot.oovWords = null
}

function disposeSlot(slot) {
  const fs = runtime?.FS
  cleanupSlot(slot)
  if (fs) {
    for (const name of slot.files) {
      try {
        fs.unlink(`${slot.dir}/${name}`)
      } catch {
        // Already removed by a previous dispose.
      }
    }
  }
  slot.files = []
}

function dispose() {
  for (const lang of LANGS) cleanupSlot(slots[lang])
  post({ type: 'disposed' })
  self.close()
}
