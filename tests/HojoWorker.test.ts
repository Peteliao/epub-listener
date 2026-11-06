// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../public/workers/hojo-tts.worker.js', import.meta.url), 'utf8')
type Packet = Record<string, unknown> & { type: string }
interface GenerateOptions {
  temperature: number
  topP: number
  seed: number
  maxNew: number
  minNew: number
  shouldStop: () => boolean
  onProgress: (count: number) => Promise<void>
}

function runtime() {
  const messages: Packet[] = []
  const encoder = new TextEncoder()
  const assets = new Map([
    ['llm.onnx', new Uint8Array([11, 12])],
    ['decoder.onnx', new Uint8Array([21, 22])],
    ['fine_local.onnx', new Uint8Array([31, 32])],
    ['token_embedding.f16', new Uint8Array([0, 60])],
    ['voices.json', encoder.encode(JSON.stringify({ voice_ids: ['zh-voice', 'en-voice'] }))],
    ['tok.json', encoder.encode('{}')],
  ])
  const createSession = vi.fn(async (_bytes: Uint8Array, _options: unknown) => ({}))
  const construct = vi.fn()
  const generate = vi.fn(async (_text: string, _voice: string, _options: GenerateOptions) => ({
    wav: new Float32Array([0.25, -0.5]), sampleRate: 24000,
  }))
  const yieldTask = vi.fn((callback: () => void, ms: number) => setTimeout(callback, ms))
  const self = {
    postMessage: (message: Packet) => messages.push(message),
    onmessage: (_event: { data: Packet }) => {},
    ort: { env: { wasm: {} }, InferenceSession: { create: createSession } },
    Hojo: {
      HojoTTS: class {
        constructor(options: unknown) { construct(options) }
        generate(text: string, voice: string, options: GenerateOptions) {
          return generate(text, voice, options)
        }
      },
    },
    HojoTokenizer: class {},
  }
  const importScripts = vi.fn()
  const context = createContext({
    self, importScripts, URL, Error, TextDecoder,
    Uint8Array, Uint16Array, Float32Array, ArrayBuffer,
    performance: { now: () => 0 },
    setTimeout: yieldTask,
    caches: {
      open: async () => ({
        match: async (url: string) => {
          const bytes = assets.get(new URL(url).pathname.split('/').at(-1)!)
          return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : undefined
        },
      }),
    },
  })
  runInContext(source, context)
  const init: Packet = {
    type: 'init', engine: 'hojo', lang: 'zh', initId: 1, speakerId: 0,
    packId: 'hojo', variantId: 'full', packVersion: '1', cacheName: 'models',
    runtimeBaseUrl: 'https://example.test/runtime/', model: { warmupText: 'Never synthesize this' },
    files: [...assets].map(([name, bytes]) => ({
      name, url: `https://example.test/models/${name}`, bytes: bytes.byteLength,
    })),
  }
  return {
    messages, generate, construct, createSession, importScripts, yieldTask, init,
    send: (message: Packet) => self.onmessage({ data: message }),
    drain: () => runInContext('chain', context) as Promise<void>,
    tracking: () => runInContext('({ jobs: jobLangs.size, cancelled: cancelled.size })', context),
  }
}

type Runtime = ReturnType<typeof runtime>
function synth(jobId: string, lang = 'zh'): Packet {
  return { type: 'synth', lang, jobId, epoch: 1, text: 'Real sentence', speakerId: lang === 'en' ? 1 : 0 }
}

async function ready(worker: Runtime): Promise<void> {
  worker.send(worker.init)
  await worker.drain()
}

describe('Hojo worker', () => {
  it('reports ready after session/metadata loading without dummy generation or precision changes', async () => {
    const worker = runtime()
    await ready(worker)
    expect(worker.generate).not.toHaveBeenCalled()
    expect(worker.createSession).toHaveBeenCalledTimes(3)
    expect(worker.createSession.mock.calls.map(([bytes]) => [...bytes])).toEqual([[11, 12], [21, 22], [31, 32]])
    for (const [, options] of worker.createSession.mock.calls) {
      expect(options).toEqual({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    }
    expect(worker.construct).toHaveBeenCalledTimes(1)
    expect(worker.messages).toEqual([
      expect.objectContaining({ type: 'ready', lang: 'zh', initId: 1, sampleRate: 24000, numSpeakers: 2, warmupMs: 0 }),
    ])
  })

  it('echoes each init identity even when another language reuses the loaded model', async () => {
    const worker = runtime()
    worker.send(worker.init)
    worker.send({ ...worker.init, lang: 'en', speakerId: 1, initId: 2 })
    await worker.drain()
    expect(worker.messages.map((message) => [message.type, message.lang, message.initId])).toEqual([
      ['ready', 'zh', 1], ['ready', 'en', 2],
    ])
    expect(worker.createSession).toHaveBeenCalledTimes(3)
    expect(worker.generate).not.toHaveBeenCalled()
  })

  it('echoes failed init identity and can initialize successfully afterward', async () => {
    const worker = runtime()
    worker.send({ ...worker.init, initId: 12, files: [] })
    await worker.drain()
    expect(worker.messages[0]).toMatchObject({ type: 'error', code: 'init-failed', initId: 12, lang: 'zh' })
    worker.send({ ...worker.init, initId: 13 })
    await worker.drain()
    expect(worker.messages[1]).toMatchObject({ type: 'ready', initId: 13, warmupMs: 0 })
    expect(worker.generate).not.toHaveBeenCalled()
  })

  it('checks cancellation before not-ready and cleans skipped job tracking', async () => {
    const worker = runtime()
    worker.send(synth('cancelled-before-init'))
    worker.send({ type: 'cancel-job', jobId: 'cancelled-before-init' })
    await worker.drain()
    expect(worker.messages).toEqual([])
    expect(worker.generate).not.toHaveBeenCalled()
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })

  it('cleans not-ready jobs and ignores cancellations arriving after completion', async () => {
    const worker = runtime()
    worker.send(synth('not-ready'))
    await worker.drain()
    expect(worker.messages[0]).toMatchObject({ type: 'error', jobId: 'not-ready', code: 'not-ready' })
    worker.send({ type: 'cancel-job', jobId: 'not-ready' })
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })

  it('skips queued cancelled synthesis and drops a cancelled active result', async () => {
    const worker = runtime()
    await ready(worker)
    let finish!: (result: Awaited<ReturnType<typeof worker.generate>>) => void
    worker.generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    worker.send(synth('active'))
    worker.send(synth('queued', 'en'))
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    worker.send({ type: 'cancel-job', jobId: 'active' })
    worker.send({ type: 'cancel-job', jobId: 'queued' })
    finish({ wav: new Float32Array([1]), sampleRate: 24000 })
    await worker.drain()
    expect(worker.generate).toHaveBeenCalledTimes(1)
    expect(worker.messages.filter((message) => message.type !== 'ready')).toEqual([])
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })

  it.each(['cancel-job', 'dispose-lang', 'dispose'])('yields autoregressive microtasks so %s can interrupt active synthesis', async (type) => {
    const worker = runtime()
    await ready(worker)
    let callbacks = 0
    worker.generate.mockImplementationOnce(async (_text, _voice, options) => {
      for (let count = 2; count <= 258; count += 8) {
        callbacks += 1
        await options.onProgress(count)
        if (options.shouldStop()) {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          throw error
        }
      }
      return { wav: new Float32Array([1]), sampleRate: 24000 }
    })
    worker.send(synth('active', 'en'))
    setTimeout(() => worker.send({ type, jobId: 'active', lang: 'en' }), 0)
    await worker.drain()
    expect(callbacks).toBeLessThanOrEqual(8)
    expect(worker.yieldTask).toHaveBeenCalled()
    expect(worker.messages.filter((message) => message.type === 'result' || message.type === 'error')).toEqual([])
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })

  it('cancels only the disposed language while keeping queued work for the other language', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('english', 'en'))
    worker.send(synth('chinese', 'zh'))
    worker.send({ type: 'dispose-lang', lang: 'en' })
    await worker.drain()
    expect(worker.generate).toHaveBeenCalledTimes(1)
    expect(worker.generate.mock.calls[0]![1]).toBe('zh-voice')
    expect(worker.messages.filter((message) => message.type === 'result').map((message) => message.jobId)).toEqual(['chinese'])
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })

  it.each(['AbortError', 'Error'])('cleans tracking when generation throws %s', async (name) => {
    const worker = runtime()
    await ready(worker)
    const error = new Error('generation failed')
    error.name = name
    worker.generate.mockRejectedValueOnce(error)
    worker.send(synth('failed'))
    await worker.drain()
    expect(worker.messages.filter((message) => message.type === 'error')).toHaveLength(name === 'AbortError' ? 0 : 1)
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })

  it('emits progress at the actual callback cadence while preserving generation settings and volume', async () => {
    const worker = runtime()
    await ready(worker)
    worker.generate.mockImplementationOnce(async (_text, _voice, options) => {
      for (let count = 2; count <= 138; count += 8) await options.onProgress(count)
      return { wav: new Float32Array([0.25, -0.5]), sampleRate: 24000 }
    })
    worker.send({ ...synth('speech', 'en'), volume: 1.5 })
    await worker.drain()
    expect(worker.generate.mock.calls[0]).toEqual([
      'Real sentence', 'en-voice',
      expect.objectContaining({ temperature: 0.8, topP: 0.95, seed: 42, maxNew: 2048, minNew: 10 }),
    ])
    expect(worker.messages.filter((message) => message.type === 'progress').map((message) => message.count)).toEqual([66, 130])
    const result = worker.messages.find((message) => message.type === 'result')!
    expect(result).toMatchObject({ jobId: 'speech', lang: 'en', epoch: 1, sampleRate: 24000 })
    expect([...new Float32Array(result.samples as ArrayBuffer)]).toEqual([0.375, -0.75])
    expect(worker.tracking()).toEqual({ jobs: 0, cancelled: 0 })
  })
})
