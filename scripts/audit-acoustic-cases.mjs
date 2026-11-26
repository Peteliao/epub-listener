#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { createMatchaSynth, APP_MIN_WORDS_IN_SENTENCE } from './lib/matchaSynth.mjs'
import { loadFrontendSpeech, prepareFrontendSpeechText } from './lib/frontendSpeech.mjs'
import { parseOmissionCases } from './lib/omission.mjs'
import { summarizeContributions } from './lib/acousticScoring.mjs'
import { analyzeEnvelope, evaluateTarget, voicedBounds } from './lib/envelope.mjs'
import { alignPrefix, joinPcmParts, partStartsMs } from './lib/alignment.mjs'
import { auditIFinalSyllables } from './lib/vowelReduction.mjs'
import { buildRuntimeLexicon, readAsset, UTTERANCE_RESET, WORD_BOUNDARY } from './lib/wordFamily.mjs'
import { loadCorpus, splitSentences } from './lib/corpus.mjs'
import {
  ACOUSTIC_CASE_PROTOCOL, ACOUSTIC_CASE_VARIANTS, compareNativeTokens,
  findFamilyOccurrences, locateFamilyTarget, planAcousticCase, planFamilyExclusions,
  planTokenStream, planUtteranceReset, rankAcousticVariants,
  renderAcousticCaseSummary, sha256, validateAcousticCaseManifest,
} from './lib/acousticCases.mjs'
import { currentProvenance } from './lib/provenance.mjs'
import { probeNativeTokens } from './lib/nativeTokens.mjs'

const CASES = resolve(ROOT, 'src/core/tts/omissionCases.v1.jsonl')
const OUT = resolve(ROOT, 'scripts/out/acoustic-cases.json')
const SUMMARY = resolve(ROOT, 'scripts/out/acoustic-cases.md')
const LISTENING = resolve(ROOT, 'scripts/out/acoustic-cases-listening.json')
const AUDIO = resolve(ROOT, 'scripts/out/acoustic-cases-audio')

function parseArgs(argv) {
  const options = {
    verify: false, caseId: null, limit: 1, contextLimit: 0, corpus: null, familyLimit: 20,
    noAudio: false, out: OUT, summary: SUMMARY, listening: LISTENING, audioDir: AUDIO,
  }
  for (const arg of argv) {
    if (arg === '--verify') options.verify = true
    else if (arg.startsWith('--case=')) options.caseId = arg.slice(7)
    else if (arg.startsWith('--limit=')) options.limit = positive(arg.slice(8), 1)
    else if (arg.startsWith('--context-limit=')) options.contextLimit = positive(arg.slice(16), 0)
    else if (arg.startsWith('--family-limit=')) options.familyLimit = positive(arg.slice(15), 20)
    else if (arg.startsWith('--corpus=')) {
      const corpus = arg.slice(9)
      if (!corpus.trim()) throw new Error('--corpus 不能为空')
      options.corpus = resolve(ROOT, corpus)
    } else if (arg === '--no-audio') options.noAudio = true
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--listening=')) options.listening = resolve(ROOT, arg.slice(12))
    else if (arg.startsWith('--audio-dir=')) options.audioDir = resolve(ROOT, arg.slice(12))
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

function printHelp() {
  console.log(`用法: node scripts/audit-acoustic-cases.mjs [选项]

P2 统一声学案例流程。先重建完整原句、生产文本链和实际 U+2060 组块，再校验
token 覆盖与原生 Matcha token 一致性，之后比较当前/词首/词尾/双端/真实语句
重置/分段 PCM。贡献、包络、F2、轻声和字族整书回归均为 advisory，不自动改表。

  --verify               仅做全部案例的结构与 token 规划门禁（不加载 WASM）
  --case=<id>            只测指定案例
  --limit=N              最多测 N 条案例（默认 1；--verify 始终检查全部）
  --context-limit=N      每案例最多测 N 个完整上下文（默认全部；--verify 忽略）
  --corpus=<book>        整书回归语料，支持 .txt/.md/.epub/.fb2/.jsonl
  --family-limit=N       整书最多实测 N 句（默认 20）
  --no-audio             不保存证据 WAV
  --out/--summary/--listening/--audio-dir=<path>  产物路径

试听清单中的 preferredVariant、scores、notes 默认留空；只有用户亲耳试听后才能填写。
未传 --corpus 时整书回归明确记为 not-run。`)
}

function targetIndices(tokens, start, count) {
  const nonPhone = new Set(['"', ',', '.', '!', '?', ';', ':', '_'])
  const indices = []
  for (let index = start; index < tokens.length && indices.length < count; index += 1) {
    if (!nonPhone.has(tokens[index])) indices.push(index)
  }
  return indices
}

function resetTarget(context, variant) {
  return planUtteranceReset(variant.resetText, context.target.word, context.assets)
}

function concatenate(results, sampleRate, pauses = []) {
  const gap = pauses.map((ms) => Math.round(sampleRate * ms / 1000))
  const length = results.reduce((sum, result) => sum + result.samples.length, 0)
    + gap.reduce((sum, value) => sum + value, 0)
  const samples = new Float32Array(length)
  let offset = 0
  results.forEach((result, index) => {
    samples.set(result.samples, offset)
    offset += result.samples.length + (gap[index] ?? 0)
  })
  return samples
}

function targetOffsetMs(variant, context) {
  if (variant.id === 'utterance-reset') {
    const { targetIndex } = resetTarget(context, variant)
    if (targetIndex < 0 || !variant.prefixDurationMs?.length) return 0
    return variant.prefixDurationMs[targetIndex]
  }
  if (variant.id === 'segmented-pcm') return variant.targetOffsetMs ?? 0
  return 0
}

function envelopeFor(synth, audio, tokens, start, count, offsetMs = 0) {
  const prefix = start > 0 ? synth.generate(tokens.slice(0, start)) : null
  const alignment = prefix
    ? alignPrefix(prefix.samples, audio.samples, synth.sampleRate, {
      expectedMs: voicedBounds(prefix.samples, synth.sampleRate).endMs + offsetMs,
      windowMs: 500,
    })
    : { offsetMs: 0, endMs: offsetMs, correlation: 1, margin: 1, confidence: 'high', method: 'target-start' }
  const envelope = analyzeEnvelope(audio.samples, synth.sampleRate)
  const target = evaluateTarget(envelope, alignment.endMs)
  return { alignment, verdict: target.verdict, first: target.first, second: target.second, gapMs: target.gapMs }
}

async function measureVariant(synth, context, variant, cache) {
  let tokens = variant.tokens
  let start = variant.start
  let count = variant.count
  if (variant.id === 'utterance-reset') {
    const reset = resetTarget(context, variant)
    if (!reset.target) return { ...variant, comparable: false, measurement: null }
    tokens = reset.target.tokens
    start = reset.target.range.start
    count = reset.target.count
  } else if (variant.id === 'segmented-pcm') {
    const segment = variant.segments[variant.targetSegmentIndex]
    if (!segment?.range) return { ...variant, comparable: false, measurement: null }
    tokens = segment.tokens
    start = segment.range.start
    count = segment.count
  }
  const key = JSON.stringify([tokens, start, count])
  if (!cache.has(key)) {
    const values = synth.contributions(tokens, targetIndices(tokens, start, count))
    cache.set(key, summarizeContributions(values))
  }
  return {
    ...variant,
    comparable: variant.comparable !== false,
    effectiveTokens: tokens,
    effectiveStart: start,
    effectiveCount: count,
    measurement: cache.get(key),
  }
}

async function renderVariant(synth, context, variant, nativeAudio, file) {
  let audio = nativeAudio
  if (variant.id === 'utterance-reset') {
    const reset = resetTarget(context, variant)
    if (!reset.target) {
      variant.audio = null
      variant.envelope = null
      return
    }
    const rendered = reset.streams.map((stream) => stream
      ? synth.generate(stream.tokens)
      : { samples: new Float32Array(0), sampleRate: synth.sampleRate })
    variant.prefixDurationMs = partStartsMs(rendered)
    audio = { samples: joinPcmParts(rendered), sampleRate: synth.sampleRate }
  } else if (variant.id === 'segmented-pcm') {
    const segment = variant.segments[variant.targetSegmentIndex]
    if (!segment?.range) {
      variant.audio = null
      variant.envelope = null
      return
    }
    const rendered = variant.segments.map((segment) => synth.generate(segment.tokens))
    const pauses = variant.segments.map((segment, index) =>
      index < variant.segments.length - 1 ? segment.pauseAfterMs : 0)
    let offset = 0
    variant.segments.forEach((segment, index) => {
      if (index === variant.targetSegmentIndex) variant.targetOffsetMs = offset
      offset += rendered[index].samples.length / synth.sampleRate * 1000 + pauses[index]
    })
    audio = { samples: concatenate(rendered, synth.sampleRate, pauses), sampleRate: synth.sampleRate }
  } else if (variant.id !== 'current') {
    audio = synth.generate(variant.tokens)
  }
  let tokens = variant.tokens
  let start = variant.start
  let count = variant.count
  if (variant.id === 'utterance-reset') {
    const reset = resetTarget(context, variant)
    tokens = reset.target.tokens
    start = reset.target.range.start
    count = reset.target.count
  } else if (variant.id === 'segmented-pcm') {
    const segment = variant.segments[variant.targetSegmentIndex]
    tokens = segment.tokens
    start = segment.range.start
    count = segment.count
  }
  variant.audio = file
  variant.envelope = envelopeFor(synth, audio, tokens, start, count, targetOffsetMs(variant, context))
  if (file) synth.save(file, audio)
}

export async function measureContext(synth, item, context, contextIndex, options, nativeProbe = probeNativeTokens) {
  context.assets = { effective: item.assets.effective, tokens: item.assets.tokens }
  const nativeManaged = context.tokenStream?.nativeManaged ?? []
  if (nativeManaged.length) {
    throw new Error(`${item.id} ${context.sentence}：含原生托管文本 ${nativeManaged.map((entry) => JSON.stringify(entry.text)).join('')}，无法进行完整声学测量`)
  }
  const native = await nativeProbe(context.actualGroup.text, options.lexiconPath)
  context.nativeComparison = { ...compareNativeTokens(context, native), nativeDurationMs: native.durationMs }
  if (!context.nativeComparison.ok) {
    throw new Error(`${item.id} ${context.sentence}：${context.nativeComparison.reason}`)
  }
  const current = context.variants.find((variant) => variant.id === 'current')
  const nativeAudio = synth.generate(current.tokens)
  const cache = new Map()
  for (const variant of context.variants) {
    Object.assign(variant, await measureVariant(synth, context, variant, cache))
    const stem = `${item.id}-${contextIndex + 1}-${variant.id}`
    const file = options.noAudio ? null : resolve(options.audioDir, `${stem}.wav`)
    await renderVariant(synth, context, variant, nativeAudio, file)
    delete variant.audioManifestOnly
  }
  context.advisoryRanking = rankAcousticVariants(context.variants).map((variant) => ({
    id: variant.id,
    score: variant.measurement.score,
    states: variant.measurement.states,
    envelope: variant.envelope.verdict,
    forbidden: variant.forbidden,
    requiresListening: true,
  }))
  if (item.diagnostics.iFinal) {
    context.iFinal = await auditIFinalSyllables(synth, {
      word: item.word, sentence: context.sentence, contextSource: context.source,
      tokens: { current: current.tokens }, start: current.start, count: current.count,
    })
  }
  delete context.assets
  return {
    caseId: item.id,
    sentence: context.sentence,
    source: context.source,
    actualGroup: context.actualGroup,
    nativeComparison: context.nativeComparison,
    variants: context.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      audio: variant.audio,
      measurement: variant.measurement,
      envelope: variant.envelope,
      forbidden: variant.forbidden,
      comparable: variant.comparable,
    })),
    advisoryRanking: context.advisoryRanking,
    iFinal: context.iFinal ?? [],
  }
}

function stripWordBoundaryView(text) {
  const chars = []
  const offsets = []
  Array.from(String(text)).forEach((char, offset) => {
    if (char === WORD_BOUNDARY) return
    chars.push(char)
    offsets.push(offset)
  })
  return { text: chars.join(''), offsets }
}

export async function familyRegression(item, options, corpusText) {
  if (corpusText === null || corpusText === undefined) return { status: 'not-run', reason: '未提供 --corpus' }
  if (typeof corpusText !== 'string' || !corpusText.trim()) {
    return {
      status: 'failed', reason: '--corpus 为空', rawMatchedSentences: 0, excludedSentences: 0,
      matchedSentences: 0, measuredSentences: 0, nativeManagedSentences: 0,
      measurementSkipped: [], truncated: false, structuralFailures: ['--corpus 为空'], rows: [],
    }
  }
  const words = item.family.words.map((entry) => entry.word)
  const exclusions = planFamilyExclusions(item, item.assets)
  const candidates = splitSentences(corpusText, Number.POSITIVE_INFINITY).map((sentence) => ({
    sentence,
    normalizedText: item.frontend.normalizeSpeechText(sentence),
  }))
  const rawMatched = candidates.filter(({ normalizedText }) =>
    words.some((word) => normalizedText.includes(word)))
  const scoped = candidates.map(({ sentence, normalizedText }) => ({
    sentence,
    occurrences: findFamilyOccurrences(normalizedText, words, exclusions),
  })).filter((entry) => entry.occurrences.length > 0)
  const structuralRows = []
  const failures = []
  for (const { sentence, occurrences } of scoped) {
    let full
    let parts
    try {
      const prepared = prepareFrontendSpeechText(sentence, item.overlayText, item.frontend)
      full = planTokenStream(prepared.speechText, item.assets)
      parts = prepared.speechText.split(UTTERANCE_RESET).map((part) => part.trim()).filter(Boolean)
    } catch (error) {
      failures.push(`${sentence}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!full.coverage.ok) {
      failures.push(`${sentence}：完整原句 token 覆盖不全（${full.coverage.phones}/${full.coverage.han}）`)
      continue
    }
    const actual = parts.flatMap((part) => {
      const view = stripWordBoundaryView(part)
      return findFamilyOccurrences(view.text, words, exclusions).map((occurrence) => ({
        ...occurrence,
        start: view.offsets[occurrence.start],
        end: view.offsets[occurrence.end - 1] + 1,
        part,
      }))
    })
    if (actual.length !== occurrences.length) {
      failures.push(`${sentence}：字族出现次数不一致，原句 ${occurrences.length}，生产文本 ${actual.length}`)
      continue
    }
    const targets = []
    for (const occurrence of actual) {
      const target = locateFamilyTarget(occurrence.part, occurrence, item, item.assets)
      if (!target.ok) failures.push(`${sentence}：${target.reason}`)
      else targets.push(target)
    }
    if (targets.length === occurrences.length) {
      structuralRows.push({ sentence, target: targets[0], validatedOccurrences: targets.length })
    }
  }
  const nativeManagedRows = structuralRows.filter((row) => row.target.nativeManaged.length > 0)
  const measurementCandidates = structuralRows.filter((row) => row.target.nativeManaged.length === 0)
  const selected = measurementCandidates.slice(0, options.familyLimit)
  const measurementSkipped = options.synth ? nativeManagedRows.map(({ sentence, target }) => ({
    sentence,
    reason: `实际组块含原生托管文本 ${target.nativeManaged.map((item) => JSON.stringify(item.text)).join('')}，仅做结构回归`,
  })) : []
  if (options.synth && !options.noAudio) await mkdir(options.audioDir, { recursive: true })
  const rows = []
  for (const { sentence, target, validatedOccurrences } of selected) {
    if (options.synth) {
      const native = await probeNativeTokens(target.group, options.lexiconPath)
      const nativeComparison = compareNativeTokens({ tokenStream: { tokens: target.tokens } }, native)
      if (!nativeComparison.ok) {
        failures.push(`${sentence}：字族实测原生 token 不一致：${nativeComparison.reason}`)
        continue
      }
      const values = options.synth.contributions(target.tokens, targetIndices(target.tokens, target.start, target.count))
      const summary = summarizeContributions(values)
      let audio = null
      if (!options.noAudio) {
        audio = resolve(options.audioDir, `${item.id}-family-${rows.length + 1}.wav`)
        options.synth.save(audio, options.synth.generate(target.tokens))
      }
      rows.push({
        sentence,
        word: target.word,
        group: target.group,
        coveredBy: target.coveredBy,
        validatedOccurrences,
        nativeComparison,
        values,
        states: summary.states,
        score: summary.score,
        audio,
      })
    }
  }
  return {
    status: failures.length ? 'failed' : !scoped.length ? 'no-matches' : options.synth && rows.length ? 'measured-advisory' : 'structure-passed',
    rawMatchedSentences: rawMatched.length,
    excludedSentences: rawMatched.length - scoped.length,
    matchedSentences: scoped.length,
    measuredSentences: rows.length,
    nativeManagedSentences: nativeManagedRows.length,
    measurementSkipped,
    truncated: Boolean(options.synth) && measurementCandidates.length > selected.length,
    structuralFailures: failures,
    rows,
    note: '所有匹配句均验证字族目标音素；实测句再核对原生 token。原生托管数字/字母只做结构回归，不伪造完整 token 或声学测量。代理指标异常不自动判修复失败。',
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const [assets, frontend, caseText] = await Promise.all([
    loadMatchaAssets(), loadFrontendSpeech(), readFile(CASES, 'utf8'),
  ])
  const overlayText = await readAsset('src/core/tts/polyphones.v1.txt')
  let cases = parseOmissionCases(caseText)
  if (!options.verify && options.caseId) cases = cases.filter((item) => item.id === options.caseId)
  if (!options.verify) cases = cases.slice(0, options.limit)
  if (!cases.length) throw new Error('没有可审计的声学案例')
  const planned = []
  for (const item of cases) {
    const plan = await planAcousticCase(item, { assets, frontend, overlayText })
    if (!options.verify && options.contextLimit > 0) plan.contexts = plan.contexts.slice(0, options.contextLimit)
    planned.push(plan)
  }
  const manifest = {
    protocol: ACOUSTIC_CASE_PROTOCOL,
    generatedAt: new Date().toISOString(),
    mode: options.verify ? 'structural-verify' : 'measure',
    provenance: currentProvenance(),
    frontendVersion: frontend.version,
    synthConfig: { minWordsInSentence: APP_MIN_WORDS_IN_SENTENCE },
    tokenInventory: [...assets.tokens].sort(),
    variants: ACOUSTIC_CASE_VARIANTS,
    cases: planned.map((item) => ({ ...item, assets: undefined, frontend: undefined })),
    policy: {
      tokenCompletenessRequired: true,
      nativeTokenMatchRequired: true,
      contributionSwallowedMs: 100,
      contributionMergedMs: 350,
      proxyMetricsAdvisory: true,
      automaticProductionChanges: false,
    },
    listeningAccuracy: null,
  }
  if (options.verify) {
    const errors = validateAcousticCaseManifest(manifest)
    await Promise.all([mkdir(dirname(options.out), { recursive: true }), mkdir(dirname(options.summary), { recursive: true })])
    await writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(options.summary, renderAcousticCaseSummary(manifest), 'utf8')
    console.log(`P2 结构验收：${planned.length} 条案例 · ${errors.length} 个错误`)
    for (const error of errors) console.log(`  失败 ${error}`)
    console.log(`报告 ${options.out}`)
    if (errors.length) process.exitCode = 1
    return
  }

  await Promise.all([
    mkdir(dirname(options.out), { recursive: true }),
    mkdir(dirname(options.summary), { recursive: true }),
    mkdir(dirname(options.listening), { recursive: true }),
    mkdir(options.audioDir, { recursive: true }),
  ])
  const runtime = buildRuntimeLexicon({ lexiconText: assets.lexiconText, curatedText: overlayText })
  const lexiconPath = resolve(options.audioDir, '..', 'acoustic-cases-lexicon.txt')
  await writeFile(lexiconPath, runtime.patchedText, 'utf8')
  options.lexiconPath = lexiconPath
  const synth = await createMatchaSynth({ lexiconPath })
  const results = []
  const listeningItems = []
  let corpusText = null
  if (options.corpus) corpusText = (await loadCorpus(options.corpus)).text
  try {
    for (const [caseIndex, item] of planned.entries()) {
      Object.assign(item, { assets, frontend })
      const contexts = []
      for (const [contextIndex, context] of item.contexts.entries()) {
        console.log(`${caseIndex + 1}/${planned.length} ${item.id} ${context.source} ${contextIndex + 1}/${item.contexts.length}`)
        contexts.push(await measureContext(synth, item, context, contextIndex, options))
        listeningItems.push({
          caseId: item.id,
          sentence: context.sentence,
          source: context.source,
          actualGroup: context.actualGroup,
          nativeComparison: context.nativeComparison,
          advisoryRanking: context.advisoryRanking,
          variants: context.variants.map((variant) => ({
            id: variant.id, label: variant.label, audio: variant.audio,
          })),
          preferredVariant: null,
          scores: { naturalness: null, pause: null, omission: null },
          notes: '',
          status: 'pending-listening',
        })
      }
      item.familyRegression = await familyRegression(item, { ...options, synth, overlayText }, corpusText)
      if (item.familyRegression.status === 'failed') {
        throw new Error(`${item.id} 字族整书回归失败：${item.familyRegression.structuralFailures.join(' | ')}`)
      }
      delete item.assets
      delete item.frontend
      results.push(...contexts)
    }
  } finally {
    synth.free()
  }
  manifest.cases = planned
  const reportText = `${JSON.stringify(manifest, null, 2)}\n`
  const errors = validateAcousticCaseManifest(manifest)
  await writeFile(options.out, reportText, 'utf8')
  await writeFile(options.summary, renderAcousticCaseSummary(manifest), 'utf8')
  const listening = {
    protocol: `${ACOUSTIC_CASE_PROTOCOL}-listening`,
    reportSha256: sha256(reportText),
    reportFile: options.out,
    status: 'FROZEN_PENDING_LISTENING',
    listeningAccuracy: null,
    note: '代理指标只决定试听顺序；preferredVariant、scores 和 notes 必须由用户亲耳试听后填写。',
    items: listeningItems,
  }
  await writeFile(options.listening, `${JSON.stringify(listening, null, 2)}\n`, 'utf8')
  console.log(`P2 声学测量：${planned.length} 条案例 · ${results.length} 个完整上下文 · ${errors.length} 个结构错误`)
  console.log(`报告 ${options.out}\n摘要 ${options.summary}\n试听清单 ${options.listening}`)
  if (errors.length) process.exitCode = 1
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
