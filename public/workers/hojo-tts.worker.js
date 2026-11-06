'use strict'

const SAMPLE_RATE = 24000
const MAX_NEW = 2048
const MIN_NEW = 10

let ortRuntime = null
let Hojo = null
let HojoTokenizer = null
let runtimeBaseUrl = ''
let cacheName = ''
let signature = ''
let tts = null
let voices = null
let numSpeakers = 0
let initMetrics = { initMs: 0, warmupMs: 0 }
let chain = Promise.resolve()
const cancelled = new Set()
const jobLangs = new Map()

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function postError(lang, jobId, error, code = 'synth-failed', initId) {
  self.postMessage({
    type: 'error',
    lang,
    initId,
    jobId,
    code,
    message: errorMessage(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  })
}

function postReady(lang, initId) {
  self.postMessage({
    type: 'ready',
    lang,
    initId,
    sampleRate: SAMPLE_RATE,
    numSpeakers,
    initMs: initMetrics.initMs,
    warmupMs: initMetrics.warmupMs,
    heapBytes: self.performance?.memory?.usedJSHeapSize ?? 0,
  })
}

async function readCached(file) {
  const cache = await caches.open(cacheName)
  const segments = Array.isArray(file.parts) && file.parts.length ? file.parts : [file]
  const buffers = []
  let total = 0
  for (const segment of segments) {
    const response = await cache.match(segment.url)
    if (!response) throw new Error(`离线模型文件缺失：${segment.name}`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength !== segment.bytes) {
      throw new Error(`离线模型文件不完整：${segment.name}`)
    }
    buffers.push(buffer)
    total += buffer.byteLength
  }
  if (buffers.length === 1) return buffers[0]
  const merged = new Uint8Array(total)
  let offset = 0
  for (let i = 0; i < buffers.length; i += 1) {
    merged.set(buffers[i], offset)
    offset += buffers[i].byteLength
    buffers[i] = null
  }
  return merged
}

function findFile(files, name) {
  const file = files.find((item) => item.name === name)
  if (!file) throw new Error(`模型清单缺少 ${name}`)
  return file
}

function findLmFile(files) {
  const file = files.find(
    (item) => item.name === 'llm.onnx' || item.name === 'llm-int8.onnx',
  )
  if (!file) throw new Error('模型清单缺少语言模型')
  return file
}

function f16ToF32(u16) {
  const out = new Float32Array(u16.length)
  for (let i = 0; i < u16.length; i += 1) {
    const h = u16[i]
    const s = h & 0x8000 ? -1 : 1
    const e = (h >> 10) & 0x1f
    const f = h & 0x3ff
    out[i] =
      e === 0
        ? s * Math.pow(2, -14) * (f / 1024)
        : e === 31
          ? f
            ? NaN
            : s * Infinity
          : s * Math.pow(2, e - 15) * (1 + f / 1024)
  }
  return out
}

async function createSession(buffer, label) {
  const started = performance.now()
  const session = await ortRuntime.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  self.console?.log?.(`[hojo] ${label} ${(performance.now() - started).toFixed(0)}ms`)
  return session
}

async function handleInit(message) {
  const nextSignature =
    `${message.engine ?? 'hojo'}|${message.packId ?? ''}|` +
    `${message.variantId ?? ''}|${message.packVersion ?? ''}|${message.cacheName ?? ''}`

  if (tts && signature === nextSignature) {
    postReady(message.lang, message.initId)
    return
  }

  const initStarted = performance.now()
  tts = null
  voices = null
  numSpeakers = 0
  initMetrics = { initMs: 0, warmupMs: 0 }
  cacheName = message.cacheName
  runtimeBaseUrl = message.runtimeBaseUrl
  if (!runtimeBaseUrl.endsWith('/')) runtimeBaseUrl += '/'

  if (!ortRuntime) {
    importScripts(new URL('ort.wasm.min.js', runtimeBaseUrl).href)
    ortRuntime = self.ort
    if (!ortRuntime) throw new Error('ONNX Runtime Web 加载失败。')
    ortRuntime.env.logLevel = 'error'
    ortRuntime.env.wasm.numThreads = 1
    ortRuntime.env.wasm.wasmPaths = runtimeBaseUrl
  }
  if (!Hojo || !HojoTokenizer) {
    importScripts(
      new URL('hojo-core.js', runtimeBaseUrl).href,
      new URL('hojo-tok.js', runtimeBaseUrl).href,
    )
    Hojo = self.Hojo
    HojoTokenizer = self.HojoTokenizer
    if (!Hojo || !HojoTokenizer) throw new Error('Hojo 运行时加载失败。')
  }

  const files = message.files
  if (!Array.isArray(files) || !files.length) throw new Error('模型清单为空。')

  // Load sequentially and release each JS buffer after the session copies it
  // into the WASM heap; the full decoder alone is 123 MB.
  let buffer = await readCached(findLmFile(files))
  const lm = await createSession(buffer, 'lm')
  buffer = null

  buffer = await readCached(findFile(files, 'decoder.onnx'))
  const dec = await createSession(buffer, 'decoder')
  buffer = null

  buffer = await readCached(findFile(files, 'fine_local.onnx'))
  const fine = await createSession(buffer, 'fine')
  buffer = null

  const embBuffer = await readCached(findFile(files, 'token_embedding.f16'))
  const emb = f16ToF32(
    new Uint16Array(
      embBuffer.buffer,
      embBuffer.byteOffset,
      embBuffer.byteLength / 2,
    ),
  )
  const voicesBuffer = await readCached(findFile(files, 'voices.json'))
  const tokenizerBuffer = await readCached(findFile(files, 'tok.json'))
  const decoder = new TextDecoder()
  voices = JSON.parse(decoder.decode(voicesBuffer))
  const tokenizer = new HojoTokenizer(JSON.parse(decoder.decode(tokenizerBuffer)))
  tts = new Hojo.HojoTTS({
    ort: ortRuntime,
    lm,
    fine,
    dec,
    tokenizer,
    emb,
    voices,
  })
  numSpeakers = voices.voice_ids.length
  signature = nextSignature
  initMetrics.initMs = Math.round(performance.now() - initStarted)

  postReady(message.lang, message.initId)
}

async function handleSynth(message) {
  const stopped = () => cancelled.has(message.jobId)
  try {
    // Queued jobs may have been cancelled while initialization was in flight.
    if (stopped()) return
    if (!tts || !voices) {
      postError(message.lang, message.jobId, new Error('离线音色尚未初始化。'), 'not-ready')
      return
    }

    const seat = Math.max(
      0,
      Math.min(numSpeakers - 1, Math.trunc(Number(message.speakerId) || 0)),
    )
    const voiceId = voices.voice_ids[seat]
    const started = performance.now()
    let lastProgress = 0
    let lastYield = started
    let callbacksSinceYield = 0
    const result = await tts.generate(message.text, voiceId, {
      temperature: 0.8,
      topP: 0.95,
      seed: 42,
      maxNew: MAX_NEW,
      minNew: MIN_NEW,
      shouldStop: stopped,
      onProgress: async (count) => {
        // Runtime callbacks report 2, 10, 18, ... tokens, not multiples of 64.
        if (count - lastProgress >= 64) {
          lastProgress = count
          self.postMessage({ type: 'progress', jobId: message.jobId, count })
        }
        callbacksSinceYield += 1
        if (callbacksSinceYield >= 8 || performance.now() - lastYield >= 16) {
          // Promise-only ONNX steps can starve worker message events. Yield a
          // task so cancel-job/dispose-lang can reach shouldStop promptly.
          await new Promise((resolve) => setTimeout(resolve, 0))
          callbacksSinceYield = 0
          lastYield = performance.now()
        }
      },
    })

    if (stopped()) return

    const volume = Number.isFinite(message.volume)
      ? Math.max(0, Math.min(2, message.volume))
      : 1
    if (volume !== 1) {
      for (let i = 0; i < result.wav.length; i += 1) result.wav[i] *= volume
    }

    const synthMs = Math.round(performance.now() - started)
    self.postMessage(
      {
        type: 'result',
        lang: message.lang,
        epoch: message.epoch,
        jobId: message.jobId,
        samples: result.wav.buffer,
        sampleRate: result.sampleRate,
        synthMs,
      },
      [result.wav.buffer],
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    if (stopped()) return
    postError(message.lang, message.jobId, error)
  } finally {
    cancelled.delete(message.jobId)
    jobLangs.delete(message.jobId)
  }
}

self.onmessage = (event) => {
  const message = event.data
  if (!message) return

  if (message.type === 'cancel-job') {
    if (jobLangs.has(message.jobId)) cancelled.add(message.jobId)
    return
  }

  if (message.type === 'dispose-lang') {
    for (const [jobId, lang] of jobLangs) {
      if (lang === message.lang) cancelled.add(jobId)
    }
    return
  }

  if (message.type === 'dispose') {
    tts = null
    voices = null
    numSpeakers = 0
    signature = ''
    for (const jobId of jobLangs.keys()) cancelled.add(jobId)
    jobLangs.clear()
    self.postMessage({ type: 'disposed' })
    return
  }

  if (message.type === 'synth' && message.jobId) {
    jobLangs.set(message.jobId, message.lang)
  }

  // One language model shares a single KV cache; jobs must not overlap.
  chain = chain
    .then(() => {
      if (message.type === 'init') return handleInit(message)
      if (message.type === 'synth') return handleSynth(message)
      return undefined
    })
    .catch((error) => {
      if (message.type === 'init') {
        tts = null
        signature = ''
        voices = null
        numSpeakers = 0
        postError(message.lang, null, error, 'init-failed', message.initId)
      } else if (message.type === 'synth') {
        postError(message.lang, message.jobId, error)
      }
    })
}
