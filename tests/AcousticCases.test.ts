import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const root = process.cwd()

async function setup() {
  const [{ loadMatchaAssets }, { loadFrontendSpeech }, cases, helpers] = await Promise.all([
    import('../scripts/lib/reading.mjs') as Promise<any>,
    import('../scripts/lib/frontendSpeech.mjs') as Promise<any>,
    import('../scripts/lib/omission.mjs') as Promise<any>,
    import('../scripts/lib/acousticCases.mjs') as Promise<any>,
  ])
  const assets = await loadMatchaAssets()
  const frontend = await loadFrontendSpeech()
  const { readFileSync } = await import('node:fs')
  const overlayText = readFileSync(join(root, 'src/core/tts/polyphones.v1.txt'), 'utf8')
  const records = cases.parseOmissionCases(readFileSync(join(root, 'src/core/tts/omissionCases.v1.jsonl'), 'utf8'))
  return { assets, frontend, overlayText, records, helpers }
}

describe('P2 acoustic case planning', () => {
  it('parses native comma and quote tokens without treating IDs as phones', async () => {
    const { parseNativeTokenLog } = await import('../scripts/lib/nativeTokens.mjs') as any
    const parsed = parseNativeTokenLog('Sentence 0 tokens: [ni3(1117), ,(2), "(7), li4(878), .(3)]')
    expect(parsed.captured).toBe(true)
    expect(parsed.tokens).toEqual(['ni3', ',', '"', 'li4', '.'])
    expect(parseNativeTokenLog('no token log').captured).toBe(false)
  })

  it('keeps the full feedback sentence and the real utterance-reset group', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0004')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const original = plan.contexts.find((context: any) => context.source === 'feedback')
    expect(original.sentence).toBe(item.sentences[0])
    expect(original.textChain.speechText).toContain('\u2060')
    expect(original.actualGroup.partIndex).toBe(1)
    expect(original.actualGroup.parts).toHaveLength(2)
    expect(original.actualGroup.text).toContain('经历')
    expect(original.fullSentenceCoverage.ok).toBe(true)
    expect(original.tokenStream.inventoryValid).toBe(true)
    expect(original.neutralDiagnostics.phones).toEqual(expect.any(Array))
    expect(original.neutralDiagnostics.phones.every((item: any) => typeof item.trained === 'boolean')).toBe(true)
    expect(original.neutralDiagnostics.untrained.every((item: any) => item.trained === false)).toBe(true)
    expect(original.variants.map((variant: any) => variant.id))
      .toEqual(['current', 'lead', 'tail', 'both', 'utterance-reset', 'segmented-pcm'])
    expect(original.target.phones).toEqual(['jing1', 'li4'])
  }, 20_000)

  it('does not mutate current tokens while planning edge variants', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0007')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const context = plan.contexts[0]
    const before = JSON.stringify(context.tokenStream.tokens)
    const current = context.variants.find((variant: any) => variant.id === 'current')
    const both = context.variants.find((variant: any) => variant.id === 'both')
    expect(current.tokens).not.toBe(both.tokens)
    expect(both.tokens.filter((token: string) => token === '"').length)
      .toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(context.tokenStream.tokens)).toBe(before)
  }, 20_000)

  it('merges punctuation-only closing quotes into PCM segments', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0008')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const segmented = plan.contexts[0].variants.find((variant: any) => variant.id === 'segmented-pcm')
    expect(segmented.comparable).toBe(true)
    expect(segmented.segments.every((segment: any) => segment.tokens.length > 0)).toBe(true)
    expect(segmented.segments.at(-1).text).toContain('”')
    const resetVariant = plan.contexts[0].variants.find((variant: any) => variant.id === 'utterance-reset')
    const reset = helpers.planUtteranceReset(resetVariant.resetText, item.word, assets)
    expect(reset.parts[0]).toBe('“')
    expect(reset.streams[0]).toBeNull()
    expect(reset.targetIndex).toBe(1)
    expect(reset.target.tokens.length).toBeGreaterThan(0)
    const { joinPcmParts, partStartsMs } = await import('../scripts/lib/alignment.mjs') as any
    const pcm = [
      { samples: new Float32Array(0), sampleRate: 1000 },
      { samples: new Float32Array([1, 2]), sampleRate: 1000 },
    ]
    expect(partStartsMs(pcm)).toEqual([0, 120])
    expect(Array.from(joinPcmParts(pcm))).toEqual([...Array(120).fill(0), 1, 2])
  }, 20_000)

  it('expands by character, offset and phone while excluding other readings', async () => {
    const { assets, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0001')
    const family = helpers.planWordFamily(item, assets)
    expect(family.words.some((entry: any) => entry.word === '占便宜')).toBe(true)
    expect(family.words.some((entry: any) => entry.word === '小便')).toBe(false)
    expect(family.words.every((entry: any) =>
      Array.from(entry.word)[item.offset] === item.char
      && entry.reading.split(/\s+/).filter((phone: string) => phone !== '"')[item.offset] === item.phone))
      .toBe(true)
  })

  it('locates family phones after a leading boundary token', async () => {
    const { helpers } = await setup()
    const assets = {
      effective: new Map([['大目标', '" da4 mu4 biao1'], ['目', 'mu4'], ['标', 'biao1']]),
      tokens: new Set(['"', 'da4', 'mu4', 'biao1', '.']),
      neutrals: new Set(),
    }
    const target = helpers.locateFamilyTarget('大目标。', { word: '目标', start: 1, end: 3 }, {
      word: '目标', offset: 0, phone: 'mu4',
    }, assets)
    expect(target.ok).toBe(true)
    expect(target.start).toBe(2)
    expect(target.tokens.slice(target.start, target.start + target.count)).toEqual(['mu4', 'biao1'])
  })

  it('locates family phones across adjacent lexicon ranges', async () => {
    const { helpers } = await setup()
    const assets = {
      effective: new Map([
        ['坚', 'jian4'], ['决不', 'jue2 bu4'], ['不留余地', 'bu4 liu2 yu2 di4'], ['留余地', 'liu2 yu2 di4'],
      ]),
      tokens: new Set(['jian4', 'jue2', 'bu4', 'liu2', 'yu2', 'di4', '.']),
      neutrals: new Set(),
    }
    const target = helpers.locateFamilyTarget('坚决不留余地。', { word: '不留余地', start: 2, end: 6 }, {
      word: '不留余地', offset: 3, phone: 'di4',
    }, assets)
    expect(target.ok).toBe(true)
    expect(target.coveredBy).toBe('决不 + 留余地')
    expect(target.tokens.slice(target.start, target.start + target.count)).toEqual(['bu4', 'liu2', 'yu2', 'di4'])
  })

  it('keeps valid nested family occurrences after offset-specific exclusions', async () => {
    const { helpers } = await setup()
    const assets = {
      effective: new Map([
        ['阿阿', 'a1 a1'], ['阿阿阿', 'a1 a1 a1'], ['木阿阿阿', 'mu4 a2 a1 a1'],
      ]),
      tokens: new Set(['a1', 'a2', 'mu4', '.']),
      neutrals: new Set(),
    }
    const c = { word: '阿阿', offset: 0, phone: 'a1' }
    const exclusions = helpers.planFamilyExclusions(c, assets)
    const occurrences = helpers.findFamilyOccurrences('木阿阿阿。', ['阿阿', '阿阿阿'], exclusions)
    expect(occurrences).toEqual([{ word: '阿阿', start: 2, end: 4 }])
    const target = helpers.locateFamilyTarget('木阿阿阿。', occurrences[0], c, assets)
    expect(target.ok).toBe(true)
    expect(target.tokens.slice(target.start, target.start + target.count)).toEqual(['a1', 'a1'])
  })

  it('fails closed on missing or mismatched native tokens', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0007')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const context = plan.contexts[0]
    expect(helpers.compareNativeTokens(context, { captured: false }).status).toBe('unmeasurable')
    const mismatch = helpers.compareNativeTokens(context, {
      captured: true, sentences: [['ni3']], tokens: ['ni3'],
    })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.reason).toContain('停止声学比较')
    context.nativeComparison = mismatch
    const manifest = {
      protocol: helpers.ACOUSTIC_CASE_PROTOCOL, mode: 'measure', listeningAccuracy: null,
      tokenInventory: [...assets.tokens], cases: [plan],
    }
    expect(helpers.validateAcousticCaseManifest(manifest).join(' ')).toContain('原生 token')
  }, 20_000)

  it('rejects forged native agreement and missing comparable measurements', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0007')
    expect(helpers.validateAcousticCase({ ...item, char: '刻' }).join(' ')).toContain('偏移不一致')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const context = plan.contexts[0]
    context.nativeComparison = {
      captured: true,
      ok: true,
      status: 'match',
      expected: context.tokenStream.tokens,
      actual: [],
      sentences: [[]],
    }
    for (const variant of context.variants) {
      variant.comparable = true
      variant.measurement = null
    }
    const errors = helpers.validateAcousticCaseManifest({
      protocol: helpers.ACOUSTIC_CASE_PROTOCOL, mode: 'measure', listeningAccuracy: null,
      tokenInventory: [...assets.tokens], cases: [plan],
    })
    expect(errors.join(' ')).toContain('可信的原生 token')
    expect(errors.join(' ')).toContain('utterance-reset 缺少有效声学测量')
    expect(errors.join(' ')).toContain('segmented-pcm 缺少有效声学测量')
  }, 20_000)

  it('rejects unsupported modes and forged incomparable variants', async () => {
    const { helpers } = await setup()
    const tokens = ['a1']
    const variants = helpers.ACOUSTIC_CASE_VARIANTS.map((id: string) => ({
      id,
      comparable: true,
      measurement: { values: [100], score: 1, states: ['normal'] },
    }))
    const context = {
      sentence: '阿。',
      actualGroup: { text: '阿。' },
      tokenStream: { tokens, sha256: helpers.sha256(JSON.stringify(tokens)), inventoryValid: true, nativeManaged: [] },
      fullSentenceCoverage: { ok: true },
      target: { word: '阿', count: 1, tokenStart: 0, tokenEnd: 1, phones: ['a1'], offset: 0, phone: 'a1' },
      variants,
      nativeComparison: {
        captured: true, ok: true, status: 'match', expected: tokens, actual: tokens, sentences: [tokens],
      },
    }
    const manifest = {
      protocol: helpers.ACOUSTIC_CASE_PROTOCOL,
      mode: 'measure-typo',
      listeningAccuracy: null,
      tokenInventory: ['a1'],
      cases: [{ id: 'forged', contexts: [context] }],
    }
    expect(helpers.validateAcousticCaseManifest(manifest)).toContain('模式无效')
    manifest.mode = 'measure'
    variants[0].comparable = false
    const reset = variants.find((variant: any) => variant.id === 'utterance-reset')
    reset.resetText = '阿。'
    reset.comparable = false
    reset.reason = ''
    expect(helpers.validateAcousticCaseManifest(manifest)).toEqual(expect.arrayContaining([
      'forged：current 可比较状态与计划不一致',
      'forged：utterance-reset 不可比较原因无效',
    ]))
    reset.reason = '目标已在组块开头，当前方案已包含等价语句重置'
    expect(helpers.validateAcousticCaseManifest(manifest)).not.toContain('forged：utterance-reset 不可比较原因无效')
  })

  it('binds measure manifests to nonempty targets, token inventory and planned variants', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const item = records.find((entry: any) => entry.id === 'om-0007')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const manifest = {
      protocol: helpers.ACOUSTIC_CASE_PROTOCOL, mode: 'structural-verify', listeningAccuracy: null,
      tokenInventory: [...assets.tokens], cases: [plan],
    }
    expect(helpers.validateAcousticCaseManifest(manifest)).toEqual([])
    expect(helpers.validateAcousticCaseManifest({ ...manifest, cases: [] })).toContain('cases 不能为空')

    const zeroTarget = structuredClone(manifest)
    zeroTarget.cases[0].contexts[0].target.count = 0
    expect(helpers.validateAcousticCaseManifest(zeroTarget).join(' ')).toContain('目标音节数无效')

    const unknownToken = structuredClone(manifest)
    const unknownContext = unknownToken.cases[0].contexts[0]
    unknownContext.tokenStream.tokens = ['not-a-token']
    unknownContext.tokenStream.sha256 = helpers.sha256(JSON.stringify(unknownContext.tokenStream.tokens))
    expect(helpers.validateAcousticCaseManifest(unknownToken).join(' ')).toContain('token 完整性未通过')

    const alteredVariant = structuredClone(manifest)
    alteredVariant.cases[0].contexts[0].variants[0].tokens.push('"')
    expect(helpers.validateAcousticCaseManifest(alteredVariant).join(' ')).toContain('current 未绑定当前 token 流')

    const forgedReset = structuredClone(manifest)
    const reset = forgedReset.cases[0].contexts[0].variants.find((variant: any) => variant.id === 'utterance-reset')
    reset.comparable = false
    reset.reason = 'x'
    expect(helpers.validateAcousticCaseManifest(forgedReset).join(' ')).toContain('utterance-reset 可比较状态与计划不一致')
  }, 20_000)

  it('stops before synthesis when native token capture fails', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const { measureContext } = await import('../scripts/audit-acoustic-cases.mjs') as any
    const item = records.find((entry: any) => entry.id === 'om-0007')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    item.assets = assets
    const synth = { generate: vi.fn(), contributions: vi.fn(), save: vi.fn() }
    await expect(measureContext(
      synth, item, plan.contexts[0], 0, { noAudio: true, lexiconPath: 'unused' },
      () => ({ captured: false, sentences: [], tokens: [] }),
    )).rejects.toThrow('原生前端未返回 token')
    expect(synth.generate).not.toHaveBeenCalled()
    expect(synth.contributions).not.toHaveBeenCalled()
    expect(synth.save).not.toHaveBeenCalled()
  }, 20_000)

  it('rejects native-managed text before probing or measuring a main case', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const { measureContext } = await import('../scripts/audit-acoustic-cases.mjs') as any
    const item = records.find((entry: any) => entry.id === 'om-0007')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    item.assets = assets
    plan.contexts[0].tokenStream.nativeManaged = [{ text: 'hello', charOffset: 0, reason: 'native-managed-text' }]
    const nativeProbe = vi.fn()
    const synth = { generate: vi.fn(), contributions: vi.fn(), save: vi.fn() }
    await expect(measureContext(
      synth, item, plan.contexts[0], 0, { noAudio: true, lexiconPath: 'unused' }, nativeProbe,
    )).rejects.toThrow('无法进行完整声学测量')
    expect(nativeProbe).not.toHaveBeenCalled()
    expect(synth.generate).not.toHaveBeenCalled()
  }, 20_000)

  it('ranks only comparable measured variants and never claims listening accuracy', async () => {
    const { helpers } = await setup()
    const { rankAcousticVariants, validateAcousticCaseManifest, ACOUSTIC_CASE_PROTOCOL } = helpers
    const variants = [
      { id: 'current', measurement: { values: [100, 100], score: 10, states: ['normal'] } },
      { id: 'lead', measurement: { values: [150, 150], score: 30, states: ['normal'] } },
      { id: 'utterance-reset', comparable: false },
      { id: 'tail', forbidden: '三字及以上词仅作诊断', measurement: { values: [300, 300], score: 100, states: ['normal'] } },
      { id: 'segmented-pcm', measurement: { values: [200, 200], score: 50, states: ['normal'] } },
    ]
    expect(rankAcousticVariants(variants).map((entry: any) => entry.id))
      .toEqual(['segmented-pcm', 'lead', 'current'])
    expect(validateAcousticCaseManifest({
      protocol: ACOUSTIC_CASE_PROTOCOL, mode: 'structural-verify', cases: [], listeningAccuracy: 1,
    })).toContain('未试听实验不得填写 listeningAccuracy')
  })
})

describe('P2 acoustic case CLI', () => {
  it('passes the structural gate for every recorded case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-acoustic-cases-'))
    try {
      const out = join(dir, 'report.json')
      const result = spawnSync(process.execPath, [
        'scripts/audit-acoustic-cases.mjs', '--verify', `--out=${out}`,
        `--summary=${join(dir, 'summary.md')}`,
      ], { cwd: root, encoding: 'utf8', timeout: 120_000 })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('9 条案例 · 0 个错误')
      const report = JSON.parse(await readFile(out, 'utf8'))
      expect(report.cases).toHaveLength(9)
      expect(report.listeningAccuracy).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('is wired into audit:all as a required structural gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-acoustic-gate-'))
    try {
      const out = join(dir, 'gates.json')
      const result = spawnSync(process.execPath, [
        'scripts/audit-all.mjs', '--only=P2 声学案例结构', `--out=${out}`,
      ], { cwd: root, encoding: 'utf8', timeout: 120_000 })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(await readFile(out, 'utf8'))
      expect(report.gates).toHaveLength(1)
      expect(report.gates[0]).toMatchObject({ name: 'P2 声学案例结构', status: 0, required: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('validates family targets beyond the acoustic measurement limit', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const { familyRegression } = await import('../scripts/audit-acoustic-cases.mjs') as any
    const item = records.find((entry: any) => entry.id === 'om-0007')
    const plan = await helpers.planAcousticCase(item, { assets, frontend, overlayText })
    const effective = new Map(assets.effective)
    effective.set('里立', 'li2 zhang3')
    Object.assign(item, {
      assets: { ...assets, effective },
      frontend: {
        ...frontend,
        overlayProtectedWords: () => [],
        preparePronunciationText: (text: string) => text,
      },
      overlayText,
    }, plan)
    const result = await familyRegression(item, { familyLimit: 1, noAudio: true, synth: null },
      '他立刻站了起来。\n里立刻站了起来。\n')
    expect(result.status).toBe('failed')
    expect(result.matchedSentences).toBe(2)
    expect(result.structuralFailures.some((failure: string) =>
      failure.includes('里立刻') && failure.includes('目标音素漂移'))).toBe(true)
  }, 20_000)

  it('discovers normalized family words without splitting a long sentence at 400 characters', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const { familyRegression } = await import('../scripts/audit-acoustic-cases.mjs') as any
    const item = records.find((entry: any) => entry.id === 'om-0007')
    Object.assign(item, await helpers.planAcousticCase(item, { assets, frontend, overlayText }), {
      assets, frontend, overlayText,
    })
    const result = await familyRegression(item, { familyLimit: 1, noAudio: true, synth: null }, [
      '立\u200b刻。', '立 刻。', `${'甲'.repeat(399)}立刻${'乙'.repeat(20)}。`,
    ].join('\n'))
    expect(result.status).toBe('structure-passed')
    expect(result.rawMatchedSentences).toBe(3)
    expect(result.matchedSentences).toBe(3)
    expect(result.structuralFailures).toEqual([])
  }, 20_000)

  it('rejects an explicitly empty corpus instead of reporting not-run', async () => {
    const { familyRegression } = await import('../scripts/audit-acoustic-cases.mjs') as any
    const result = await familyRegression({}, { familyLimit: 1, noAudio: true, synth: null }, '')
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('--corpus 为空')
    const dir = await mkdtemp(join(tmpdir(), 'shusheng-acoustic-empty-'))
    try {
      const cli = spawnSync(process.execPath, [
        'scripts/audit-acoustic-cases.mjs', '--verify', '--corpus=',
      ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
      expect(cli.status).not.toBe(0)
      expect(cli.stderr).toContain('--corpus 不能为空')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps native-managed numbers and protected word boundaries as structural evidence', async () => {
    const { assets, frontend, overlayText, records, helpers } = await setup()
    const { familyRegression } = await import('../scripts/audit-acoustic-cases.mjs') as any
    const item = records.find((entry: any) => entry.id === 'om-0008')
    Object.assign(item, await helpers.planAcousticCase(item, { assets, frontend, overlayText }), {
      assets, frontend, overlayText,
    })
    const synth = { contributions: vi.fn(), generate: vi.fn(), save: vi.fn() }
    const numeric = await familyRegression(item, { familyLimit: 1, noAudio: true, synth },
      '洪武二年（1369）出生，谢天谢地，总算松了一口气。\n')
    expect(numeric.status).toBe('structure-passed')
    expect(numeric.matchedSentences).toBe(1)
    expect(numeric.measuredSentences).toBe(0)
    expect(numeric.nativeManagedSentences).toBe(1)
    expect(numeric.measurementSkipped[0].reason).toContain('仅做结构回归')
    expect(synth.contributions).not.toHaveBeenCalled()
    const guarded = await familyRegression(item, { familyLimit: 1, noAudio: true, synth: null },
      '这样的三个人如果谈谈吃喝玩乐，估计还有用武之地，可现在他们要讨论的是谋反。\n')
    expect(guarded.status).toBe('structure-passed')
    expect(guarded.matchedSentences).toBe(1)
    expect(guarded.structuralFailures).toEqual([])
  }, 20_000)

  it('measures six variants only after real native token agreement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shusheng-acoustic-measure-'))
    try {
      const out = join(dir, 'report.json')
      const corpus = join(dir, 'book.txt')
      writeFileSync(corpus, '他谢天谢地，总算松了一口气。\n', 'utf8')
      const result = spawnSync(process.execPath, [
        'scripts/audit-acoustic-cases.mjs', '--case=om-0008', '--context-limit=1',
        `--corpus=${corpus}`, `--family-limit=1`,
        `--out=${out}`, `--summary=${join(dir, 'summary.md')}`,
        `--listening=${join(dir, 'listening.json')}`, `--audio-dir=${join(dir, 'audio')}`,
      ], { cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const report = JSON.parse(readFileSync(out, 'utf8'))
      const context = report.cases[0].contexts[0]
      expect(context.nativeComparison.status).toBe('match')
      expect(context.variants).toHaveLength(6)
      expect(context.variants.every((variant: any) => variant.measurement?.values?.length === 4)).toBe(true)
      const reset = context.variants.find((variant: any) => variant.id === 'utterance-reset')
      expect(reset.prefixDurationMs).toEqual([0, 120])
      expect(context.advisoryRanking.every((entry: any) => entry.requiresListening)).toBe(true)
      for (const variant of context.variants) {
        const wav = readFileSync(variant.audio)
        expect(wav.subarray(0, 4).toString()).toBe('RIFF')
        expect(wav.subarray(8, 12).toString()).toBe('WAVE')
        expect(wav.length).toBeGreaterThan(1000)
      }
      expect(report.cases[0].familyRegression.status).toBe('measured-advisory')
      expect(report.cases[0].familyRegression.matchedSentences).toBeGreaterThan(0)
      expect(report.cases[0].familyRegression.measuredSentences).toBe(1)
      expect(report.cases[0].familyRegression.rows[0].nativeComparison.status).toBe('match')
      const listening = JSON.parse(readFileSync(join(dir, 'listening.json'), 'utf8'))
      expect(listening.status).toBe('FROZEN_PENDING_LISTENING')
      expect(listening.items[0].preferredVariant).toBeNull()
      expect(listening.reportSha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
