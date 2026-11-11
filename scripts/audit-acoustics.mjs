#!/usr/bin/env node
// Dev-only: batch acoustic audit for the 山岚 (matcha) voice.
//
// Class A/D errors are wrong phones; class C errors have *correct* phones but
// the acoustic model swallows, merges or splits a syllable. This audit measures
// how long each syllable actually sounds (ablation: dur(seq) - dur(seq - phone))
// and A/B tests silent-boundary placements. It NEVER edits the overlay: every
// output is a suggestion with an evidence WAV and requires human confirmation.
//
// Verified facts encoded in scripts/lib/acousticScoring.mjs:
//   * >=3-character words must not get an automatic word-final boundary
//     (占便宜 pian2 162ms -> 59ms; measured on the OLD truncated token stream,
//     superseded in absolute numbers but the shape of the failure still holds).
//   * Feedback cases are rebuilt from their FULL sentence, never from a
//     hand-copied token list, and a swallowed syllable is a hard verify failure.
//   * Word-internal boundaries create an audible low-energy gap.
//   * Over 350ms on one syllable means it absorbed a neighbour.
//   * numSteps 3/5/10 has no effect on this model; it is not a tuning knob.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  ROOT,
  loadMatchaAssets,
  tokenizeSpans,
  phoneticPhones,
} from './lib/reading.mjs'
import { loadCorpus, splitSentences } from './lib/corpus.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import {
  summarizeContributions,
  chooseVariant,
} from './lib/acousticScoring.mjs'
import { sentenceCoverage } from './lib/omission.mjs'

const RULES_PATH = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const EXCEPTIONS_ASSET = resolve(ROOT, 'src/core/tts/acousticExceptions.v1.jsonl')
const OUT_PATH = resolve(ROOT, 'scripts/out/acoustics-report.json')
const SUMMARY_PATH = resolve(ROOT, 'scripts/out/acoustics-summary.md')
const EXCEPTIONS_PATH = resolve(ROOT, 'scripts/out/acoustic-exception-candidates.jsonl')
const AUDIO_DIR = resolve(ROOT, 'scripts/out/audio')
const DEFAULT_CORPUS = resolve(ROOT, 'scripts/out/ming.txt')
const PUNCT = {
  '，': ',', ',': ',', '。': '.', '.': '.', '！': '!', '!': '!',
  '？': '?', '?': '?', '；': ';', ';': ';', '、': ',', '：': ':', ':': ':',
}
const NON_PHONE = new Set(['"', ',', '.', '!', '?', ';', ':', '_'])

// Token streams captured from the real WASM front end on the 2026-11-09
// follow-up report. Using these exact sequences keeps --verify reproducible.
const VERIFY_CASES = [
  {
    word: '应立即', charCount: 3, start: 0, count: 3, currentMode: 'tail',
    class: 'boundary', source: 'feedback-20261109-36',
    tokens: ['ying1', 'li4', 'ji2', 'du4', 'guo4', 'chang2', 'jiang1', '.'],
    note: '句首重复音属分句问题（B 类）；词尾边界用于「立」嘶哑短音',
  },
  {
    // 2026-11-10：这里原先手写了一段只有 16 个 token、到「有钱人」就结束的
    // 序列，把用户反馈原句的后半句「长期地用盐不给钱」整个丢掉了。两轮 A/B
    // 都在这段假上下文上做，所以用户一直听到漏读「便」而门禁全绿。现在改为
    // 从完整反馈原句现场重建运行时 token 序列（见 resolveVerifyCase）。
    word: '占便宜', charCount: 3,
    class: 'omission', source: 'feedback-20261109-37',
    sentence: '正因如此，一些会占便宜的有钱人长期地用盐不给钱。',
    note: '完整反馈原句；完成边界在被漏读的第 2 个音素之后，不是词尾',
  },
  {
    word: '原已', charCount: 2, start: 0, count: 2, currentMode: 'none',
    class: 'frontend', source: 'feedback-20261109-38',
    tokens: ['yuan2', 'yi3', 'chu3', 'yu2', 'di1', 'chao2', 'de', 'qi3', 'yi4', 'kai1', 'shi3', 'zhuan3', 'ru4', 'gao1', 'chao2', '.'],
    note: '音素与音节时长都正常；「原原已」是短分句独立 utterance 的句首重复，转 B 类',
  },
  {
    word: '最先', charCount: 2, start: 2, count: 2, currentMode: 'tail',
    class: 'boundary', source: 'feedback-20261109-39',
    tokens: ['suo2', 'you3', 'zui4', 'xian1', 'yu2', 'zhu1', 'yuan2', 'zhang1', 'fa1', 'sheng1', '.'],
    note: '「最」被拉成长音吞掉「先」，听成一个别的音调',
  },
  {
    word: '地盘', charCount: 2, start: 7, count: 2, currentMode: 'tail',
    class: 'boundary', source: 'feedback-20261109-40',
    tokens: ['zi4', 'ji3', 'zhi3', 'shi4', 'zhan4', 'le', 'dian3', 'di4', 'pan2'],
    note: '音素 di4 一直正确，显式整词钉住防止被当作状语助词 de',
  },
  {
    word: '应天', charCount: 2, start: 0, count: 2, currentMode: 'tail',
    class: 'boundary', source: 'feedback-20261109-43', expectReview: true,
    tokens: ['ying4', 'tian1', 'jiu4', 'xiang4', 'yi2', 'ge4', 'chi4', 'luo3', 'de', 'hai2', 'zi', '.'],
    note: '词被分开朗读且「天」音不准；词尾边界让末音节完整，但实测会被拉到 453ms，需人工听音权衡',
  },
  {
    word: '上天', charCount: 2, start: 2, count: 2, currentMode: 'tail',
    class: 'boundary', source: 'feedback-20261109-44',
    tokens: ['kan4', 'lai2', 'shang4', 'tian1', 'yao4', 'pao1', 'qi4', 'zhu1', 'yuan2', 'zhang1', 'le', '.'],
    note: '「看来上 / 天要…」的断开感；「天」被前字吞并',
  },
]

function parseArgs(argv) {
  const options = {
    words: null,
    corpus: DEFAULT_CORPUS,
    out: OUT_PATH,
    summary: SUMMARY_PATH,
    exceptions: EXCEPTIONS_PATH,
    audioDir: AUDIO_DIR,
    limit: 20,
    contextChars: 10,
    noAudio: false,
    verify: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--words=')) options.words = resolve(ROOT, arg.slice(8))
    else if (arg.startsWith('--corpus=')) options.corpus = resolve(ROOT, arg.slice(9))
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--exceptions=')) options.exceptions = resolve(ROOT, arg.slice(13))
    else if (arg.startsWith('--audio-dir=')) options.audioDir = resolve(ROOT, arg.slice(12))
    else if (arg.startsWith('--limit=')) options.limit = numberOption(arg, 20)
    else if (arg.startsWith('--context-chars=')) options.contextChars = numberOption(arg, 10)
    else if (arg === '--no-audio') options.noAudio = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function numberOption(arg, fallback) {
  const value = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function printHelp() {
  console.log(`用法: node scripts/audit-acoustics.mjs [选项]

用真实 WASM 合成批量检测「音素正确但被吞音/合并/读断」的 C 类问题，并对
词尾静音边界做 A/B 选型。输出是建议 + 证据音频，绝不自动改覆盖表。

  --verify               用 2026-11-09 反馈的 7 个用例验收（完整原句由当前覆盖表现场重建）
  --words=<file>         词表：每行一个词，或 JSONL（含 word 字段）
  --corpus=<file>        从语料中取该词的真实上下文（默认 scripts/out/ming.txt）
  --limit=N              最多测 N 个词（默认 20；--verify 时截取前 N 个内置用例）
  --context-chars=N      通用扫描时目标词左右各取 N 字（默认 10，越小越快）
  --no-audio             不保存证据 WAV，加速
  --out=<file>           JSON 报告
  --summary=<file>       Markdown 摘要
  --exceptions=<file>    声学例外表候选（人工确认后合并到 src/core/tts/）
  --audio-dir=<dir>      证据 WAV 目录

约束已固化：>=3 字词禁止自动加词尾边界；词内边界永不推荐；所有建议均需
人工确认。短分句导致的句首重复属 B 类，本审计只标记、不改词典。`)
}

async function loadRulesWords() {
  const records = []
  try {
    const text = await readFile(RULES_PATH, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      try {
        const rule = JSON.parse(trimmed)
        if (rule.status === 'approved' && rule.word &&
          (rule.class === 'boundary' || rule.boundary === 'append' || rule.boundary === 'remove')) {
          records.push(rule)
        }
      } catch {
        // Ignore malformed lines; compile-overlay.mjs validates the asset.
      }
    }
  } catch {
    return []
  }
  return records
}

async function loadExceptionsAsset() {
  try {
    const text = await readFile(EXCEPTIONS_ASSET, 'utf8')
    return text.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return []
      try {
        return [JSON.parse(trimmed)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

async function loadWordList(path) {
  const text = await readFile(path, 'utf8')
  const words = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('{')) {
      try {
        const record = JSON.parse(trimmed)
        if (record.word) words.push(record)
      } catch {
        // Skip malformed JSONL lines.
      }
    } else {
      words.push({ word: trimmed.split(/\s+/)[0] })
    }
  }
  return words
}

function tokensFromSentence(sentence, effective, maxLength) {
  const spans = tokenizeSpans(sentence, effective, maxLength)
  const tokens = []
  const ranges = []
  for (const span of spans) {
    const start = tokens.length
    const reading = effective.get(span.word)
    if (reading) {
      for (const phone of reading.split(/\s+/)) if (phone) tokens.push(phone)
    } else if (PUNCT[span.word]) {
      tokens.push(PUNCT[span.word])
    }
    if (tokens.length > start) {
      ranges.push({ word: span.word, start, end: tokens.length })
    }
  }
  return { tokens, ranges }
}

function stripBoundary(tokens, start, count) {
  // Remove every silent completion boundary that belongs to this word, whether
  // it sits at the word tail (应立即/最先) or after a swallowed middle syllable
  // (占便宜). Other words' boundaries must stay untouched.
  return tokens.filter((token, index) =>
    !(token === '"' && index >= start && index <= start + count))
}

/**
 * Rebuild a feedback verify case from its FULL sentence with the current
 * overlay. Hand-copied token lists drift and can be silently truncated: the
 * 占便宜 case lost the whole second half of the reported sentence that way.
 */
function resolveVerifyCase(item, assets) {
  if (Array.isArray(item.tokens)) return item
  if (!item.sentence) throw new Error(`${item.word} 验收用例缺少完整反馈原句`)
  const { tokens, ranges } = tokensFromSentence(
    item.sentence, assets.effective, assets.maxLength,
  )
  const range = ranges.find((entry) => entry.word === item.word)
  if (!range) throw new Error(`${item.word} 未出现在反馈原句中`)
  const reading = assets.effective.get(item.word) ?? ''
  const parts = reading.trim().split(/\s+/)
  const phones = parts.filter((phone) => phone && !NON_PHONE.has(phone))
  const boundaryAt = parts.indexOf('"')
  const currentMode = boundaryAt < 0
    ? 'none'
    : boundaryAt === parts.length - 1 ? 'tail' : 'internal'
  return {
    ...item,
    tokens,
    start: range.start,
    count: phones.length,
    currentMode,
    coverage: sentenceCoverage({ tokens }, item.sentence),
  }
}

/** A short real-text window around the word keeps synthesis fast and local. */
function contextWindow(sentence, word, radius) {
  const index = sentence.indexOf(word)
  if (index < 0) return sentence
  const from = Math.max(0, index - radius)
  const to = Math.min(sentence.length, index + word.length + radius)
  const body = sentence.slice(from, to)
    .replace(/^[^\p{Script=Han}]+/u, '')
    .replace(/[^\p{Script=Han}]+$/u, '')
  return `${body}。`
}

function buildContexts(words, effective, corpusText, radius = 10) {
  const sentences = splitSentences(corpusText)
  let maxLength = 1
  for (const word of effective.keys()) {
    maxLength = Math.max(maxLength, Array.from(word).length)
  }
  const cases = []
  for (const item of words) {
    const reading = effective.get(item.word)
    if (!reading) continue
    const phones = phoneticPhones(reading)
    if (!phones.length) continue
    let found = null
    for (const sentence of sentences) {
      if (!sentence.includes(item.word)) continue
      const window = contextWindow(sentence, item.word, radius)
      const { tokens, ranges } = tokensFromSentence(window, effective, maxLength)
      const range = ranges.find((entry) => entry.word === item.word)
      if (!range) continue
      const base = stripBoundary(tokens, range.start, phones.length)
      found = {
        tokens: base,
        start: range.start,
        count: phones.length,
        currentMode: tokens[range.end - 1] === '"' ? 'tail' : 'none',
        sentence: window,
        contextSource: 'corpus-window',
      }
      break
    }
    if (!found) {
      found = {
        tokens: [...phones, '.'],
        start: 0,
        count: phones.length,
        currentMode: /\s"$/.test(reading) ? 'tail' : 'none',
        sentence: `${item.word}。`,
        contextSource: 'carrier',
      }
    }
    cases.push({
      word: item.word,
      charCount: Array.from(item.word).length,
      class: item.class ?? 'boundary',
      source: item.source ?? 'rules',
      note: item.note ?? '',
      ...found,
    })
  }
  return cases
}

function insertAt(tokens, index, token) {
  const result = [...tokens]
  result.splice(index, 0, token)
  return result
}

function phoneIndices(tokens, start, count) {
  const indices = []
  let index = start
  while (index < tokens.length && indices.length < count) {
    if (!NON_PHONE.has(tokens[index])) indices.push(index)
    index += 1
  }
  return indices
}

function measure(synth, base, start, count, cache) {
  const key = base.tokens.join('|')
  if (cache.has(key)) return cache.get(key)
  const indices = phoneIndices(base.tokens, start, count)
  const summary = summarizeContributions(synth.contributions(base.tokens, indices))
  const value = { ...base, ...summary }
  cache.set(key, value)
  return value
}

function auditCase(synth, item) {
  const base = stripBoundary(item.tokens, item.start, item.count)
  const noneTokens = [...base]
  const tailTokens = insertAt(base, item.start + item.count, '"')
  const midTokens = item.count >= 2
    ? insertAt(base, item.start + 1, '"')
    : null
  const currentTokens = item.currentMode === 'tail' ? tailTokens
    : item.currentMode === 'internal' ? [...item.tokens]
      : noneTokens

  const cache = new Map()
  const variants = []
  const push = (mode, tokens, reason) => {
    if (!tokens) return
    // The measurement cache keys on the token sequence: when `current` equals
    // `none`/`tail` it would otherwise inherit that variant's mode.
    const measured = measure(synth, { mode, tokens, reason }, item.start, item.count, cache)
    variants.push({ ...measured, mode, reason })
  }
  push('none', noneTokens, '无词尾边界')
  push('tail', tailTokens, '词尾加静音引号')
  push('mid', midTokens, '词内静音边界（会产生低能量间隙）')
  push('current', currentTokens, '当前覆盖表配置')

  const choice = chooseVariant(variants, item.charCount)
  const current = variants.find((variant) => variant.mode === 'current')
  const flagged = current.states.filter((state) => state !== 'normal')
  return {
    word: item.word,
    charCount: item.charCount,
    class: item.class,
    source: item.source,
    note: item.note,
    sentence: item.sentence ?? null,
    contextSource: item.contextSource ?? 'unknown',
    coverage: item.coverage ?? null,
    currentMode: item.currentMode,
    baseline: {
      values: current.values,
      min: current.min,
      max: current.max,
      states: current.states,
      score: current.score,
    },
    variants: variants.map((variant) => ({
      mode: variant.mode,
      values: variant.values,
      min: variant.min,
      max: variant.max,
      score: variant.score,
      states: variant.states,
    })),
    forbiddenTail: item.charCount >= 3,
    flagged,
    recommendation: choice.recommendation,
    requiresHuman: choice.requiresHuman,
    needsListening: !choice.keep && current.max > 350,
    reason: choice.best.reason || (choice.keep
      ? '当前配置的音节时长最均衡，无需改动'
      : !choice.keep && current.max > 350
        ? `当前边界使末音节达 ${current.max}ms（>350ms 视为吞并邻音），代理指标建议去掉边界；与人工听音结论可能冲突，必须复听后决定`
        : `建议改为 ${choice.recommendation}，需人工听音确认`),
    tokens: { none: noneTokens, tail: tailTokens, current: currentTokens },
  }
}

async function saveEvidence(synth, item, index, audioDir) {
  await mkdir(audioDir, { recursive: true })
  const files = []
  for (const [label, tokens] of [
    ['current', item.tokens.current],
    ['tail', item.tokens.tail],
    ['none', item.tokens.none],
  ]) {
    const file = resolve(audioDir, `case-${String(index + 1).padStart(2, '0')}-${label}.wav`)
    synth.save(file, synth.generate(tokens))
    files.push(file)
  }
  return files
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()

  let cases
  if (options.verify) {
    cases = VERIFY_CASES.slice(0, options.limit).map((item) => {
      const resolved = resolveVerifyCase(item, assets)
      return {
        ...resolved,
        sentence: resolved.sentence ?? '内置 WASM token 序列（反馈原句）',
        contextSource: resolved.sentence ? 'full-feedback-sentence' : 'verify-tokens',
      }
    })
  } else {
    const words = options.words
      ? await loadWordList(options.words)
      : await loadRulesWords()
    let corpusText = ''
    try {
      corpusText = (await loadCorpus(options.corpus)).text
    } catch (error) {
      console.warn(`  语料不可用，改用最小载体：${error.message}`)
    }
    cases = buildContexts(
      words.slice(0, options.limit),
      assets.effective,
      corpusText,
      options.contextChars,
    )
  }
  if (!cases.length) throw new Error('没有可审计的词，请检查 --words 或规则资产')

  const synth = await createMatchaSynth()
  const results = []
  try {
    for (const [index, item] of cases.entries()) {
      const result = auditCase(synth, item)
      if (!options.noAudio) {
        result.audio = await saveEvidence(synth, result, index, options.audioDir)
      }
      results.push(result)
      console.log(`${String(index + 1).padStart(2)}/${cases.length}  ${result.word.padEnd(6)} 当前 ${result.currentMode.padEnd(4)} 贡献 ${result.baseline.values.join('/')}ms  推荐 ${result.recommendation}`)
    }
  } finally {
    synth.free()
  }

  await mkdir(dirname(options.out), { recursive: true })
  const report = {
    generatedAt: new Date().toISOString(),
    verify: options.verify,
    cases: results,
    totals: {
      cases: results.length,
      swallowed: results.filter((item) => item.flagged.includes('swallowed')).length,
      merged: results.filter((item) => item.flagged.includes('merged')).length,
      frontend: results.filter((item) => item.class === 'frontend').length,
      needsListening: results.filter((item) => item.needsListening).length,
      changesSuggested: results.filter((item) => item.recommendation !== 'keep').length,
    },
    policy: {
      minContributionMs: 100,
      maxNormalMs: 350,
      forbidTailOnThreeCharWords: true,
      wordInternalBoundaryNeverRecommended: true,
      requiresHumanConfirmation: true,
    },
  }
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(options.summary, renderSummary(report), 'utf8')
  const exceptions = results.map((item) => ({
    word: item.word,
    charCount: item.charCount,
    class: item.class,
    currentBoundary: item.currentMode,
    recommendation: item.recommendation,
    baselineMs: item.baseline.values,
    score: item.baseline.score,
    source: item.source,
    status: item.needsListening ? 'needs-review' : 'candidate',
    requiresHuman: true,
    note: item.note,
  }))
  await writeFile(
    options.exceptions,
    `# 声学例外表候选，人工听音确认后合并到 src/core/tts/acousticExceptions.v1.jsonl\n` +
      `${exceptions.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  )

  console.log(`\n报告 ${options.out}`)
  console.log(`摘要 ${options.summary}`)
  console.log(`例外表候选 ${options.exceptions}`)
  console.log(`吞音 ${report.totals.swallowed} · 合并 ${report.totals.merged} · 前端类 ${report.totals.frontend} · 建议变更 ${report.totals.changesSuggested}`)

  if (options.verify) {
    const failures = []
    const byWord = new Map(results.map((item) => [item.word, item]))
    const expectedCases = VERIFY_CASES.slice(0, cases.length)
    if (byWord.size !== expectedCases.length) failures.push('验收词未全部产出')
    for (const expected of expectedCases) {
      const actual = byWord.get(expected.word)
      if (!actual) continue
      if (expected.expectReview) {
        // 应天: the proxy metric disagrees with the human decision. The audit
        // must surface the disagreement, not silently "fix" a working row.
        if (actual.recommendation === 'keep') failures.push(`${expected.word}：过度拉长未被识别`)
        if (!actual.needsListening) failures.push(`${expected.word}：未标记需人工听音`)
      } else if (actual.recommendation !== 'keep') {
        failures.push(`${expected.word}：推荐 ${actual.recommendation}，实测应为 keep`)
      }
      // The old gate only checked `recommendation === 'keep'`. A configuration
      // with a swallowed syllable still scored "keep" (20-point margin), so a
      // listener-reported omission could pass every gate. Make syllable health
      // a hard requirement for every feedback case whose proxy metric agrees.
      if (!expected.expectReview && actual.flagged.length) {
        failures.push(`${expected.word}：当前配置仍有 ${actual.flagged.join('/')} 音节（${actual.baseline.values.join('/')}ms），不得判定为已修复`)
      }
      // Full feedback sentences must never be replaced by a truncated token list.
      if (expected.sentence) {
        if (actual.contextSource !== 'full-feedback-sentence') {
          failures.push(`${expected.word}：未从完整反馈原句重建 token 序列`)
        }
        if (!actual.coverage?.ok) {
          failures.push(`${expected.word}：反馈原句 token 覆盖不全（${actual.coverage?.phones ?? 0}/${actual.coverage?.han ?? 0} 汉字）`)
        }
      }
      if (!actual.requiresHuman) failures.push(`${expected.word}：缺少人工确认标记`)
      if (expected.charCount >= 3 && !actual.forbiddenTail) {
        failures.push(`${expected.word}：三字词未标记禁用词尾边界`)
      }
    }
    if (expectedCases.some((item) => item.word === '原已') &&
      byWord.get('原已')?.class !== 'frontend') {
      failures.push('原已 未归入 B 类前端问题')
    }

    // Keep the committed exception table in sync with the real WASM numbers.
    const exceptions = await loadExceptionsAsset()
    let checked = 0
    for (const entry of exceptions) {
      const actual = byWord.get(entry.word)
      if (!actual) continue
      checked += 1
      if (JSON.stringify(entry.baselineMs) !== JSON.stringify(actual.baseline.values)) {
        failures.push(`${entry.word}：例外表 baselineMs 与实测 ${actual.baseline.values.join('/')} 不符`)
      }
      const boundary = actual.currentMode === 'tail' ? 'append'
        : actual.currentMode === 'internal' ? 'internal' : 'none'
      if (entry.currentBoundary !== boundary) {
        failures.push(`${entry.word}：例外表边界 ${entry.currentBoundary} 与实测 ${boundary} 不符`)
      }
      const suggestion = entry.algorithmicSuggestion ?? entry.recommendation
      if (suggestion !== actual.recommendation) {
        failures.push(`${entry.word}：例外表建议 ${suggestion} 与审计 ${actual.recommendation} 不符`)
      }
    }
    console.log(`\n例外表一致性：核对 ${checked} 条`)
    console.log('\n验收（--verify）：')
    if (failures.length) {
      for (const failure of failures) console.log(`  未通过  ${failure}`)
      process.exitCode = 1
    } else {
      const reviews = results.filter((item) => item.needsListening)
      console.log(`  ${expectedCases.length}/${expectedCases.length} 通过：${expectedCases.length - reviews.length} 个词确认当前边界为 A/B 最优，${reviews.length} 个词（${reviews.map((item) => item.word).join('、') || '无'}）标记为「代理指标与人工结论冲突，需复听」`)
      console.log('  三字词禁用词尾边界、B 类归因、人工确认标记均齐备')
    }
  }
}

function renderSummary(report) {
  const lines = [
    '# 山岚声学风险审计',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 词数 ${report.totals.cases} · 吞音 ${report.totals.swallowed} · 合并 ${report.totals.merged} · 前端类 ${report.totals.frontend} · 需复听 ${report.totals.needsListening} · 建议变更 ${report.totals.changesSuggested}`,
    '',
    '> 音节贡献度 = `dur(序列) − dur(删去该音素)`。<100ms 视为被吞，>350ms 视为吞并相邻音节。',
    '> **所有建议均需人工听音确认**，脚本不会自动改写覆盖表；≥3 字词禁止自动加词尾边界。',
    '> 「需复听」表示代理指标与人工结论冲突（如应天末音节被边界拉到 453ms），必须听音后决定，不得据分数自动改表。',
    '> 贡献度随上下文变化：边界决策以 `--verify` 的反馈原句为准；通用扫描的 `corpus-window` 仅用于批量筛查。',
    '',
    '| 词 | 字数 | 类别 | 上下文 | 当前边界 | 各音节贡献 (ms) | 判定 | 推荐 | 原因 |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of report.cases) {
    lines.push(`| ${item.word} | ${item.charCount} | ${item.class} | ${item.contextSource} | ${item.currentMode} | ${item.baseline.values.join(' / ')} | ${item.baseline.states.join(' / ')} | ${item.recommendation} | ${escapeCell(item.reason)} |`)
  }
  lines.push('', '## 各边界方案得分（越高越均衡）', '')
  lines.push('| 词 | 无边界 | 词尾引号 | 词内引号 | 当前 |')
  lines.push('| --- | ---: | ---: | ---: | ---: |')
  for (const item of report.cases) {
    const score = (mode) => item.variants.find((variant) => variant.mode === mode)?.score ?? '—'
    lines.push(`| ${item.word} | ${score('none')} | ${score('tail')} | ${score('mid')} | ${score('current')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
