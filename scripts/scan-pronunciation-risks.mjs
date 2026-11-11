#!/usr/bin/env node
// Dev-only: batch pronunciation risk scanner for the 山岚 (matcha) voice.
//
// Unlike audit-polyphones.mjs (which prints the top per-word mismatches), this
// scanner produces a *risk inventory*: every mismatched character is classified,
// cross-checked against several independent sources, aggregated into a
// character/context family and ranked by frequency x severity x confidence.
//
// It only finds class A (wrong phone) and class D (data drift) risks. Acoustic
// problems (swallowed/duplicated syllables) have correct phones and are handled
// by the acoustic audit, not here. Never imported by the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pinyin } from 'pinyin-pro'
import {
  ROOT,
  loadMatchaAssets,
  tokenizeSpans,
  phoneticPhones,
} from './lib/reading.mjs'
import { loadCorpus, splitSentences, makeContext } from './lib/corpus.mjs'

const GOLDEN_PATH = resolve(ROOT, 'tests/fixtures/pronunciation-golden.jsonl')
const RULES_PATH = resolve(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const DEFAULT_OUT = resolve(ROOT, 'scripts/out/pronunciation-risks.jsonl')
const DEFAULT_SUMMARY = resolve(ROOT, 'scripts/out/pronunciation-risks.md')
const HAN = /\p{Script=Han}/u
const HAN_WORD = /^\p{Script=Han}+$/u
const PINYIN_OPTS = { toneType: 'num', v: true }
const SEVERITY = { syllable: 3, tone: 2, neutral: 1, expected: 3 }
// A score of zero for reviews would collapse the ranking; they stay far below
// confirmed/likely candidates but can still be ordered by frequency/severity.
const CONFIDENCE_FACTOR = { confirmed: 1, likely: 0.6, review: 0.15 }
// pinyin-pro regularly gives these particles a full tone where the curated
// table (and the acoustic model) use a neutral one. Mismatches on them are
// reference-source errors, never auto-generated fixes.
const NEUTRAL_PARTICLES = new Set(Array.from('的地得了着过们子头上下来去里'))

// Sentences from the 2026-11-09 follow-up report. --verify injects them so the
// scanner's recall can be measured even when no corpus file is available.
const VERIFY_SENTENCES = [
  '千军易得，一将难求。',
  '而是率意而为，打到哪儿算哪儿。',
  '他向朱元璋建议，应立即度过长江。',
  '正因如此，一些会占便宜的有钱人长期地用盐不给钱。',
  '重新壮大自己，原已处于低潮的起义开始转入高潮。',
  '陈友谅还没有完全掌控天完国的政权，所有最先于朱元璋发生冲突的是张士诚。',
  '朱元璋对张士诚极为头疼，自己只是占了点地盘。',
  '看来上天要抛弃朱元璋了。',
  '天平被攻破了，应天就像一个赤裸的孩子。',
]
// Simulated human feedback: one confirmed reading per item is enough to find
// every matching position in the whole book (the batching payoff).
const VERIFY_EXPECTATIONS = [
  { char: '得', expected: 'de2', word: '易得', sample: '千军易得' },
  { char: '率', expected: 'shuai4', word: '率意', sample: '率意而为' },
  { char: '为', expected: 'wei2', word: '而为', sample: '率意而为' },
]

function parseArgs(argv) {
  const files = []
  const options = {
    baseline: false,
    verify: false,
    top: 50,
    out: DEFAULT_OUT,
    summary: DEFAULT_SUMMARY,
    feedback: null,
    rules: RULES_PATH,
    limit: 0,
    expect: [],
  }
  for (const arg of argv) {
    if (arg === '--baseline') options.baseline = true
    else if (arg === '--verify') options.verify = true
    else if (arg.startsWith('--top=')) options.top = numberOption(arg, 50)
    else if (arg.startsWith('--limit-sentences=')) options.limit = numberOption(arg, 0)
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--feedback=')) options.feedback = resolve(ROOT, arg.slice(11))
    else if (arg.startsWith('--rules=')) options.rules = resolve(ROOT, arg.slice(8))
    else if (arg.startsWith('--expect=')) options.expect.push(arg.slice(9))
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('--')) files.push(arg)
  }
  return { files, options }
}

function numberOption(arg, fallback) {
  const value = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

function printHelp() {
  console.log(`用法: node scripts/scan-pronunciation-risks.mjs [语料...] [选项]

批量扫描全书，输出按「字族 × 语境」聚合、带置信度与优先级的读音风险清单。
语料支持 .txt/.md/.epub/.fb2/.jsonl（导出的读音反馈）。未指定时使用
scripts/out/ming.txt，找不到则用 public/sample.epub。

  --baseline            只把基础词典当作当前读音（模拟修复前，用于验收发现能力）
  --verify              注入 2026-11-09 反馈句并校验召回（隐含 --baseline）
  --feedback=<file>     反馈 JSONL，用户标注的 expectedPinyin 作为人工确认源
  --expect=字:音素[@词] 追加一条人工期望，可重复；带 @词 时只影响该词，
                        否则统计该字全书影响面并标记需人工确认
  --rules=<file>        规则资产 JSONL（默认 src/core/tts/readingRules.v1.jsonl）
  --top=N               摘要表格条数（默认 50）
  --limit-sentences=N   只扫描前 N 句，便于快速迭代（0 = 全部）
  --out=<file>          JSONL 风险清单（默认 scripts/out/pronunciation-risks.jsonl）
  --summary=<file>      Markdown 摘要（默认 scripts/out/pronunciation-risks.md）

本扫描只覆盖「音素选错 / 数据漂移」；音素正确但被吞音、重复、读断的声学问题
不在本清单内，由声学审计单独处理。`)
}

function splitPhone(raw) {
  const lower = String(raw ?? '').toLowerCase().replace(/ü/g, 'v')
  const match = /^([a-z]+)([0-5])?$/.exec(lower)
  if (!match) return { base: lower, tone: null }
  const value = match[2] === undefined ? null : Number(match[2])
  return { base: match[1], tone: value === 0 || value === 5 ? null : value }
}

function phoneText(phone) {
  return `${phone.base}${phone.tone ?? ''}`
}

function isNeutral(phone) {
  return phone.tone === null
}

function explainedBySandhi(engine, reference, index) {
  const current = engine[index]
  const expected = reference[index]
  if (!current || !expected) return false
  if (current.tone === 2 && expected.tone === 3 && reference[index + 1]?.tone === 3) return true
  if (expected.tone === 2 && current.tone === 3 && engine[index + 1]?.tone === 3) return true
  return ['yi', 'bu'].includes(current.base) || ['yi', 'bu'].includes(expected.base)
}

/** Every line of the base lexicon, not just last-wins, so duplicate readings remain visible. */
function lexiconVariants(text) {
  const byWord = new Map()
  const byChar = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...raw] = trimmed.split(/\s+/)
    const phones = raw.filter((phone) => phone && phone !== '"')
    if (!word || !phones.length) continue
    const list = byWord.get(word) ?? []
    list.push(phones)
    byWord.set(word, list)
    const chars = Array.from(word)
    if (chars.length !== phones.length) continue
    for (let index = 0; index < chars.length; index += 1) {
      const counts = byChar.get(chars[index]) ?? new Map()
      counts.set(phones[index], (counts.get(phones[index]) ?? 0) + 1)
      byChar.set(chars[index], counts)
    }
  }
  return { byWord, byChar }
}

function normalizeSentence(text) {
  return String(text).replace(/[\s，。！？；：、,.!?;:"'（）()「」『』《》〈〉…—–]/g, '')
}

/** Sentences and words already labelled by a human are ground truth. */
async function loadGolden(effective, maxLength) {
  const confirmed = new Map()
  const wordPhones = new Map()
  let cases = 0
  let text
  try {
    text = await readFile(GOLDEN_PATH, 'utf8')
  } catch {
    return { confirmed, wordPhones, cases }
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!Array.isArray(record.readings)) continue
    cases += 1
    const key = normalizeSentence(record.text)
    const positions = confirmed.get(key) ?? new Map()
    const spans = tokenizeSpans(record.text, effective, maxLength)
    const seen = new Map()
    for (const [index, char] of Array.from(record.text).entries()) {
      const occurrence = (seen.get(char) ?? 0) + 1
      seen.set(char, occurrence)
      for (const [target, nth, phone] of record.readings) {
        if (target !== char || nth !== occurrence) continue
        positions.set(`${char}|${occurrence}`, phoneText(splitPhone(phone)))
        const span = spans.find((item) => index >= item.start && index < item.end)
        if (!span) continue
        const wordKey = `${span.word}|${index - span.start}`
        const phones = wordPhones.get(wordKey) ?? new Set()
        phones.add(phoneText(splitPhone(phone)))
        wordPhones.set(wordKey, phones)
      }
    }
    confirmed.set(key, positions)
  }
  return { confirmed, wordPhones, cases }
}

async function loadJsonl(path) {
  try {
    const text = await readFile(path, 'utf8')
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

/** A mark in exported feedback is the strongest possible confirmation source. */
async function loadFeedbackMarks(path) {
  const empty = { marks: new Set(), expectations: [] }
  if (!path) return empty
  const records = await loadJsonl(path)
  const marks = new Set()
  const expectations = []
  for (const record of records) {
    const text = record?.paragraph?.text
    if (typeof text !== 'string') continue
    for (const mark of Array.isArray(record?.marks) ? record.marks : []) {
      const phone = phoneText(splitPhone(mark?.expectedPinyin))
      if (!phone || !mark?.char) continue
      marks.add(`${normalizeSentence(text)}|${mark.char}|${phone}`)
      const word = typeof mark.word === 'string' && Array.from(mark.word).length >= 2
        ? mark.word
        : ''
      expectations.push({ char: mark.char, phone, word, source: 'feedback' })
    }
  }
  return { marks, expectations }
}

/** Approved rules from the P1 rule asset, if it exists. */
async function loadApprovedRules(path) {
  const empty = { byPattern: new Map(), expectations: [] }
  if (!path) return empty
  const records = await loadJsonl(path)
  const byPattern = new Map()
  const expectations = []
  for (const record of records) {
    if (record?.status !== 'approved') continue
    const pattern = String(record.pattern ?? '')
    const phone = phoneText(splitPhone(record.phone))
    if (!pattern || !phone) continue
    byPattern.set(`${pattern}|${phone}`, record.id ?? 'rule')
    const char = Array.from(pattern)[0]
    if (char) {
      expectations.push({
        char,
        phone,
        word: Array.from(pattern).length >= 2 ? pattern : '',
        source: 'rule',
      })
    }
  }
  return { byPattern, expectations }
}

function parseExpectArgs(list) {
  const expectations = []
  for (const raw of list) {
    const match = /^(\p{Script=Han}):([a-z]+[0-5]?)(?:@(\p{Script=Han}+))?$/u.exec(raw)
    if (!match) throw new Error(`--expect 格式无效：${raw}（应为 字:音素[@词]）`)
    expectations.push({
      char: match[1],
      phone: match[2],
      word: match[3] ?? '',
      source: 'cli',
    })
  }
  return expectations
}

function classify(current, expected) {
  if (current.base === expected.base && current.tone === expected.tone) return null
  if (current.base !== expected.base) return 'syllable'
  if (isNeutral(current) || isNeutral(expected)) return 'neutral'
  return 'tone'
}

function confidenceOf({ char, word, offset, currentText, expectedText, sources, votes }) {
  const result = (level, reason, backed = false) => ({ level, reason, backed })
  if (!votes.tokens.has(expectedText)) return result('review', '模型中不存在该音素')
  const human = sources.includes('feedback') || sources.includes('rule')
  if (human) return result('confirmed', '人工确认', true)
  // Only a *duplicate line for the same word / single character* backs the
  // expected reading. "The character appears with that phone somewhere else in
  // the lexicon" is too weak: it made 应 ying1→ying4 a false positive because
  // pinyin-pro reads 应立即 as ying4.
  const wordLines = votes.byWord.get(word) ?? []
  const charLines = votes.byWord.get(char) ?? []
  if (
    wordLines.some((line) => line[offset] === expectedText) ||
    charLines.some((line) => line[0] === expectedText)
  ) {
    return result('confirmed', '词典重复行提供期望读音', true)
  }
  if (sources.includes('polyphonic') && currentText === votes.defaultReading(char)) {
    return result('likely', '多音字命中单字兜底')
  }
  return result('review', '参考读音来源不足或可能误报')
}

function buildSuggestion(span, offset, expectedText, reading, word) {
  if (Array.from(word).length < 2) {
    return { type: 'family-rule', text: `${Array.from(word)[0]} → ${expectedText}（按词族，不生成单字条目）` }
  }
  const phones = phoneticPhones(reading)
  if (phones.length !== Array.from(word).length) {
    return { type: 'review', text: '词条音素数与字数不一致' }
  }
  phones[offset] = expectedText
  return { type: 'overlay-line', text: `${word} ${phones.join(' ')}` }
}

async function main() {
  const { files, options } = parseArgs(process.argv.slice(2))
  const verify = options.verify
  const baseline = options.baseline || verify

  const assets = await loadMatchaAssets()
  const effective = baseline ? assets.lexicon : assets.effective
  const variants = lexiconVariants(assets.lexiconText)
  const golden = baseline
    ? { confirmed: new Map(), wordPhones: new Map(), cases: 0 }
    : await loadGolden(effective, assets.maxLength)
  const feedback = await loadFeedbackMarks(options.feedback)
  const rules = await loadApprovedRules(options.rules)
  const expectations = [
    ...feedback.expectations,
    ...rules.expectations,
    ...parseExpectArgs(options.expect),
    ...(verify ? VERIFY_EXPECTATIONS.map((item) => ({
      char: item.char,
      phone: item.expected,
      word: item.word,
      source: 'verify',
    })) : []),
  ].map((item, index) => ({ ...item, id: `e${index}` }))
  const expectationsByChar = new Map()
  for (const item of expectations) {
    const list = expectationsByChar.get(item.char) ?? []
    list.push(item)
    expectationsByChar.set(item.char, list)
  }
  const expectImpact = new Map(
    expectations.map((item) => [item.id, { ...item, local: 0, family: 0, samples: [] }]),
  )
  const suggestionCache = new Map()

  const corpora = []
  let corpusPaths = files.length ? files : ['scripts/out/ming.txt', 'public/sample.epub']
  if (verify) corpusPaths = files
  for (const path of corpusPaths) {
    try {
      const corpus = await loadCorpus(resolve(ROOT, path))
      if (corpus.text.trim()) corpora.push(corpus)
      if (!files.length) break // first readable default wins
    } catch (error) {
      if (files.length) console.warn(`  跳过语料 ${path}: ${error.message}`)
    }
  }
  if (verify) {
    corpora.push({
      path: '内置反馈句（2026-11-09）',
      sections: 1,
      chars: VERIFY_SENTENCES.join('').length,
      text: VERIFY_SENTENCES.join('\n'),
    })
  }
  if (!corpora.length) {
    throw new Error('没有可读语料，请用 --help 查看输入格式')
  }

  const defaultCache = new Map()
  const polyphonicCache = new Map()
  const votes = {
    tokens: assets.tokens,
    byChar: variants.byChar,
    byWord: variants.byWord,
    defaultReading: (char) => {
      if (!defaultCache.has(char)) {
        try {
          const readings = pinyin(char, { ...PINYIN_OPTS, type: 'array', multiple: true })
          defaultCache.set(char, phoneText(splitPhone(readings[0])))
        } catch {
          defaultCache.set(char, '')
        }
      }
      return defaultCache.get(char)
    },
    isPolyphonic: (char) => {
      if (!polyphonicCache.has(char)) {
        try {
          const readings = new Set(
            pinyin(char, { ...PINYIN_OPTS, type: 'array', multiple: true })
              .map((item) => phoneText(splitPhone(item))),
          )
          polyphonicCache.set(char, readings.size > 1)
        } catch {
          polyphonicCache.set(char, false)
        }
      }
      return polyphonicCache.get(char)
    },
  }

  const risks = new Map()
  const fallback = new Map()
  const stats = {
    corpora: corpora.map((item) => ({ path: item.path, chars: item.chars })),
    sentences: 0,
    spans: 0,
    mismatches: 0,
    expectMatches: 0,
    goldenSkipped: 0,
    curatedSkipped: 0,
    misaligned: 0,
    fallbackSpans: 0,
  }

  /** A confirmed expectation can be compiled into a whole-word overlay line. */
  function expectationSuggestion(exp) {
    if (!exp.word) {
      return { type: 'family-rule', text: `${exp.char} → ${exp.phone}（未指定词，需人工给出适用语境）` }
    }
    if (suggestionCache.has(exp.id)) return suggestionCache.get(exp.id)
    let suggestion
    try {
      const phones = pinyin(exp.word, { ...PINYIN_OPTS, type: 'array' })
        .map((item) => phoneText(splitPhone(item)))
      const offset = Array.from(exp.word).indexOf(exp.char)
      if (phones.length === Array.from(exp.word).length && offset >= 0) {
        phones[offset] = exp.phone
        suggestion = { type: 'overlay-line', text: `${exp.word} ${phones.join(' ')}` }
      } else {
        suggestion = { type: 'review', text: `无法为「${exp.word}」生成整词读音` }
      }
    } catch {
      suggestion = { type: 'review', text: `无法解析「${exp.word}」读音` }
    }
    suggestionCache.set(exp.id, suggestion)
    return suggestion
  }

  function recordExpectation(exp, currentText, span, offset, sentence, chars, index) {
    const impact = expectImpact.get(exp.id)
    const window = chars.slice(Math.max(0, index - 4), index + 5).join('')
    const local = Boolean(exp.word) && window.includes(exp.word)
    const context = makeContext(sentence, index, index + 1)
    if (local) impact.local += 1
    else impact.family += 1
    if (impact.samples.length < 3 && !impact.samples.includes(context)) {
      impact.samples.push(context)
    }
    if (!local || !assets.tokens.has(exp.phone)) return
    stats.expectMatches += 1
    const pattern = `${exp.word ?? span.word}@${offset}`
    const key = `expected|${exp.char}|${currentText}|${exp.phone}|${pattern}`
    let risk = risks.get(key)
    if (!risk) {
      risk = {
        family: exp.char,
        word: exp.word ?? span.word,
        pattern,
        current: currentText,
        expected: exp.phone,
        kind: 'expected',
        severity: SEVERITY.expected,
        confidence: 'confirmed',
        reason: `人工期望（${exp.source}）`,
        sources: [exp.source],
        suggestion: expectationSuggestion(exp),
        count: 0,
        evidence: [],
      }
      risks.set(key, risk)
    }
    risk.count += 1
    if (risk.evidence.length < 3 && !risk.evidence.includes(context)) {
      risk.evidence.push(context)
    }
  }

  for (const corpus of corpora) {
    const sentences = splitSentences(corpus.text)
    for (const sentence of sentences) {
      if (options.limit && stats.sentences >= options.limit) break
      stats.sentences += 1
      const chars = Array.from(sentence)
      let alignment
      try {
        alignment = pinyin(sentence, { ...PINYIN_OPTS, type: 'all' })
      } catch {
        continue
      }
      if (alignment.length !== chars.length) {
        stats.misaligned += 1
        continue
      }
      const normalized = normalizeSentence(sentence)
      const goldenPositions = golden.confirmed.get(normalized)
      const occurrence = new Map()
      const spans = tokenizeSpans(sentence, effective, assets.maxLength)

      for (const span of spans) {
        if (!HAN_WORD.test(span.word)) continue
        stats.spans += 1
        const wordChars = Array.from(span.word)
        const reading = effective.get(span.word)
        if (!reading) continue
        const currentPhones = phoneticPhones(reading)
        if (currentPhones.length !== wordChars.length) continue
        if (wordChars.length === 1) {
          stats.fallbackSpans += 1
          const char = wordChars[0]
          const counts = fallback.get(char) ?? { char, count: 0, reading: currentPhones[0], samples: [] }
          counts.count += 1
          if (counts.samples.length < 2) counts.samples.push(makeContext(sentence, span.start, span.end))
          fallback.set(char, counts)
        }

        const engine = currentPhones.map(splitPhone)
        const reference = []
        for (let index = span.start; index < span.end; index += 1) {
          const item = alignment[index]
          reference.push(item?.isZh && item.pinyin ? splitPhone(item.pinyin) : null)
        }

        for (let index = span.start; index < span.end; index += 1) {
          const char = chars[index]
          if (!HAN.test(char)) continue
          const seen = (occurrence.get(char) ?? 0) + 1
          occurrence.set(char, seen)
          const offset = index - span.start
          const current = engine[offset]
          const expected = reference[offset]
          if (!current) continue
          const currentText = phoneText(current)

          // 1) Human expectations run BEFORE the reference comparison. This is
          // what finds 率 lv4→shuai4 / 为 wei4→wei2, where pinyin-pro agrees
          // with the wrong dictionary reading. One confirmation scans the book.
          for (const exp of expectationsByChar.get(char) ?? []) {
            if (exp.phone === currentText) continue
            recordExpectation(exp, currentText, span, offset, sentence, chars, index)
          }

          // 2) Anything the curated table or a golden case already confirms is
          // ground truth. Without this guard the scanner "fixes" 朝鲜/解缙/
          // 朱重八 back to the wrong pinyin-pro reading.
          const curated = !baseline && assets.overlay.entries.has(span.word)
          const goldenPhones = golden.wordPhones.get(`${span.word}|${offset}`)
          if (curated || goldenPhones?.has(currentText)) {
            stats.curatedSkipped += 1
            continue
          }

          if (!expected) continue
          const kind = classify(current, expected)
          if (!kind) continue
          if (explainedBySandhi(engine, reference, offset)) continue
          const expectedText = phoneText(expected)
          // A golden label means a human already accepted the current reading.
          if (goldenPositions?.get(`${char}|${seen}`) === currentText) {
            stats.goldenSkipped += 1
            continue
          }
          stats.mismatches += 1

          const sources = ['pinyin-pro']
          if (votes.isPolyphonic(char)) sources.push('polyphonic')
          if (feedback.marks.has(`${normalized}|${char}|${expectedText}`)) sources.push('feedback')
          if (
            rules.byPattern.has(`${span.word}|${expectedText}`) ||
            rules.byPattern.has(`${char}|${expectedText}`)
          ) sources.push('rule')
          if (isNeutral(expected) && !assets.neutrals.has(expected.base)) {
            sources.push('untrained-neutral')
          }

          let { level, reason, backed } = confidenceOf({
            char, word: span.word, offset, currentText, expectedText, sources, votes,
          })
          const human = sources.includes('feedback') || sources.includes('rule')
          if (sources.includes('untrained-neutral')) {
            level = 'review'
            reason = '模型未训练该轻声'
          } else if (isNeutral(current) && NEUTRAL_PARTICLES.has(char) && !human) {
            // pinyin-pro reads 长期地/慢慢的 as di4; the curated table and the
            // model use the neutral particle de. Never "fix" these.
            level = 'review'
            reason = '轻声助词，参考读音常误给全调'
          } else if (kind === 'tone' && !backed) {
            // pinyin-pro reads 应立即 as ying4; a bare tone disagreement with
            // no independent backing is not a reliable signal.
            level = 'review'
            reason = '仅声调分歧且无词典/人工背书'
          } else if (kind === 'neutral' && !backed) {
            level = 'review'
            reason = '轻声分歧需人工确认'
          } else if (wordChars.length >= 2 && !human) {
            // A multi-character lexicon entry is more authoritative than
            // pinyin-pro's per-character guess (大都 du1, 率军 shuai4,
            // 为人 wei2…). Duplicate lexicon lines are often *stale* older
            // readings, so they cannot confirm a "fix". Only single-character
            // fallback positions can reach `likely` without a human source.
            level = 'review'
            reason = '整词词条已有读音，参考源分歧需人工确认'
          }

          const pattern = wordChars.length >= 2
            ? `${span.word}@${offset}`
            : `${chars[index - 1] ?? '^'}${char}${chars[index + 1] ?? '$'}`
          const key = `${char}|${currentText}|${expectedText}|${kind}|${pattern}`
          const context = makeContext(sentence, index, index + 1)
          let risk = risks.get(key)
          if (!risk) {
            const suggestion = buildSuggestion(span, offset, expectedText, reading, span.word)
            risk = {
              family: char,
              word: span.word,
              pattern,
              current: currentText,
              expected: expectedText,
              kind,
              severity: SEVERITY[kind],
              confidence: level,
              reason,
              sources: [...new Set(sources)],
              suggestion,
              count: 0,
              evidence: [],
            }
            risks.set(key, risk)
          }
          risk.count += 1
          if (risk.evidence.length < 3 && !risk.evidence.includes(context)) {
            risk.evidence.push(context)
          }
        }
      }
    }
    if (options.limit && stats.sentences >= options.limit) break
  }

  const all = [...risks.values()].map((risk) => ({
    ...risk,
    score: Math.round(risk.count * risk.severity * CONFIDENCE_FACTOR[risk.confidence] * 10) / 10,
    status: risk.confidence === 'review' ? 'review' : 'candidate',
  }))
  all.sort((left, right) =>
    right.score - left.score ||
    right.count - left.count ||
    left.family.localeCompare(right.family, 'zh'),
  )
  const candidates = all.filter((item) => item.status === 'candidate')
  const reviews = all.filter((item) => item.status === 'review')

  // Single-character fallbacks: a high-frequency fallback whose reading is not
  // the character's most common reading inside multi-character lexicon words is
  // a systematic risk (e.g. 得 de2 -> de, 率 shuai4 -> lv4).
  const fallbackRisks = [...fallback.values()]
    .map((item) => {
      const counts = variants.byChar.get(item.char)
      const mostCommon = counts
        ? [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
        : null
      return { ...item, mostCommon, biased: Boolean(mostCommon && mostCommon !== item.reading) }
    })
    .sort((left, right) => right.count - left.count)

  const impacts = [...expectImpact.values()].sort(
    (left, right) => right.local - left.local || right.family - left.family,
  )

  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${all.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  await writeFile(options.summary, renderSummary({
    stats, candidates, reviews, fallbackRisks, impacts, baseline, golden, options, corpora,
  }), 'utf8')

  console.log(`语料 ${corpora.length} 份 / ${stats.sentences} 句 / ${stats.spans} 个词条`)
  console.log(`分歧 ${stats.mismatches} 处 → 聚合 ${all.length} 条（候选 ${candidates.length} / 需人工 ${reviews.length}）`)
  console.log(`人工期望命中 ${stats.expectMatches} 处 · 人工已确认跳过 ${stats.curatedSkipped + stats.goldenSkipped} 处 · 单字兜底 ${stats.fallbackSpans} 处`)
  console.log(`清单 ${options.out}`)
  console.log(`摘要 ${options.summary}`)
  if (candidates.length) {
    console.log('\n优先级最高：')
    for (const item of candidates.slice(0, 8)) {
      console.log(`  ${String(item.score).padStart(6)}  ${item.family} ${item.pattern}  ${item.current} → ${item.expected}  ${item.kind}/${item.confidence}  ×${item.count}`)
    }
  }

  if (verify) {
    let hit = 0
    console.log('\n验收（--verify，隐含 --baseline）：')
    for (const expectation of VERIFY_EXPECTATIONS) {
      const impact = impacts.find((item) =>
        item.source === 'verify' &&
        item.char === expectation.char &&
        item.phone === expectation.expected &&
        item.word === expectation.word,
      )
      const ok = Boolean(impact?.local)
      if (ok) hit += 1
      console.log(`  ${ok ? '命中' : '未命中'}  ${expectation.char} → ${expectation.expected}（${expectation.sample}）  同类位置 ${impact?.local ?? 0} 处`)
    }
    console.log(`召回 ${hit}/${VERIFY_EXPECTATIONS.length}`)
    if (hit < VERIFY_EXPECTATIONS.length) process.exitCode = 1
  }
}

function renderSummary({ stats, candidates, reviews, fallbackRisks, impacts, baseline, golden, options, corpora }) {
  const lines = [
    '# 山岚读音风险清单',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 有效词典：${baseline ? '仅基础词典（--baseline，模拟修复前）' : '基础词典 + 人工覆盖表'}`,
    `- 语料：${corpora.map((item) => item.path).join('、')}`,
    `- 扫描：${stats.sentences} 句 / ${stats.spans} 个词条 / 分歧 ${stats.mismatches} 处`,
    `- 聚合：${candidates.length} 条候选 + ${reviews.length} 条需人工判定`,
    `- 人工期望命中 ${stats.expectMatches} 处 · 人工已确认跳过 ${stats.curatedSkipped + stats.goldenSkipped} 处（黄金集 ${golden.cases} 条用例）`,
    '',
    '> 本清单只覆盖「音素选错 / 数据漂移」。音素正确但被吞音、重复、读断的声学问题需由声学审计处理。',
    '',
    '## 人工期望的全书影响面（一条确认扩散到所有同类位置）',
    '',
    '「同语境不符」= 限定词窗口内、当前读音与期望不同的位置数（可生成整词条目的数量）。',
    '「该字其他语境」= 不限定语境时该字读音与期望不同的位置数，表示**全局替换会误伤多少处**，因此不生成单字条目。',
    '',
    '| 字 | 期望 | 限定词 | 来源 | 同语境不符 | 该字其他语境 | 样例 |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
  ]
  for (const item of impacts) {
    lines.push(`| ${item.char} | ${item.phone} | ${item.word || '（未限定）'} | ${item.source} | ${item.local} | ${item.family} | ${escapeCell(item.samples[0] ?? '—')} |`)
  }
  if (!impacts.length) lines.push('| — | — | — | — | 0 | 0 | 无 |')

  lines.push('', '## 候选（按 出现次数 × 严重度 × 置信度 排序）',
    '',
    '`confirmed` 只来自人工期望（反馈 / 规则 / --expect）；`likely` 为多源线索。两类**合并前都须人工确认**，脚本不会自动改写覆盖表。',
    '',
    '| 分数 | 字 | 词 / 语境 | 当前 | 期望 | 类型 | 置信 | 出现 | 建议 |',
    '| ---: | --- | --- | --- | --- | --- | --- | ---: | --- |',
  )
  for (const item of candidates.slice(0, options.top)) {
    lines.push(`| ${item.score} | ${item.family} | ${escapeCell(item.pattern)} | ${item.current} | ${item.expected} | ${item.kind} | ${item.confidence} | ${item.count} | ${escapeCell(item.suggestion.text)} |`)
  }
  if (!candidates.length) lines.push('| — | — | — | — | — | — | — | 0 | 无 |')

  lines.push('', `## 待人工确认的线索（${reviews.length} 条，按分数排序；不自动合并）`, '')
  lines.push('| 分数 | 字 | 词 / 语境 | 当前 | 参考 | 类型 | 置信 | 出现 | 原因 |')
  lines.push('| ---: | --- | --- | --- | --- | --- | --- | ---: | --- |')
  for (const item of reviews.slice(0, options.top)) {
    lines.push(`| ${item.score} | ${item.family} | ${escapeCell(item.pattern)} | ${item.current} | ${item.expected} | ${item.kind} | ${item.confidence} | ${item.count} | ${escapeCell(item.reason)} |`)
  }
  if (!reviews.length) lines.push('| — | — | — | — | — | — | — | 0 | 无 |')

  lines.push('', '## 单字兜底分布（可能影响全书同类位置）', '')
  lines.push('| 字 | 兜底次数 | 兜底读音 | 词典整词中最常见读音 | 偏向 |')
  lines.push('| --- | ---: | --- | --- | --- |')
  for (const item of fallbackRisks.slice(0, 20)) {
    lines.push(`| ${item.char} | ${item.count} | ${item.reading} | ${item.mostCommon ?? '—'} | ${item.biased ? '⚠' : ''} |`)
  }
  if (!fallbackRisks.length) lines.push('| — | 0 | — | — | |')
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
