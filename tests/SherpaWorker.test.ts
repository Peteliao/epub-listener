// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../public/workers/sherpa-tts.worker.js', import.meta.url), 'utf8')
const encoder = new TextEncoder()
const BASE_LEXICON = `# Static longest-match fixture
你 ni3
好 hao3
你好 ni3 hao3
学 xue2
学会计 xue2 hui4 ji4
会 hui4
会计 kuai4 ji4
重 zhong4
重庆 zhong4 qing4
银 yin2
行 xing2
银行 yin2 hang2
世 shi4
界 jie4
`
const OVERLAY = '重庆 chong2 qing4\n会计 kuai4 ji4\n'
const PATCHED_LEXICON = `${BASE_LEXICON}${OVERLAY}`
const TOKEN_SYMBOLS = [
  'ni3', 'hao3', 'xue2', 'hui4', 'ji4', 'kuai4', 'zhong4', 'chong2', 'qing4',
  'yin2', 'xing2', 'hang2', 'shi4', 'jie4', ',', '.', '!', '?', '"',
]
const TOKENS_TEXT = TOKEN_SYMBOLS.map((symbol, id) => `${symbol} ${id}`).join('\n')
const MODEL_PARTS = [
  { name: 'acoustic.onnx.part1', bytes: new Uint8Array([11]) },
  { name: 'acoustic.onnx.part2', bytes: new Uint8Array([12, 13]) },
]
const VITS_CONFIG = {
  model: 'acoustic.onnx',
  lexicon: 'lexicon.txt',
  tokens: 'tokens.txt',
  noiseScale: 0.667,
  noiseScaleW: 0.8,
  lengthScale: 1,
}

type Packet = Record<string, unknown> & { type: string }
interface CachedFile {
  name: string
  url: string
  bytes: number
  sha256: string
  parts?: CachedFile[]
}
interface GenerationConfig {
  sid: number
  speed: number
  silenceScale: number
  extra: { max_words_in_sentence: number; min_words_in_sentence: number }
  tokens?: string[][]
}
interface FrontendResult {
  supported: boolean
  tokens: string[]
  reason?: string
  index?: number
}

function runtime(options: {
  lang?: 'zh' | 'en'
  modelType?: string
  lexicon?: string
  overlay?: string
  config?: Record<string, string | number>
  ruleFsts?: string[]
  parts?: Record<string, Array<{ name: string; bytes: Uint8Array }>>
} = {}) {
  const messages: Packet[] = []
  const files = new Map<string, Uint8Array>()
  const logicalAssets = new Map<string, Uint8Array>([
    ['lexicon.txt', encoder.encode(options.lexicon ?? BASE_LEXICON)],
    ['tokens.txt', encoder.encode(TOKENS_TEXT)],
    ['acoustic.onnx', new Uint8Array([11, 12, 13])],
    ['vocoder.onnx', new Uint8Array([21, 22, 23])],
  ])
  const assets = new Map(logicalAssets)
  for (const segments of Object.values(options.parts ?? {})) {
    for (const segment of segments) assets.set(segment.name, segment.bytes)
  }
  const audio = () => ({ samples: new Float32Array([0.2, 0.1]), sampleRate: 22050 })
  const generateWithConfig = vi.fn((_input: string, _config: GenerationConfig) => audio())
  const generate = vi.fn((_options: { text: string }) => audio())
  const instance = {
    handle: 1,
    sampleRate: 22050,
    numSpeakers: 1,
    generate,
    generateWithConfig,
    free: vi.fn(),
  }
  const createOfflineTts = vi.fn((
    _module: unknown,
    _config: { offlineTtsModelConfig: Record<string, Record<string, string | number>> },
  ) => instance)
  const module = { FS: null as unknown, HEAPF32: new Float32Array(1024) }
  const fs = {
    mkdir: vi.fn(),
    writeFile: vi.fn((path: string, content: Uint8Array | ArrayBuffer) => {
      files.set(path, content instanceof Uint8Array ? content.slice() : new Uint8Array(content))
    }),
    readFile: vi.fn((path: string) => {
      const content = files.get(path)
      if (!content) throw new Error(`Missing MEMFS file: ${path}`)
      return content
    }),
    analyzePath: vi.fn((path: string) => ({ exists: files.has(path) })),
    unlink: vi.fn((path: string) => {
      if (!files.delete(path)) throw new Error(`Missing MEMFS file: ${path}`)
    }),
  }
  module.FS = fs
  const self = {
    postMessage: (message: Packet) => messages.push(message),
    onmessage: (_event: { data: Packet }) => {},
    Module: vi.fn(async () => module),
    createOfflineTts,
    crypto: {
      getRandomValues: (view: Uint8Array) => view,
      subtle: {
        digest: async (_algorithm: string, buffer: ArrayBuffer) => {
          const digest = createHash('sha256').update(new Uint8Array(buffer)).digest()
          return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) as ArrayBuffer
        },
      },
    },
  }
  const context = createContext({
    self,
    importScripts: vi.fn(),
    URL,
    Error,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Float32Array,
    ArrayBuffer,
    performance: { now: () => 0 },
    caches: {
      open: async () => ({
        match: async (url: string) => {
          const name = new URL(url).pathname.split('/').at(-1)!
          const bytes = assets.get(name)
          if (!bytes) return undefined
          return { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }
        },
      }),
    },
  })
  runInContext(source, context)

  const lang = options.lang ?? 'zh'
  const modelType = options.modelType ?? 'matcha'
  const init: Packet = {
    type: 'init',
    lang,
    speakerId: 0,
    cacheName: 'matcha-test-cache',
    lexiconOverlay: options.overlay ?? OVERLAY,
    sampleRate: 22050,
    model: {
      type: modelType,
      warmupText: '你好。',
      config: options.config ?? {
        acousticModel: 'acoustic.onnx',
        vocoder: 'vocoder.onnx',
        lexicon: 'lexicon.txt',
        tokens: 'tokens.txt',
      },
      ruleFsts: options.ruleFsts ?? [],
    },
    files: [...logicalAssets].map(([name, bytes]) => ({
      name,
      url: `https://example.test/models/${name}`,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(options.parts?.[name]
        ? {
            parts: options.parts[name].map((part) => ({
              name: part.name,
              url: `https://example.test/models/${part.name}`,
              bytes: part.bytes.byteLength,
              sha256: createHash('sha256').update(part.bytes).digest('hex'),
            })),
          }
        : {}),
    })),
  }
  return {
    messages,
    files,
    fs,
    instance,
    createOfflineTts: self.createOfflineTts,
    generate,
    generateWithConfig,
    init,
    send: (message: Packet) => self.onmessage({ data: message }),
    drain: () => runInContext('initChain', context) as Promise<void>,
  }
}

type Runtime = ReturnType<typeof runtime>

function cachedModel(worker: Runtime): CachedFile {
  const files = worker.init.files as CachedFile[]
  return files.find((file) => file.name === 'acoustic.onnx')!
}

function synth(jobId: string, text = '你好', extra: Record<string, unknown> = {}): Packet {
  return { type: 'synth', lang: 'zh', jobId, epoch: 7, text, speakerId: 0, ...extra }
}

async function ready(worker: Runtime): Promise<void> {
  worker.send(worker.init)
  await worker.drain()
  expect(worker.messages.at(-1)).toMatchObject({ type: 'ready' })
  // Init performs one native warmup. Every synthesis assertion starts clean.
  worker.generate.mockClear()
  worker.generateWithConfig.mockClear()
}

function result(worker: Runtime, jobId: string): Packet {
  const message = worker.messages.find((item) => item.type === 'result' && item.jobId === jobId)
  expect(message, `missing result for ${jobId}`).toBeDefined()
  return message!
}

// Pure frontend golden tests: no cache, MEMFS, runtime or synthesis mocks.
const pureContext = createContext({ self: {}, TextDecoder, TextEncoder })
runInContext(source, pureContext)
function frontendWith(text: string, lexicon: string, tokensText: string): FrontendResult {
  pureContext.input = text
  pureContext.lexicon = lexicon
  pureContext.tokens = tokensText
  return runInContext(
    'matchaTextToTokens(input, createMatchaFrontend(lexicon, tokens))',
    pureContext,
  ) as FrontendResult
}
function frontend(text: string): FrontendResult {
  return frontendWith(text, PATCHED_LEXICON, TOKENS_TEXT)
}

describe('Matcha shadow frontend golden tokens', () => {
  it('uses the longest lexicon match', () => {
    expect(frontend('学会计')).toEqual({ supported: true, tokens: ['xue2', 'hui4', 'ji4'] })
    expect(frontend('重庆银行')).toEqual({
      supported: true,
      tokens: ['chong2', 'qing4', 'yin2', 'hang2'],
    })
  })

  it('forces a fresh whole-word match after U+200B', () => {
    expect(frontend('学\u200b会计')).toEqual({
      supported: true,
      tokens: ['xue2', 'kuai4', 'ji4'],
    })
    expect(frontend('重庆\u200b银行')).toEqual({
      supported: true,
      tokens: ['chong2', 'qing4', 'yin2', 'hang2'],
    })
  })

  it('maps real frontend punctuation and expands each ellipsis to three periods', () => {
    expect(frontend('你好，、；：。！？…')).toEqual({
      supported: true,
      tokens: ['ni3', 'hao3', ',', ',', ',', '.', '!', '?', '.', '.', '.'],
    })
    expect(frontend('你好,;:.!?')).toEqual({
      supported: true,
      tokens: ['ni3', 'hao3', ',', ',', '.', '!', '?'],
    })
  })

  it('trims whitespace and drops OOV punctuation/quotes without dropping text', () => {
    expect(frontend(' \t—“你好”—《》「」‘’\n')).toEqual({
      supported: true,
      tokens: ['ni3', 'hao3'],
    })
  })

  it.each(['你好龘', '你好abc', '你好2', '你好\u0301'])(
    'rejects uncovered Han/alphanumeric/mark text instead of swallowing it: %s',
    (text) => {
      expect(frontend(text)).toMatchObject({ supported: false, tokens: [] })
    },
  )

  it('rejects empty/punctuation-only input', () => {
    expect(frontend(' \t—《》')).toMatchObject({ supported: false, reason: 'empty' })
  })

  it('does not invent a token from the empty-symbol id-0 row in tokens.txt', () => {
    const inventory = runInContext(
      'createMatchaFrontend("", "  0\\nni3 1\\n")',
      pureContext,
    ) as { tokens: Set<string> }
    expect(inventory.tokens.has('0')).toBe(false)
    expect(inventory.tokens.has('ni3')).toBe(true)
  })

  it('rejects an invalid longest lexicon row instead of silently using shorter readings', () => {
    expect(frontendWith(
      '你好',
      '你 ni3\n好 hao3\n你好 ni3 unknown-phone\n',
      'ni3 1\nhao3 2\n',
    )).toMatchObject({ supported: false, reason: 'invalid-lexicon-entry' })
  })
})

describe('Sherpa worker split model files', () => {
  async function expectInitError(worker: Runtime, message: string): Promise<void> {
    worker.send(worker.init)
    await worker.drain()
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'error',
      code: 'init-failed',
      message: expect.stringContaining(message),
    })
  }

  it('reassembles verified parts before writing the logical model file', async () => {
    const worker = runtime({
      modelType: 'vits',
      config: VITS_CONFIG,
      parts: { 'acoustic.onnx': MODEL_PARTS },
    })
    await ready(worker)
    const write = worker.fs.writeFile.mock.calls.find(([path]) => path === '/models/zh/acoustic.onnx')
    expect(write).toBeDefined()
    expect([...(write![1] as Uint8Array)]).toEqual([11, 12, 13])
  })

  it('rejects a missing model part', async () => {
    const worker = runtime({
      modelType: 'vits',
      config: VITS_CONFIG,
      parts: { 'acoustic.onnx': MODEL_PARTS },
    })
    cachedModel(worker).parts![1]!.url = 'https://example.test/models/missing.part2'
    await expectInitError(worker, 'acoustic.onnx.part2 缺失')
  })

  it('rejects a model part with the wrong byte count', async () => {
    const worker = runtime({
      modelType: 'vits',
      config: VITS_CONFIG,
      parts: { 'acoustic.onnx': MODEL_PARTS },
    })
    cachedModel(worker).parts![1]!.bytes += 1
    await expectInitError(worker, 'acoustic.onnx.part2 大小不符')
  })

  it('rejects a model part with the wrong hash', async () => {
    const worker = runtime({
      modelType: 'vits',
      config: VITS_CONFIG,
      parts: { 'acoustic.onnx': MODEL_PARTS },
    })
    cachedModel(worker).parts![0]!.sha256 = '0'.repeat(64)
    await expectInitError(worker, 'acoustic.onnx.part1 校验失败')
  })

  it('rejects correctly sized parts whose merged model hash is wrong', async () => {
    const worker = runtime({
      modelType: 'vits',
      config: VITS_CONFIG,
      parts: { 'acoustic.onnx': MODEL_PARTS },
    })
    cachedModel(worker).sha256 = '0'.repeat(64)
    await expectInitError(worker, 'acoustic.onnx 校验失败')
  })
})

describe('Sherpa worker VITS packs', () => {
  it('uses the native VITS frontend without applying Matcha overlays or tokens', async () => {
    const worker = runtime({
      modelType: 'vits',
      overlay: '重庆 chong2 qing4\n',
      config: {
        model: 'acoustic.onnx',
        lexicon: 'lexicon.txt',
        tokens: 'tokens.txt',
        noiseScale: 0.667,
        noiseScaleW: 0.8,
        lengthScale: 1,
      },
    })
    await ready(worker)

    const config = worker.createOfflineTts.mock.calls[0]![1]
    expect(config.offlineTtsModelConfig.offlineTtsVitsModelConfig).toEqual({
      model: '/models/zh/acoustic.onnx',
      lexicon: '/models/zh/lexicon.txt',
      tokens: '/models/zh/tokens.txt',
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1,
    })
    expect(config.offlineTtsModelConfig).not.toHaveProperty('offlineTtsMatchaModelConfig')
    expect(new TextDecoder().decode(worker.files.get('/models/zh/lexicon.txt'))).toContain(
      '重庆 zhong4 qing4',
    )

    const text = '你好，machine learning。'
    worker.send(synth('vits-native', text, { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()
    expect(worker.generateWithConfig.mock.calls[0]![0]).toBe(text)
    expect(worker.generateWithConfig.mock.calls[0]![1]).not.toHaveProperty('tokens')
    expect(result(worker, 'vits-native')).toMatchObject({ frontend: 'native', tokenCount: null })
  })
})

describe('Sherpa worker Matcha frontend', () => {
  it('keeps the default text path byte-for-byte and reports native diagnostics', async () => {
    const worker = runtime()
    await ready(worker)
    const text = '学\u200b会计，—'
    worker.send(synth('native', text))
    await worker.drain()

    expect(worker.generateWithConfig).toHaveBeenCalledTimes(1)
    expect(worker.generateWithConfig.mock.calls[0]![0]).toBe(text)
    expect(worker.generateWithConfig.mock.calls[0]![1]).not.toHaveProperty('tokens')
    expect(result(worker, 'native')).toMatchObject({
      frontend: 'native',
      tokenCount: null,
      sampleRate: 22050,
    })
    expect(result(worker, 'native')).not.toHaveProperty('tokens')
  })

  it('keeps native U+2060 splitting and the 120ms PCM join', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('native-parts', '你好\u2060重庆'))
    await worker.drain()

    expect(worker.generateWithConfig.mock.calls.map(([input, config]) => [input, config.tokens])).toEqual([
      ['你好', undefined],
      ['重庆', undefined],
    ])
    expect(new Float32Array(result(worker, 'native-parts').samples as ArrayBuffer)).toHaveLength(2 + 2646 + 2)
  })

  it('sends shadow G2P as empty text plus a complete token sequence', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('g2p', '你好，重庆！', { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()

    expect(worker.generateWithConfig).toHaveBeenCalledTimes(1)
    expect(worker.generateWithConfig.mock.calls[0]).toEqual([
      '',
      expect.objectContaining({
        sid: 0,
        speed: 1,
        silenceScale: 1,
        tokens: [['ni3', 'hao3', ',', 'chong2', 'qing4', '!']],
        extra: { max_words_in_sentence: 1000, min_words_in_sentence: 12 },
      }),
    ])
    expect(worker.generate).not.toHaveBeenCalled()
    expect(result(worker, 'g2p')).toMatchObject({
      frontend: 'matcha-g2p-v1',
      tokenCount: 6,
    })
    expect(result(worker, 'g2p')).not.toHaveProperty('tokens')
  })

  it('pre-converts every U+2060 part and retains the 120ms join for G2P', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('g2p-parts', '你好\u2060重庆', { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()

    expect(worker.generateWithConfig.mock.calls.map(([input, config]) => [input, config.tokens])).toEqual([
      ['', [['ni3', 'hao3']]],
      ['', [['chong2', 'qing4']]],
    ])
    expect(result(worker, 'g2p-parts')).toMatchObject({
      frontend: 'matcha-g2p-v1',
      tokenCount: 4,
    })
    expect(new Float32Array(result(worker, 'g2p-parts').samples as ArrayBuffer)).toHaveLength(2 + 2646 + 2)
  })

  it('falls back the entire request to native text when any part is unsupported', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('fallback', '你好\u2060龘', { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()

    // No first-part token synthesis may happen before the second part fails.
    expect(worker.generateWithConfig.mock.calls.map(([input, config]) => [input, config.tokens])).toEqual([
      ['你好', undefined],
      ['龘', undefined],
    ])
    expect(result(worker, 'fallback')).toMatchObject({
      frontend: 'native-fallback',
      tokenCount: null,
    })
    expect(new Float32Array(result(worker, 'fallback').samples as ArrayBuffer)).toHaveLength(2 + 2646 + 2)
  })

  it('uses native fallback for an unknown frontend version', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('unknown-version', '你好', { frontendVersion: 'matcha-g2p-v99' }))
    await worker.drain()

    expect(worker.generateWithConfig.mock.calls[0]![0]).toBe('你好')
    expect(worker.generateWithConfig.mock.calls[0]![1]).not.toHaveProperty('tokens')
    expect(result(worker, 'unknown-version')).toMatchObject({
      frontend: 'native-fallback',
      tokenCount: null,
    })
  })

  it('builds G2P from the actual patched lexicon so overlay readings win', async () => {
    const worker = runtime()
    await ready(worker)
    expect(worker.files.get('/models/zh/lexicon.txt')).toBeDefined()
    const patched = new TextDecoder().decode(worker.files.get('/models/zh/lexicon.txt'))
    expect(patched).not.toContain('重庆 zhong4 qing4')
    expect(patched).toContain('重庆 chong2 qing4')

    worker.generateWithConfig.mockClear()
    worker.send(synth('overlay', '重庆', { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()
    expect(worker.generateWithConfig.mock.calls[0]![1].tokens).toEqual([['chong2', 'qing4']])
  })

  it('honors U+200B whole-word protection in the worker frontend', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('boundary', '学\u200b会计', { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()
    expect(worker.generateWithConfig.mock.calls[0]![1].tokens).toEqual([['xue2', 'kuai4', 'ji4']])
  })

  it('accepts explicit tokens as one complete sequence and ignores text/resets', async () => {
    const worker = runtime()
    await ready(worker)
    const tokens = ['ni3', 'hao3', ',']
    worker.send(synth('direct', 'ignored\u2060龘', { tokens }))
    await worker.drain()

    expect(worker.generateWithConfig).toHaveBeenCalledTimes(1)
    expect(worker.generateWithConfig.mock.calls[0]).toEqual([
      '',
      expect.objectContaining({ tokens: [tokens] }),
    ])
    expect(worker.generateWithConfig.mock.calls[0]![1].tokens![0]).not.toBe(tokens)
    expect(result(worker, 'direct')).toMatchObject({ frontend: 'tokens-direct', tokenCount: 3 })
  })

  it.each([
    { label: 'null', value: null },
    { label: 'empty array', value: [] },
    { label: 'non-array', value: 'ni3' },
    { label: 'non-string item', value: [1] },
    { label: 'empty token', value: [''] },
    { label: 'unknown token', value: ['not-a-token'] },
    { label: 'over the 8192 limit', value: new Array<string>(8193).fill('ni3') },
  ])('rejects invalid explicit tokens before generation: $label', async ({ value }) => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('invalid', '你好', { tokens: value }))
    await worker.drain()

    expect(worker.generateWithConfig).not.toHaveBeenCalled()
    expect(worker.generate).not.toHaveBeenCalled()
    expect(worker.messages.filter((message) => message.type === 'result')).toEqual([])
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'error',
      jobId: 'invalid',
      code: 'invalid-tokens',
    })
  })

  it.each([
    { label: 'non-Matcha', lang: 'zh' as const, modelType: 'vits' },
    { label: 'English Matcha', lang: 'en' as const, modelType: 'matcha' },
  ])('rejects explicit tokens for $label', async ({ lang, modelType }) => {
    const worker = runtime({ lang, modelType })
    await ready(worker)
    worker.send(synth('unsupported-tokens', '你好', { lang, tokens: ['ni3', 'hao3'] }))
    await worker.drain()

    expect(worker.generateWithConfig).not.toHaveBeenCalled()
    expect(worker.generate).not.toHaveBeenCalled()
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'error',
      jobId: 'unsupported-tokens',
      code: 'invalid-tokens',
      message: 'tokens 直输仅支持中文 Matcha 音色。',
    })
  })

  it.each([
    { label: 'non-Matcha', lang: 'zh' as const, modelType: 'vits' },
    { label: 'English Matcha', lang: 'en' as const, modelType: 'matcha' },
  ])('ignores frontend opt-in for $label', async ({ lang, modelType }) => {
    const worker = runtime({ lang, modelType })
    await ready(worker)
    worker.send(synth('ignored-frontend', '你好', { lang, frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()

    expect(worker.generateWithConfig.mock.calls[0]![0]).toBe('你好')
    expect(worker.generateWithConfig.mock.calls[0]![1]).not.toHaveProperty('tokens')
    expect(result(worker, 'ignored-frontend')).toMatchObject({
      lang,
      frontend: 'native',
      tokenCount: null,
    })
  })

  it('falls back rather than emitting an over-limit generated token sequence', async () => {
    const worker = runtime()
    await ready(worker)
    worker.send(synth('too-many', '你'.repeat(8193), { frontendVersion: 'matcha-g2p-v1' }))
    await worker.drain()

    expect(worker.generateWithConfig).toHaveBeenCalledTimes(1)
    expect(worker.generateWithConfig.mock.calls[0]![0]).toBe('你'.repeat(8193))
    expect(worker.generateWithConfig.mock.calls[0]![1]).not.toHaveProperty('tokens')
    expect(result(worker, 'too-many')).toMatchObject({ frontend: 'native-fallback', tokenCount: null })
  })
})
