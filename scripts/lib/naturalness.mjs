// Pure C2/C4 experiment protocol. No WASM, filesystem, clock, or randomness.
export const NATURALNESS_PROTOCOL = 'naturalness-v1'
export const DEFAULT_SYNTH_CONFIG = Object.freeze({
  noiseScale: 0.667,
  silenceScale: 1,
  speed: 1,
})
export const NOISE_SCALES = Object.freeze([0.5, 0.667, 0.8])
export const SILENCE_SCALES = Object.freeze([0.8, 1, 1.2])
export const PARAMETER_GRID = Object.freeze(
  NOISE_SCALES.flatMap((noiseScale) =>
    SILENCE_SCALES.map((silenceScale) => Object.freeze({ noiseScale, silenceScale }))),
)
export const SILENCE_TOKEN = '"' // tokens.txt ID 7, empirically silent in Matcha.
export const C2_VARIANTS = Object.freeze([
  'legacy-text',
  'frontend-text',
  'runtime-tokens',
  'boundary-token',
  'segmented-pcm',
])

// Evidence: scripts/out/round12-punctuation-debug.log, real sherpa WASM.
// NormalizeText maps ，、： to ASCII comma and ； to an ASCII sentence boundary.
// There is NO `;` in tokens.txt: it must be consumed as a boundary, never emitted.
export const RUNTIME_PUNCTUATION = Object.freeze({
  '，': ',', ',': ',', '、': ',', '：': ',', ':': ',',
  '。': '.', '.': '.', '！': '!', '!': '!', '？': '?', '?': '?',
})
// NormalizeText changes ； to ASCII ;, then the sentence splitter consumes it.
// The real log's final IDs contain neither `;` nor a comma at that boundary.
export const RUNTIME_REPLACEMENT = Object.freeze({ ...RUNTIME_PUNCTUATION, '；': ';', ';': ';' })
export const OOV_PUNCTUATION = /[\p{P}\p{S}\p{Z}\p{C}]/u
const NATIVE_MANAGED_TEXT = /[\p{Letter}\p{Number}]/u
const HAN = /\p{Script=Han}/u
export const PCM_PAUSE_POLICY = Object.freeze({
  '，': 160,
  '、': 100,
  '；': 240,
  '：': 220,
  '—': 300,
  '…': 360,
  '。': 0,
  '！': 0,
  '？': 0,
  gapMs: 0,
})

export const C2_SAMPLES = Object.freeze([
  Object.freeze({ id: 'c2-comma', punctuation: '，', text: '山岚把信纸铺开，窗外的雨声慢慢轻了。' }),
  Object.freeze({ id: 'c2-enumeration', punctuation: '、', text: '桌上放着纸、笔、墨水和一封旧信。' }),
  Object.freeze({ id: 'c2-semicolon', punctuation: '；', text: '雨已经停了；屋檐还在滴水。' }),
  Object.freeze({ id: 'c2-colon', punctuation: '：', text: '她在纸上写道：明天一早出发。' }),
  Object.freeze({ id: 'c2-dash', punctuation: '—', text: '他等了很久——门外终于传来脚步声。' }),
  Object.freeze({ id: 'c2-ellipsis', punctuation: '…', text: '我……还会回来。' }),
])

export const C4_SAMPLES = Object.freeze([
  Object.freeze({
    id: 'c4-anchor',
    text: '山岚把信纸铺开，窗外的雨声慢慢轻了。',
    note: '短叙述句；每个 noise 初始化一次，silence 在同实例内逐格变更。',
  }),
])

export function parameterGrid() {
  return PARAMETER_GRID.map((config) => ({ ...config }))
}

/** The engine-visible punctuation replacement, before lexicon lookup. */
export function runtimeEngineText(text) {
  return String(text).replace(/[…]/gu, '...').replace(
    /[，、；：。！？,!?;:]/gu,
    (char) => RUNTIME_REPLACEMENT[char],
  )
}

function longestMatchSpans(text, entries) {
  let maxLength = 1
  for (const word of entries.keys()) {
    maxLength = Math.max(maxLength, Array.from(word).length)
  }
  const chars = Array.from(text)
  const spans = []
  let index = 0
  while (index < chars.length) {
    let matched = ''
    for (let length = Math.min(maxLength, chars.length - index); length >= 1; length -= 1) {
      const candidate = chars.slice(index, index + length).join('')
      if (entries.has(candidate)) {
        matched = candidate
        break
      }
    }
    const word = matched || chars[index]
    spans.push({ word, start: index, end: index + Array.from(word).length })
    index = spans[spans.length - 1].end
  }
  return spans
}

/**
 * Mirror the Matcha Chinese lexicon front end for these Han-only samples:
 * longest lexicon match, punctuation replacement, OOV punctuation skipped.
 * Unlike fusionRisk.mjs's historical ASCII table, commas/enumeration marks/colons
 * become comma, while full-width and ASCII semicolons emit no token.
 * Every emitted token is checked against the real tokens.txt inventory.
 */
export function buildTokenStream(text, entries, tokenInventory, options = {}) {
  const inventory = tokenInventory instanceof Set ? tokenInventory : new Set(tokenInventory)
  const tokens = []
  const ranges = []
  const omitted = []
  for (const span of longestMatchSpans(String(text), entries)) {
    const start = tokens.length
    const char = span.word
    const reading = entries.get(char)
    if (reading) {
      for (const phone of reading.split(/\s+/).filter(Boolean)) tokens.push(phone)
    } else if (char === '…') {
      tokens.push('.', '.', '.')
    } else if (char === '；' || char === ';') {
      omitted.push({ text: char, charOffset: span.start, reason: 'sentence-boundary-no-token' })
    } else if (char === '\u200b' || char === '\u2060' || char === '\u2061') {
      omitted.push({ text: char, charOffset: span.start, reason: 'word-boundary-no-token' })
    } else if (Object.hasOwn(RUNTIME_PUNCTUATION, char)) {
      tokens.push(RUNTIME_PUNCTUATION[char])
    } else if (OOV_PUNCTUATION.test(char)) {
      omitted.push({ text: char, charOffset: span.start, reason: 'runtime-oov-skipped' })
    } else if (options.allowNativeManagedText && NATIVE_MANAGED_TEXT.test(char) && !HAN.test(char)) {
      omitted.push({ text: char, charOffset: span.start, reason: 'native-managed-text' })
    } else if (!/\s/u.test(char)) {
      throw new Error(`无词典或标点规则，拒绝静默丢弃：${JSON.stringify(char)} @ ${span.start}`)
    }
    if (tokens.length > start) {
      ranges.push({
        word: char,
        start,
        end: tokens.length,
        charOffset: span.start,
        endCharOffset: span.end,
      })
    }
  }
  for (const token of tokens) {
    if (!inventory.has(token)) throw new Error(`tokens.txt 不存在 token：${JSON.stringify(token)}`)
  }
  if (!tokens.length) throw new Error('空 token 流')
  return { tokens, ranges, omitted }
}

/**
 * Explicit source-punctuation anchors. Normally ID7 follows the emitted comma
 * or period. For ； (consumed sentence boundary) and — (OOV), it follows the
 * preceding valid token; the manifest records both source and token offsets.
 * A consecutive ellipsis/dash run gets one boundary after its final token.
 */
export function insertSilenceTokens(tokenStream, tokenInventory) {
  const tokens = [...tokenStream.tokens]
  const inventory = tokenInventory instanceof Set ? tokenInventory : new Set(tokenInventory)
  if (!inventory.has(SILENCE_TOKEN)) throw new Error('tokens.txt 缺少静音边界 token ID 7')
  const anchors = []
  const emitted = tokenStream.ranges.filter((range) =>
    [',', '.', '!', '?'].includes(tokens[range.start]))
  for (const range of emitted) {
    const previous = anchors[anchors.length - 1]
    if (range.word === '…' && previous?.punctuation === '…'
      && range.charOffset <= previous.endCharOffset) {
      previous.endCharOffset = range.endCharOffset
      previous.afterTokenIndex = range.end - 1
      previous.punctuation += '…'
    } else {
      anchors.push({
        afterTokenIndex: range.start,
        charOffset: range.charOffset,
        endCharOffset: range.endCharOffset,
        punctuation: range.word,
        anchor: 'emitted-punctuation-token',
      })
    }
  }
  const omitted = tokenStream.omitted.filter((item) => ['；', ';', '—'].includes(item.text))
  for (const item of omitted) {
    if (omitted.some((other) => other.text === item.text && other.charOffset === item.charOffset - 1)) {
      continue
    }
    let endCharOffset = item.charOffset + 1
    while (omitted.some((other) => other.text === item.text && other.charOffset === endCharOffset)) {
      endCharOffset += 1
    }
    const preceding = tokenStream.ranges.filter((range) => range.charOffset < item.charOffset)
    const previousRange = preceding[preceding.length - 1]
    anchors.push({
      afterTokenIndex: previousRange ? previousRange.end - 1 : -1,
      charOffset: item.charOffset,
      endCharOffset,
      punctuation: item.text.repeat(endCharOffset - item.charOffset),
      anchor: 'source-punctuation-boundary',
    })
  }
  anchors.sort((left, right) => left.charOffset - right.charOffset)
  const insertions = anchors.map((item) => ({
    ...item,
    afterTokenText: item.afterTokenIndex >= 0 ? tokens[item.afterTokenIndex] : null,
    token: SILENCE_TOKEN,
    tokenId: 7,
  }))
  const output = []
  const byIndex = new Map(insertions.map((item) => [item.afterTokenIndex, item]))
  if (byIndex.has(-1)) {
    output.push(SILENCE_TOKEN)
    byIndex.get(-1).outputTokenIndex = 0
  }
  for (let index = 0; index < tokens.length; index += 1) {
    output.push(tokens[index])
    if (byIndex.has(index)) {
      output.push(SILENCE_TOKEN)
      byIndex.get(index).outputTokenIndex = output.length - 1
    }
  }
  return { tokens: output, insertions }
}

/**
 * Split at selected punctuation, keeping the mark with the preceding clause.
 * Consecutive ellipsis characters form one boundary (production normalization
 * turns … into ……); only internal boundaries receive added PCM silence.
 */
export function planPcmSegments(text, policy = PCM_PAUSE_POLICY) {
  const source = String(text)
  const segments = []
  let start = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (!Object.hasOwn(policy, char)) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < source.length && source[end] === char) end += 1
    const boundary = source.slice(start, end)
    const rest = source.slice(end)
    segments.push({
      text: boundary,
      pauseAfterMs: rest.trim() ? policy[char] : 0,
      punctuation: char,
      charOffset: index,
      endCharOffset: end,
    })
    start = end
    index = end
  }
  if (start < source.length) segments.push({ text: source.slice(start), pauseAfterMs: 0, punctuation: null })
  return segments.filter((segment) => segment.text.trim())
}

export function joinPcm(results, { gapMs = 0, sampleRate } = {}) {
  if (!results.length) throw new Error('不能拼接空 PCM 列表')
  const rate = sampleRate ?? results[0].sampleRate
  if (!rate || results.some((result) => result.sampleRate !== rate)) {
    throw new Error('PCM 采样率不一致')
  }
  const gap = Math.max(0, Math.round(rate * gapMs / 1000))
  const samples = new Float32Array(
    results.reduce((sum, result) => sum + result.samples.length, 0)
      + gap * Math.max(0, results.length - 1),
  )
  let offset = 0
  results.forEach((result, index) => {
    samples.set(result.samples, offset)
    offset += result.samples.length + (index < results.length - 1 ? gap : 0)
  })
  return { samples, sampleRate: rate }
}

export function experimentFilename(sampleId, variant, config = DEFAULT_SYNTH_CONFIG) {
  const parts = [sampleId, variant]
  if (variant === 'c4-grid') parts.push(`n${config.noiseScale}`, `s${config.silenceScale}`)
  return `${parts.join('__')}.wav`
}

export function vocoderStatus() {
  return {
    id: 'C5',
    status: 'BLOCKED',
    available: 'Vocos waveform vocoder only',
    melInterface: null,
    reason: '只有 Vocos，无独立 mel 输入接口；不能做声码器消融。',
    action: '保留现有模型，不下载新模型；需支持 mel 输入的引擎/接口后才能实验。',
  }
}

export function pendingListeningStatus(mode, corpusCount) {
  return {
    status: mode === 'full' ? 'FROZEN_PENDING_LISTENING' : 'SMOKE_NOT_FOR_SCORING',
    mode,
    corpusCount,
    listeningAccuracy: null,
    raters: [],
    note: '冻结包仅证明样本与协议可复现；未获得真人独立听感评分，不产生正确率或偏好结论。',
    randomWaveforms: 'noiseScale 随机采样不承诺 WAV 字节复现；承诺样本、token、参数、顺序与协议复现。',
  }
}

/** Pure structural/inventory validation used both by tests and after rendering. */
export function validateNaturalnessManifest(manifest, tokenInventory) {
  const errors = []
  const inventory = tokenInventory instanceof Set ? tokenInventory : new Set(tokenInventory)
  if (manifest?.protocol !== NATURALNESS_PROTOCOL) errors.push('protocol 不匹配')
  if (!Array.isArray(manifest?.items)) return [...errors, 'items 不是数组']
  const ids = new Set()
  for (const item of manifest.items) {
    if (ids.has(item.id)) errors.push(`重复实验 id: ${item.id}`)
    ids.add(item.id)
    if (!item.speechText) errors.push(`${item.id}: 缺少 speechText`)
    if (!/^[a-f0-9]{64}$/.test(item.wavSha256 ?? '')) errors.push(`${item.id}: WAV SHA-256 无效`)
    if (!Number.isInteger(item.ms) || item.ms <= 0) errors.push(`${item.id}: ms 无效`)
    if (!item.file?.endsWith('.wav')) errors.push(`${item.id}: 未保留 WAV`)
    const config = item.actualConfig ?? {}
    if (config.noiseScale !== item.plannedConfig?.noiseScale) errors.push(`${item.id}: noiseScale 不一致`)
    if (config.silenceScale !== item.plannedConfig?.silenceScale) errors.push(`${item.id}: silenceScale 不一致`)
    if (!Array.isArray(item.tokens)) continue
    const streams = Array.isArray(item.tokens[0]) ? item.tokens : [item.tokens]
    for (const stream of streams) {
      for (const token of stream) {
        if (!inventory.has(token)) errors.push(`${item.id}: 无效 token ${JSON.stringify(token)}`)
      }
    }
    if (item.variant === 'boundary-token') {
      const expected = insertSilenceTokens(item.tokenStream, inventory)
      if (JSON.stringify(expected.insertions) !== JSON.stringify(item.insertions)) {
        errors.push(`${item.id}: 静音插入位置与 token 流不一致`)
      }
      if (JSON.stringify(expected.tokens) !== JSON.stringify(item.tokens)) {
        errors.push(`${item.id}: 静音 token 流不一致`)
      }
    }
  }
  if (manifest.mode === 'full') {
    for (const sample of C2_SAMPLES) {
      for (const variant of C2_VARIANTS) {
        if (!manifest.items.some((item) => item.sampleId === sample.id && item.variant === variant)) {
          errors.push(`C2 缺少 ${sample.id}/${variant}`)
        }
      }
    }
    for (const config of PARAMETER_GRID) {
      const matches = manifest.items.filter((item) => item.variant === 'c4-grid'
        && item.plannedConfig?.noiseScale === config.noiseScale
        && item.plannedConfig?.silenceScale === config.silenceScale)
      if (matches.length !== C4_SAMPLES.length) errors.push(`C4 全因子缺少 ${config.noiseScale}/${config.silenceScale}`)
    }
  }
  if (manifest.status?.listeningAccuracy !== null) errors.push('未评分实验不得填写 listeningAccuracy')
  return errors
}
