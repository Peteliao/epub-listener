// Dev-only: unified "history replay + family-wise discovery" for 山岚.
//
// Every listening fix in this repo is recorded in one of four assets. This
// module turns those assets into a machine-readable case list, replays each
// case against a *pre-fix* lexicon, and then generalises the confirmed fixes
// to every similar position in a corpus. It is pure (no WASM, no writes), so
// the whole replay is a fast CI gate and can be unit-tested directly.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  maxWordLength, phoneticPhones, readingAt, tokenizeSpans,
} from './reading.mjs'
import { scanFusionRisks } from './fusionRisk.mjs'
import {
  currentBoundary, discoverOmissionLeads, parseOmissionCases, replayOmission,
} from './omission.mjs'

export { discoverOmissionLeads }

// `omission` (P4) is the family the listener kept reporting: the phone is
// right and the golden set passes, but the acoustic model never voiced the
// syllable. It has its own asset with FULL feedback sentences, its own WASM
// audibility gate and its own whole-book discovery stage.
export const FAMILIES = [
  'phone', 'boundary', 'fusion', 'frontend', 'segmentation', 'omission',
]
export const PATHS = {
  rules: 'src/core/tts/readingRules.v1.jsonl',
  exceptions: 'src/core/tts/acousticExceptions.v1.jsonl',
  fusion: 'src/core/tts/fusionFixes.v1.jsonl',
  omissions: 'src/core/tts/omissionCases.v1.jsonl',
  golden: 'tests/fixtures/pronunciation-golden.jsonl',
  worker: 'public/workers/sherpa-tts.worker.js',
  aiModel: 'src/core/tts/AiModel.ts',
}

// Case files spell boundaries as keep/append/lead/both/internal; currentBoundary()
// reports none/tail/lead/both/internal. Keep the two vocabularies apart.
const CASE_BOUNDARY = {
  lead: 'lead',
  both: 'both',
  append: 'append',
  internal: 'internal',
  keep: 'keep',
  remove: 'keep',
  none: 'keep',
}

const BOUNDARY_KIND = {
  lead: 'lead',
  both: 'both',
  append: 'tail',
  internal: 'internal',
  keep: 'none',
  remove: 'none',
  none: 'none',
}

const HAN = /^\p{Script=Han}+$/u

function jsonl(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return []
    try {
      return [JSON.parse(trimmed)]
    } catch {
      return []
    }
  })
}

export function splitCorpus(text) {
  return String(text).replace(/\r/g, '')
    .split(/(?<=[。！？!?；;…\n])/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function clip(text, from, to, radius = 14) {
  const chars = Array.from(text)
  const start = Math.max(0, from - radius)
  const end = Math.min(chars.length, to + radius)
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}

/** All historical fixes, extracted from assets rather than hand-listed. */
export async function loadHistory(root) {
  const read = async (name) => {
    try {
      return await readFile(resolve(root, PATHS[name]), 'utf8')
    } catch {
      return ''
    }
  }
  const [rulesText, exceptionsText, fusionText, goldenText, omissionsText] = await Promise.all([
    read('rules'), read('exceptions'), read('fusion'), read('golden'), read('omissions'),
  ])
  const cases = []

  // Golden set: independent human ground truth, one case per marked reading.
  for (const record of jsonl(goldenText)) {
    if (!Array.isArray(record.readings)) continue
    for (const [char, occurrence, phone] of record.readings) {
      cases.push({
        id: `golden:${record.id}:${char}:${occurrence}`,
        family: 'phone',
        kind: 'golden',
        text: record.text,
        char, occurrence, phone,
        evidence: [record.text],
        source: record.id,
      })
    }
  }

  for (const rule of jsonl(rulesText)) {
    if (rule.status !== 'approved') continue
    if (rule.class === 'frontend') {
      cases.push({
        id: `rule:${rule.id}`, family: 'frontend', kind: 'frontend',
        target: rule.target, evidence: rule.evidence ?? [], source: rule.id,
      })
      continue
    }
    if (rule.scope !== 'word' || !rule.word) continue
    cases.push({
      id: `rule:${rule.id}`,
      family: rule.class === 'phone' ? 'phone' : 'boundary',
      kind: 'rule',
      word: rule.word,
      char: rule.char,
      offset: rule.offset,
      phone: rule.phone,
      boundary: rule.boundary ?? 'keep',
      generalize: rule.generalize !== false,
      evidence: rule.evidence ?? [],
      source: rule.id,
      note: rule.note ?? '',
    })
  }

  for (const entry of jsonl(exceptionsText)) {
    cases.push({
      id: `exception:${entry.word}`, family: 'boundary', kind: 'exception',
      word: entry.word,
      boundary: CASE_BOUNDARY[entry.currentBoundary] ?? 'keep',
      recommendation: entry.recommendation,
      status: entry.status,
      evidence: [],
      source: entry.source ?? 'acoustic-exceptions',
      note: entry.note ?? '',
    })
  }

  for (const fix of jsonl(fusionText)) {
    cases.push({
      id: `fusion:${fix.word}`, family: 'fusion', kind: 'fusion',
      word: fix.word,
      phones: fix.phones,
      blend: fix.blend,
      pinWords: fix.pinWords ?? [],
      status: fix.status,
      evidence: fix.evidence ?? [],
      source: fix.source ?? 'fusion-fixes',
    })
  }

  for (const entry of parseOmissionCases(omissionsText)) {
    cases.push({
      ...entry,
      id: `omission:${entry.id}`,
      family: 'omission',
      kind: 'omission',
      evidence: entry.sentences ?? [],
      source: entry.source ?? 'omission-cases',
    })
  }

  return cases
}

/** Cases for every curated overlay word: the word must survive longest-match. */
export function pinCases(assets) {
  return [...assets.overlay.entries].map(([word, reading]) => ({
    id: `pin:${word}`,
    family: 'segmentation',
    kind: 'pin',
    word,
    boundary: currentBoundary(reading).kind === 'tail' ? 'append'
      : currentBoundary(reading).kind === 'lead' ? 'lead'
        : currentBoundary(reading).kind === 'both' ? 'both'
          : currentBoundary(reading).kind === 'internal' ? 'internal' : 'keep',
    evidence: [`${word}。`],
    source: 'polyphones.v1.txt',
    reading,
  }))
}

export function occurrenceAt(text, char, index) {
  return Array.from(text.slice(0, index + 1)).filter((item) => item === char).length
}

export function spanAt(text, char, occurrence, effective, length) {
  const chars = Array.from(text)
  let seen = 0
  let index = -1
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === char) {
      seen += 1
      if (seen === occurrence) { index = i; break }
    }
  }
  if (index < 0) return null
  const span = tokenizeSpans(text, effective, length)
    .find((item) => index >= item.start && index < item.end)
  return span ? { ...span, charIndex: index } : null
}

function replayPhone(c, assets) {
  const span = spanAt(c.text, c.char, c.occurrence, assets.effective, assets.maxLength)
  if (!span) return { ok: false, detail: '无法在证据句中定位目标字' }
  const after = readingAt(c.text, c.char, c.occurrence, assets.effective)
  const ok = after.phone === c.phone
  let beforePhone = null
  if (Array.from(span.word).length >= 2 && assets.overlay.entries.has(span.word)) {
    const before = new Map(assets.effective)
    // One listening report usually produced several nested entries
    // (易得 + 千军易得). Removing only the longest winner leaves the shorter
    // one giving the correct reading, so the bug looks unreproducible. Remove
    // every curated word that already encodes this char -> phone conclusion.
    for (const [word, reading] of assets.overlay.entries) {
      const chars = Array.from(word)
      if (chars.length < 2) continue
      const phones = phoneticPhones(reading)
      if (phones.length !== chars.length) continue
      if (chars.some((char, index) => char === c.char && phones[index] === c.phone)) {
        before.delete(word)
      }
    }
    try {
      beforePhone = readingAt(c.text, c.char, c.occurrence, before).phone
    } catch {
      beforePhone = null
    }
  }
  return {
    ok,
    fixWord: span.word,
    beforePhone,
    afterPhone: after.phone,
    expected: c.phone,
    reproducible: beforePhone !== null && beforePhone !== c.phone,
    preventive: beforePhone === null || beforePhone === c.phone,
    detail: ok
      ? `${span.word}: ${beforePhone ?? '基础词典'} → ${after.phone}`
      : `${span.word}: 期望 ${c.phone}，实际 ${after.phone}（修复已回退）`,
  }
}

function replayWordCase(c, assets) {
  const reading = assets.overlay.entries.get(c.word)
  if (reading === undefined) return { ok: false, detail: '覆盖表缺少该词' }
  const where = currentBoundary(reading)
  const wanted = BOUNDARY_KIND[c.boundary] ?? 'none'
  if (where.kind !== wanted) {
    return { ok: false, detail: `边界应为 ${wanted}，实际 ${where.kind}@${where.after}` }
  }
  const text = c.evidence[0] ?? `${c.word}。`
  const hit = tokenizeSpans(text, assets.effective, assets.maxLength)
    .some((span) => span.word === c.word && text.includes(c.word))
  // A shorter pinned word may be legitimately shadowed by a longer same-prefix
  // entry (「来到」 in 「来到了」). That is not a regression: the carrier still
  // proves the entry survives longest-match. Corpus-wide shadowing is reported
  // separately by discoverSegmentationLeads.
  const shadowed = !hit
  if (shadowed && !tokenizeSpans(`${c.word}。`, assets.effective, assets.maxLength)
    .some((span) => span.word === c.word)) {
    return { ok: false, detail: '整词连独立载体都无法命中（词条已失效）' }
  }
  return {
    ok: true,
    fixWord: c.word,
    shadowed,
    advisory: c.recommendation === 'needs-review',
    detail: `${c.word} ${reading}${shadowed ? '（证据句中被更长同前缀词覆盖，词条本身有效）' : ''}${c.recommendation === 'needs-review' ? '（已知代理指标分歧，待复听）' : ''}`,
  }
}

function replayFusion(c, assets) {
  if (c.status === 'needs-listening') {
    return {
      ok: !assets.overlay.entries.has(c.word),
      advisory: true,
      detail: '多上下文复验冲突，已撤销写入并保留为待复听线索',
    }
  }
  const before = new Map(assets.effective)
  before.delete(c.word)
  for (const pinned of c.pinWords ?? []) before.delete(pinned)
  const baseline = {
    ...assets,
    effective: before,
    maxLength: maxWordLength(before),
  }
  const found = scanFusionRisks((c.evidence ?? []).join('\n'), baseline)
    .find((item) => item.word === c.word)
  return {
    ok: Boolean(found) && found.blend === c.blend,
    fixWord: c.word,
    detail: found ? `修复前基线可召回，blend=${found.blend}` : '修复前基线无法召回',
  }
}

/** Replay one historical case against its pre-fix lexicon. */
export function replayCase(c, assets) {
  switch (c.kind) {
    case 'golden':
      return replayPhone(c, assets)
    case 'rule': {
      if (c.family !== 'phone') return replayWordCase(c, assets)
      const evidence = c.evidence[0] ?? ''
      const wordAt = evidence.indexOf(c.word)
      const text = wordAt >= 0 ? evidence : `${c.word}。`
      const occurrence = wordAt >= 0
        ? occurrenceAt(evidence, c.char, wordAt + (c.offset ?? 0))
        : (c.offset ?? 0) + 1
      return replayPhone({ ...c, text, occurrence }, assets)
    }
    case 'exception':
    case 'pin':
      return replayWordCase(c, assets)
    case 'fusion':
      return replayFusion(c, assets)
    case 'omission':
      return replayOmission(c, assets)
    case 'frontend':
      return { ok: true, delegated: true, detail: `文本前端配置 ${c.target}` }
    default:
      return { ok: false, detail: `未知案例类型 ${c.kind}` }
  }
}

export function replayAll(cases, assets) {
  return cases.map((c) => ({ ...c, result: replayCase(c, assets) }))
}

/**
 * char -> [{ expected, beforePhone, fixWord, offset }] learned from *explicit
 * attribution rules* whose wrong reading can still be reproduced. Golden-set
 * cases are replayed but not generalised: many of them are one-off sandhi or
 * preventive pins whose扩散 would be semantics-blind (的 -> di2 everywhere).
 */
export function phoneFamilies(replays) {
  const families = new Map()
  for (const item of replays) {
    const r = item.result
    if (item.kind !== 'rule' || item.family !== 'phone'
      || item.generalize === false
      || !r.reproducible || !r.beforePhone || !r.fixWord) continue
    const list = families.get(item.char) ?? []
    // The rule's own word is the minimal generalisable shape (「易得」), while
    // r.fixWord is whichever longer entry currently wins longest-match
    // (「千军易得」). Using the latter makes the pattern far too specific.
    const pattern = Array.from(item.word ?? r.fixWord)
    const offset = Number.isInteger(item.offset)
      ? item.offset
      : pattern.indexOf(item.char)
    if (offset < 0 || offset >= pattern.length || pattern[offset] !== item.char) continue
    const fixWord = pattern.join('')
    if (!list.some((entry) => entry.expected === item.phone
      && entry.beforePhone === r.beforePhone && entry.fixWord === fixWord)) {
      list.push({
        expected: item.phone,
        beforePhone: r.beforePhone,
        fixWord,
        offset,
      })
    }
    families.set(item.char, list)
  }
  return families
}

/**
 * Generalise every confirmed phone fix to the whole corpus: a position whose
 * current reading equals the historical *wrong* reading, in a word that is not
 * pinned by the overlay, is a batch-review candidate. Word-level rows are
 * proposed (never single-character rows), so a confirmation cannot leak.
 */
export function discoverPhoneLeads(text, assets, replays, { limit = 40 } = {}) {
  const families = phoneFamilies(replays)
  const buckets = new Map()
  for (const sentence of splitCorpus(text)) {
    const chars = Array.from(sentence)
    const phonesAt = new Array(chars.length).fill(null)
    for (const span of tokenizeSpans(sentence, assets.effective, assets.maxLength)) {
      const reading = phoneticPhones(assets.effective.get(span.word) ?? '')
      if (reading.length !== Array.from(span.word).length) continue
      for (let k = 0; k < reading.length; k += 1) phonesAt[span.start + k] = reading[k]
    }
    for (let i = 0; i < chars.length; i += 1) {
      for (const entry of families.get(chars[i]) ?? []) {
        if (phonesAt[i] !== entry.beforePhone) continue
        // Rebuild the *word shape* of the historical fix around this character:
        // 「易得」 generalises to other「X得」, never to the single char 得.
        const patternLength = Array.from(entry.fixWord).length
        const from = i - entry.offset
        if (from < 0 || from + patternLength > chars.length) continue
        const word = chars.slice(from, from + patternLength).join('')
        if (!HAN.test(word) || assets.overlay.entries.has(word)) continue
        const phones = phonesAt.slice(from, from + patternLength)
        if (phones.some((phone) => !phone)
          || phones[entry.offset] !== entry.beforePhone) continue
        const next = [...phones]
        next[entry.offset] = entry.expected
        const key = `${word}|${entry.expected}`
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = {
            family: 'phone', word, char: chars[i],
            current: entry.beforePhone, expected: entry.expected,
            suggestion: `${word} ${next.join(' ')}`,
            learnedFrom: entry.fixWord,
            confidence: 'review', count: 0, evidence: [],
          }
          buckets.set(key, bucket)
        }
        bucket.count += 1
        if (bucket.evidence.length < 3) {
          bucket.evidence.push(clip(sentence, from, from + patternLength))
        }
      }
    }
  }
  return [...buckets.values()]
    .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word, 'zh'))
    .slice(0, limit)
}

/**
 * Unpinned two-character sequences that the front end currently reads as two
 * lone characters are the same shape as 最先/上天/地盘 before their fixes.
 * They are handed to the WASM A/B loop as measurement candidates.
 */
export function discoverBoundaryLeads(text, assets, { limit = 20, maxSentences = 0 } = {}) {
  const buckets = new Map()
  // Only dictionary-backed two-character words. Raw adjacent characters like
  // 「对这」/「的情」 are cross-word boundaries; a word already in the base
  // lexicon can still be swallowed (最先/上天/地盘 all were), so the base
  // lexicon is the candidate pool and only the curated overlay is excluded.
  const known = new Set()
  for (const word of assets.effective.keys()) {
    if (Array.from(word).length === 2 && HAN.test(word)
      && !assets.overlay.entries.has(word)) known.add(word)
  }
  const sentences = maxSentences > 0
    ? splitCorpus(text).slice(0, maxSentences)
    : splitCorpus(text)
  for (const sentence of sentences) {
    const chars = Array.from(sentence)
    for (let i = 0; i < chars.length - 1; i += 1) {
      const word = `${chars[i]}${chars[i + 1]}`
      if (!known.has(word)) continue
      const phones = phoneticPhones(assets.effective.get(word) ?? '')
      if (phones.length !== 2) continue
      let bucket = buckets.get(word)
      if (!bucket) {
        bucket = {
          family: 'boundary', word, phones,
          blend: '—', fromPhone: phones[0], toPhone: phones[1],
          confidence: 'high', neutralTail: false,
          count: 0, evidence: [],
        }
        buckets.set(word, bucket)
      }
      bucket.count += 1
      if (bucket.evidence.length < 3) {
        const sample = clip(sentence, i, i + 2, 12)
        if (!bucket.evidence.includes(sample)) bucket.evidence.push(sample)
      }
    }
  }
  const band = (item) => item.count >= 5 && item.count <= 200 ? 0 : 1
  return [...buckets.values()]
    .filter((item) => item.evidence.length >= 2 && item.count >= 2)
    .sort((left, right) =>
      band(left) - band(right)
      || right.count - left.count
      || left.word.localeCompare(right.word, 'zh'))
    .slice(0, limit)
    .map((item) => ({
      ...item,
      // A boundary on a word spoken thousands of times would change the rhythm
      // of the whole book; keep it as a listening lead, never an auto-edit.
      confidence: item.count > 200 ? 'low' : 'high',
      note: item.count > 200 ? '超高频词，仅列线索不自动应用' : '',
    }))
}

/** Curated words that appear in the corpus but lose longest-match to another word. */
export function discoverSegmentationLeads(text, assets, { limit = 40, ignoreCuratedLonger = true } = {}) {
  const leads = []
  for (const [word, reading] of assets.overlay.entries) {
    let from = 0
    let inspected = 0
    while (inspected < 3) {
      const index = text.indexOf(word, from)
      if (index < 0) break
      from = index + word.length
      const start = Math.max(0, index - 30)
      const window = text.slice(start, index + word.length + 30)
      const local = index - start
      const spans = tokenizeSpans(window, assets.effective, assets.maxLength)
      const covering = spans.find((span) => local >= span.start && local < span.end)
      // Only report a real longest-match loss when the curated word starts at
      // the same character as the winning span. A hit in the middle of a longer
      // span is just a cross-word substring (「倒时差」里的「时差」), not a bug.
      if (covering && covering.start === local && covering.word !== word
        && !(ignoreCuratedLonger && assets.overlay.entries.has(covering.word))) {
        leads.push({
          family: 'segmentation', word, reading,
          actual: covering.word,
          evidence: [clip(window, local, local + Array.from(word).length)],
          confidence: 'review',
        })
        break
      }
      inspected += 1
    }
    if (leads.length >= limit) break
  }
  return leads
}

export function frontendConfigCheck(workerText, aiModelText) {
  return [
    {
      name: 'worker min_words_in_sentence=12',
      ok: /min_words_in_sentence:\s*12\b/.test(workerText),
    },
    {
      name: 'worker max_words_in_sentence=1000',
      ok: /max_words_in_sentence:\s*1000\b/.test(workerText),
    },
    {
      name: 'matcha 专属 lexiconOverlay 未被移除',
      ok: /pack\.model\.type === 'matcha'/.test(aiModelText)
        && /polyphoneOverlay/.test(aiModelText),
    },
  ]
}
