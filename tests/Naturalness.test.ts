import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeSpeechText } from '../src/core/text/TextNormalizer'
import { planSpeechPhrasing } from '../src/core/text/SpeechPhrasing'
import {
  overlayProtectedWords,
  preparePronunciationText,
} from '../src/core/tts/pronunciationGuard'
async function naturalness(): Promise<any> {
  return import('../scripts/lib/naturalness.mjs')
}
async function reading(): Promise<any> {
  return import('../scripts/lib/reading.mjs')
}
async function frontendSpeech(): Promise<any> {
  return import('../scripts/lib/frontendSpeech.mjs')
}

const TOY_TEXT = '甲，乙、丙；丁：戊—己…庚“辛”壬。'
// Real-WASM round12 evidence, including the three periods produced by one … .
const TOY_REAL_TOKENS = [
  'jia3', ',', 'yi3', ',', 'bing3', 'ding1', ',', 'wu4', 'ji3',
  '.', '.', '.', 'geng1', 'xin1', 'ren2', '.',
]

describe('C2 标点 token 协议（不加载 WASM）', () => {
  it('，、： 映射 comma，； 作为句界消耗，绝不生成无效 ; token', async () => {
    const n = await naturalness()
    const r = await reading()
    const assets = await r.loadMatchaAssets()
    const stream = n.buildTokenStream(TOY_TEXT, assets.effective, assets.tokens)
    expect(stream.tokens).toEqual(TOY_REAL_TOKENS)
    expect(stream.tokens).not.toContain(';')
    expect(stream.omitted).toEqual([
      { text: '；', charOffset: 5, reason: 'sentence-boundary-no-token' },
      { text: '—', charOffset: 9, reason: 'runtime-oov-skipped' },
      { text: '“', charOffset: 13, reason: 'runtime-oov-skipped' },
      { text: '”', charOffset: 15, reason: 'runtime-oov-skipped' },
    ])
    expect(n.runtimeEngineText('甲，乙、丙；丁：戊—己…庚')).toBe('甲,乙,丙;丁,戊—己...庚')
    expect(n.runtimeEngineText('你好,;:.!?')).toBe('你好,;,.!?')
    const asciiStream = n.buildTokenStream('你好,;:.!?', assets.effective, assets.tokens)
    expect(asciiStream.tokens).toEqual(['ni2', 'hao3', ',', ',', '.', '!', '?'])
    expect(asciiStream.omitted).toEqual([
      { text: ';', charOffset: 3, reason: 'sentence-boundary-no-token' },
    ])
  })

  it('原生 OOV 标点和符号按 Unicode 类别跳过且保留源边界', async () => {
    const n = await naturalness()
    const entries = new Map([['甲', 'jia3'], ['乙', 'yi3'], ['丙', 'bing3']])
    const stream = n.buildTokenStream('甲（乙）◆丙。', entries, new Set(['jia3', 'yi3', 'bing3', '.']))
    expect(stream.tokens).toEqual(['jia3', 'yi3', 'bing3', '.'])
    expect(stream.omitted).toEqual([
      { text: '（', charOffset: 1, reason: 'runtime-oov-skipped' },
      { text: '）', charOffset: 3, reason: 'runtime-oov-skipped' },
      { text: '◆', charOffset: 4, reason: 'runtime-oov-skipped' },
    ])
  })

  it('原生托管数字只记录无 token 区间，不伪造音素', async () => {
    const n = await naturalness()
    const entries = new Map([['甲', 'jia3']])
    const inventory = new Set(['jia3', '.'])
    expect(() => n.buildTokenStream('甲1。', entries, inventory)).toThrow('拒绝静默丢弃')
    const stream = n.buildTokenStream('甲1。', entries, inventory, { allowNativeManagedText: true })
    expect(stream.tokens).toEqual(['jia3', '.'])
    expect(stream.omitted).toEqual([{ text: '1', charOffset: 1, reason: 'native-managed-text' }])
  })

  it('生产 normalize 把 … 变成 ……，token 实验明确保留六个 .', async () => {
    const n = await naturalness()
    const r = await reading()
    const assets = await r.loadMatchaAssets()
    const speechText = normalizeSpeechText('我……还会回来。')
    const stream = n.buildTokenStream(speechText, assets.effective, assets.tokens)
    expect(speechText).toBe('我……还会回来。')
    expect(stream.tokens.filter((token: string) => token === '.')).toHaveLength(7)
    expect(stream.tokens.slice(1, 7)).toEqual(['.', '.', '.', '.', '.', '.'])
  })

  it('六个固定样本覆盖逗号/顿号/分号/冒号/破折号/省略号', async () => {
    const n = await naturalness()
    expect(n.C2_SAMPLES.map((sample: any) => sample.punctuation)).toEqual(['，', '、', '；', '：', '—', '…'])
    expect(n.C2_VARIANTS).toEqual([
      'legacy-text', 'frontend-text', 'runtime-tokens', 'boundary-token', 'segmented-pcm',
    ])
  })

  it('静音插入逐个列出标点后的 token 下标与字符偏移，只使用 ID7', async () => {
    const n = await naturalness()
    const r = await reading()
    const assets = await r.loadMatchaAssets()
    const text = '她在纸上写道：明天一早出发。'
    const stream = n.buildTokenStream(text, assets.effective, assets.tokens)
    const result = n.insertSilenceTokens(stream, assets.tokens)
    expect(result.insertions.map((item: any) => item.punctuation)).toEqual(['：', '。'])
    expect(result.insertions.map((item: any) => item.charOffset)).toEqual([6, 13])
    for (const insertion of result.insertions) {
      expect(stream.tokens[insertion.afterTokenIndex]).toBe(
        insertion.punctuation === '：' ? ',' : '.',
      )
      expect(result.tokens[insertion.outputTokenIndex]).toBe('"')
      expect(insertion.tokenId).toBe(7)
    }
    expect(result.tokens).toHaveLength(stream.tokens.length + 2)
  })

  it('分号/破折号没有自身 token 时，静音明确锚定到前一个有效 token', async () => {
    const n = await naturalness()
    const r = await reading()
    const assets = await r.loadMatchaAssets()
    for (const [text, punctuation] of [['雨已经停了；屋檐还在滴水。', '；'], ['他等了很久——门外终于传来脚步声。', '—']]) {
      const stream = n.buildTokenStream(text, assets.effective, assets.tokens)
      const result = n.insertSilenceTokens(stream, assets.tokens)
      expect(result.insertions.map((item: any) => item.punctuation)).toEqual([
        punctuation === '；' ? '；' : '——', '。',
      ])
      expect(result.insertions[0]).toMatchObject({
        anchor: 'source-punctuation-boundary',
        afterTokenText: punctuation === '；' ? 'le' : 'jiu3',
        tokenId: 7,
      })
      expect(result.tokens[result.insertions[0].outputTokenIndex]).toBe('"')
    }
  })

  it('连续省略号只插一个静音边界，并列出完整源区间', async () => {
    const n = await naturalness()
    const r = await reading()
    const assets = await r.loadMatchaAssets()
    const stream = n.buildTokenStream('我……还会回来。', assets.effective, assets.tokens)
    const result = n.insertSilenceTokens(stream, assets.tokens)
    expect(result.insertions.map((item: any) => item.punctuation)).toEqual(['……', '。'])
    expect(result.insertions[0]).toMatchObject({
      afterTokenIndex: 6, afterTokenText: '.', charOffset: 1, endCharOffset: 3,
    })
  })

  it('未知 token 或未知汉字直接报错，不静默丢弃', async () => {
    const n = await naturalness()
    expect(() => n.buildTokenStream('甲。', new Map([['甲', 'not-a-token']]), new Set(['.', '"'])))
      .toThrow('不存在 token')
    expect(() => n.buildTokenStream('龘。', new Map(), new Set(['.', '"'])))
      .toThrow('拒绝静默丢弃')
    expect(n.buildTokenStream('\u200b甲\u2060。', new Map([['甲', 'jia3']]), new Set(['jia3', '.'])))
      .toMatchObject({ tokens: ['jia3', '.'] })
    expect(() => n.insertSilenceTokens({ tokens: ['jia3', ','], ranges: [] }, new Set(['jia3', ','])))
      .toThrow('ID 7')
  })

  it('PCM 分段把标点留在前段、合并连续省略号、句末不加额外静音', async () => {
    const n = await naturalness()
    expect(n.planPcmSegments('甲，乙。')).toEqual([
      { text: '甲，', pauseAfterMs: 160, punctuation: '，', charOffset: 1, endCharOffset: 2 },
      { text: '乙。', pauseAfterMs: 0, punctuation: '。', charOffset: 3, endCharOffset: 4 },
    ])
    expect(n.planPcmSegments('甲……乙。')[0]).toMatchObject({
      text: '甲……', pauseAfterMs: 360, endCharOffset: 3,
    })
    expect(n.planPcmSegments('甲——乙。')[0]).toMatchObject({
      text: '甲——', pauseAfterMs: 300,
    })
  })
})

describe('C4 全因子与复现协议', () => {
  it('3x3 九格完整且文件名固定', async () => {
    const n = await naturalness()
    expect(n.parameterGrid()).toHaveLength(9)
    expect(new Set(n.PARAMETER_GRID.map((cell: any) => `${cell.noiseScale}/${cell.silenceScale}`)).size).toBe(9)
    expect(n.experimentFilename('c4-anchor', 'c4-grid', { noiseScale: 0.667, silenceScale: 1.2 }))
      .toBe('c4-anchor__c4-grid__n0.667__s1.2.wav')
    expect(n.experimentFilename('c2-comma', 'runtime-tokens')).toBe('c2-comma__runtime-tokens.wav')
  })

  it('PCM 拼接长度与采样率一致', async () => {
    const n = await naturalness()
    const joined = n.joinPcm([
      { samples: new Float32Array([1, 2]), sampleRate: 1000 },
      { samples: new Float32Array([3]), sampleRate: 1000 },
    ], { gapMs: 3 })
    expect([...joined.samples]).toEqual([1, 2, 0, 0, 0, 3])
    expect(() => n.joinPcm([
      { samples: new Float32Array(1), sampleRate: 22050 },
      { samples: new Float32Array(1), sampleRate: 16000 },
    ])).toThrow('采样率')
  })

  it('清单拒绝无效 token、哈希/参数漂移、缺失全因子和伪造听感正确率', async () => {
    const n = await naturalness()
    const item = {
      id: 'c2-comma__runtime-tokens', sampleId: 'c2-comma', variant: 'runtime-tokens',
      speechText: '甲，乙。', file: 'x.wav', wavSha256: 'a'.repeat(64), ms: 100,
      plannedConfig: { noiseScale: 0.667, silenceScale: 1 },
      actualConfig: { noiseScale: 0.667, silenceScale: 1 }, tokens: ['jia3', ',', 'yi3', '.'],
    }
    const manifest = {
      protocol: n.NATURALNESS_PROTOCOL, mode: 'smoke', items: [item],
      status: { listeningAccuracy: null },
    }
    expect(n.validateNaturalnessManifest(manifest, new Set(['jia3', ',', 'yi3', '.', '"'])))
      .toEqual([])
    expect(n.validateNaturalnessManifest({
      ...manifest,
      items: [{ ...item, variant: 'segmented-pcm', tokens: [['jia3', ','], ['yi3', '.']] }],
    }, new Set(['jia3', ',', 'yi3', '.', '"']))).toEqual([])
    expect(n.validateNaturalnessManifest({ ...manifest, mode: 'full' }, new Set(['jia3', ',', 'yi3', '.', '"'])))
      .toContain('C4 全因子缺少 0.5/0.8')
    expect(n.validateNaturalnessManifest({
      ...manifest,
      items: [{ ...item, tokens: [';'] }],
      status: { listeningAccuracy: 1 },
    }, new Set(['jia3', ',', 'yi3', '.', '"'])))
      .toEqual(expect.arrayContaining([
        'c2-comma__runtime-tokens: 无效 token ";"',
        '未评分实验不得填写 listeningAccuracy',
      ]))
  })

  it('C5 明确阻塞且待评分状态不造正确率', async () => {
    const n = await naturalness()
    expect(n.vocoderStatus()).toMatchObject({ status: 'BLOCKED', melInterface: null })
    expect(n.pendingListeningStatus('full', 39)).toMatchObject({
      status: 'FROZEN_PENDING_LISTENING', listeningAccuracy: null, raters: [],
    })
  })
})

describe('C1 生产文本链与 C3 冻结包', () => {
  it('Node 转译执行的就是生产函数，版本绑定三个 TS 源文件', async () => {
    const f = await frontendSpeech()
    const frontend = await f.loadFrontendSpeech()
    expect(frontend.normalizeSpeechText('会议定在2026年11月23日下午3:30开始。'))
      .toBe(normalizeSpeechText('会议定在2026年11月23日下午3:30开始。'))
    expect(frontend.planSpeechPhrasing('叔叔您觉得做得到吗？'))
      .toBe(planSpeechPhrasing('叔叔您觉得做得到吗？'))
    expect(frontend.version.sources['src/core/text/TextNormalizer.ts']).toMatch(/^[a-f0-9]{64}$/)
    expect(frontend.version.sources['src/core/text/SpeechPhrasing.ts']).toMatch(/^[a-f0-9]{64}$/)
    expect(frontend.version.sources['src/core/tts/pronunciationGuard.ts']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('固定 v1 语料全部 48 条逐条等于 normalize -> phrasing -> overlay guard', async () => {
    const f = await frontendSpeech()
    const r = await reading()
    const frontend = await f.loadFrontendSpeech()
    const assets = await r.loadMatchaAssets()
    expect(assets.overlayText).toEqual(expect.any(String))
    expect(overlayProtectedWords(assets.overlayText).length)
      .toBeGreaterThan(overlayProtectedWords(undefined).length)
    const corpus = readFileSync(resolve(process.cwd(), 'tests/fixtures/blind-listening.v1.jsonl'), 'utf8')
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
    expect(corpus).toHaveLength(48)
    for (const item of corpus) {
      const normalized = normalizeSpeechText(item.text)
      const planned = planSpeechPhrasing(normalized)
      const words = overlayProtectedWords(assets.overlayText)
      const expected = preparePronunciationText(planned, words)
      expect(f.prepareFrontendSpeechText(item.text, assets.overlayText, frontend)).toEqual({
        normalizedText: normalized,
        plannedText: planned,
        protectedWords: words,
        speechText: expected,
      })
    }
    const long = corpus.find((item) => item.id === 'blind-long-01')
    expect(f.prepareFrontendSpeechText(long.text, assets.overlayText, frontend).plannedText)
      .toContain('，可是')
    const number = corpus.find((item) => item.id === 'blind-number-01')
    expect(f.prepareFrontendSpeechText(number.text, assets.overlayText, frontend).normalizedText)
      .toContain('二零二六年十一月二十三日下午三点半')
  })

  it('盲听脚本接入生产链、逐 WAV 哈希、版本和 null 听感正确率', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/render-blind.mjs'), 'utf8')
    expect(source).toContain('prepareFrontendSpeechText(item.text, assets.overlayText, frontend)')
    expect(source).toContain('wavSha256: sha256File(file)')
    expect(source).toContain('normalizerVersion:')
    expect(source).toContain('phrasingVersion:')
    expect(source).toContain('overlaySha256: sha256Text(assets.overlayText)')
    expect(source).toContain('runtimeLexiconSha256: sha256File(lexiconPath)')
    expect(source).toContain('listeningAccuracy: null')
    expect(source).toContain('UTTERANCE_RESET_GAP_MS = 120')
    expect(source).toContain("'FROZEN_PENDING_LISTENING'")
  })
})
