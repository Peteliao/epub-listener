// Dev-only, dependency-free helpers for the 山岚 "omission" (P4) loop.
//
// Golden fixtures prove *which phone* a character gets. They cannot prove the
// acoustic model actually voiced it: 占便宜 was declared fixed twice while the
// listener still missed 便. This module keeps two invariants that the old gates
// lacked:
//   1. every Han character of a feedback sentence must produce exactly one
//      phonetic phone in the real runtime token stream (no truncated streams,
//      no silently dropped characters);
//   2. a recorded repair must still be present in the current overlay, and the
//      repaired word must be replayable against its pre-fix reading.
//
// Pure (no WASM, no writes) so the whole thing is unit-testable and fast.
import { BOUNDARY_PHONE, phoneticPhones } from './reading.mjs'
import { NON_PHONE, phoneIndices, sentenceTokens } from './fusionRisk.mjs'

const HAN = /\p{Script=Han}/u

export function parseOmissionCases(text) {
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

function clip(sentence, start, end, radius = 14) {
  const chars = Array.from(sentence)
  const from = Math.max(0, start - radius)
  const to = Math.min(chars.length, end + radius)
  return `${from > 0 ? '…' : ''}${chars.slice(from, to).join('')}${to < chars.length ? '…' : ''}`
}

/** Full runtime token stream for one feedback sentence, derived from the overlay. */
export function caseStream(sentence, word, assets) {
  const { tokens, ranges } = sentenceTokens(
    sentence,
    assets.effective,
    assets.maxLength,
  )
  const range = ranges.find((item) => item.word === word)
  if (!range) return null
  const reading = assets.effective.get(word) ?? ''
  const phones = phoneticPhones(reading)
  if (!phones.length || phones.length !== Array.from(word).length) return null
  return { tokens, range, phones, count: phones.length, reading }
}

/**
 * Anti-truncation invariant. In a pure-Chinese feedback sentence each Han
 * character contributes exactly one phonetic phone; punctuation and silent
 * boundaries do not. The old 占便宜 verify case stopped at 「有钱人」 and would
 * fail this check with 16 phones for 22 characters.
 */
export function sentenceCoverage(stream, sentence) {
  if (!stream) return { ok: false, han: 0, phones: 0 }
  const han = Array.from(sentence).filter((char) => HAN.test(char)).length
  const phones = stream.tokens.filter((token) => !NON_PHONE.has(token)).length
  return { ok: han > 0 && han === phones, han, phones }
}

/**
 * Strip the silent boundaries that belong to the target word, including a
 * leading and/or trailing one. The word's phones stay at the same index, so the
 * caller can insert a new boundary at `wordStart + after` directly.
 */
export function stripWordBoundaries(tokens, start, count) {
  const indices = phoneIndices(tokens, start, count)
  if (!indices.length) return [...tokens]
  const first = indices[0]
  const last = indices[indices.length - 1]
  // Drop only the quote tokens hugging the word; the phones stay in place, so
  // `start + after` is still the right insertion point for a new boundary.
  const lead = tokens[first - 1] === BOUNDARY_PHONE ? first - 1 : -1
  const tail = tokens[last + 1] === BOUNDARY_PHONE ? last + 1 : -1
  return tokens.filter((_, index) => index !== lead && index !== tail)
}

function insertAt(tokens, index, token) {
  const result = [...tokens]
  result.splice(index, 0, token)
  return result
}

/**
 * Enumerate EVERY completion-boundary position, including the word-INITIAL slot.
 * Two reported regressions drove the set:
 *   * 占便宜 only tried word-final and one word-internal slot, so it never saw
 *     the repair that actually works: a leading boundary, which puts the
 *     swallowed middle syllable back at the start of a phrase (便 221 → 337ms).
 *   * 地盘 was declared fixed because a trailing boundary lengthened 「盘」 while
 *     the syllable before it stayed at 105ms. A leading boundary is the only
 *     placement that fixes the first syllable of a word.
 * A word-internal boundary is still enumerated for diagnosis, but the policy
 * gate rejects it: inside a word it is heard as a break (「选、择」).
 */
export function boundaryVariants(stream) {
  const { tokens, range, count } = stream
  const base = stripWordBoundaries(tokens, range.start, count)
  const variants = [{
    kind: 'none', after: 0, label: '无完成边界',
    tokens: base, reading: null,
  }]
  for (let after = 0; after <= count; after += 1) {
    const next = insertAt(base, range.start + after, BOUNDARY_PHONE)
    const kind = after === 0 ? 'lead' : after === count ? 'tail' : 'internal'
    variants.push({
      kind,
      after,
      label: kind === 'lead'
        ? '词首完成边界'
        : kind === 'tail'
          ? '词尾完成边界'
          : `第 ${after} 个音素后完成边界`,
      tokens: next,
      reading: repairReading(stream.phones, after),
    })
  }
  const both = insertAt(insertAt(base, range.start + count, BOUNDARY_PHONE), range.start, BOUNDARY_PHONE)
  variants.push({
    kind: 'both', after: 0, label: '词首 + 词尾完成边界',
    tokens: both,
    reading: `${BOUNDARY_PHONE} ${stream.phones.join(' ')} ${BOUNDARY_PHONE}`,
  })
  return variants
}

/**
 * Overlay reading for a repair: insert `"` before the first phone (after = 0)
 * or after the `after`-th phonetic phone. Word-internal positions stay
 * expressible for measurement, but see `IN_WORD_BOUNDARY_POLICY`.
 */
export function repairReading(phones, after) {
  if (!Number.isInteger(after) || after < 0 || after > phones.length) {
    return phones.join(' ')
  }
  if (after === 0) return `${BOUNDARY_PHONE} ${phones.join(' ')}`
  return [...phones.slice(0, after), BOUNDARY_PHONE, ...phones.slice(after)].join(' ')
}

/**
 * Where the current reading places its boundary, if any. `lead` and `both` only
 * touch word edges; `internal` is the placement that caused 「便」 to be read
 * with a truncated tone and is now forbidden by policy.
 */
export function currentBoundary(reading) {
  const parts = String(reading).trim().split(/\s+/).filter(Boolean)
  const quoted = parts.filter((part) => part === BOUNDARY_PHONE).length
  if (!quoted) return { kind: 'none', after: 0 }
  const phones = parts.filter((part) => part !== BOUNDARY_PHONE)
  const at = parts.indexOf(BOUNDARY_PHONE)
  const lead = at === 0
  const tail = parts[parts.length - 1] === BOUNDARY_PHONE
  if (lead && tail && quoted >= 2) return { kind: 'both', after: 0 }
  if (lead) return { kind: 'lead', after: 0 }
  if (tail) return { kind: 'tail', after: phones.length }
  return {
    kind: 'internal',
    after: parts.slice(0, at).filter((part) => part !== BOUNDARY_PHONE).length,
  }
}

/**
 * Every overlay line whose silent boundary sits INSIDE the word. The project
 * only allows a boundary at a word edge: inside, the model stops mid-word and
 * the syllable after the break loses its tone (the 占便宜 regression).
 */
export function inWordBoundaries(entries) {
  const offenders = []
  for (const [word, reading] of entries) {
    const parts = String(reading).trim().split(/\s+/).filter(Boolean)
    if (!parts.includes(BOUNDARY_PHONE)) continue
    const at = parts.indexOf(BOUNDARY_PHONE)
    const lead = at === 0
    const tail = parts[parts.length - 1] === BOUNDARY_PHONE
    if (lead || tail) continue
    offenders.push({ word, reading })
  }
  return offenders
}

/** Structural replay: the fix must be present and must be removable. */
export function replayOmission(c, assets) {
  const reading = assets.overlay.entries.get(c.word)
  if (reading === undefined) return { ok: false, detail: '覆盖表缺少该词' }
  const expected = c.repair?.reading
  if (expected && reading !== expected) {
    return {
      ok: false,
      detail: `修复已回退：期望「${expected}」，实际「${reading}」`,
    }
  }
  const sentence = c.sentences?.[0]
  if (!sentence) return { ok: false, detail: '案例缺少反馈原句' }
  const stream = caseStream(sentence, c.word, assets)
  if (!stream) return { ok: false, detail: '反馈原句中无法定位该词' }
  const coverage = sentenceCoverage(stream, sentence)
  if (!coverage.ok) {
    return {
      ok: false,
      detail: `反馈原句 token 覆盖不全：${coverage.phones}/${coverage.han} 个汉字`,
    }
  }
  const before = new Map(assets.effective)
  before.set(c.word, stream.phones.join(' '))
  const preFix = caseStream(sentence, c.word, { ...assets, effective: before })
  const reproducible = Boolean(preFix)
    && currentBoundary(preFix.reading).kind === 'none'
  return {
    ok: true,
    fixWord: c.word,
    reproducible,
    detail: `${c.word} ${reading} · 原句 ${coverage.han} 字 ${coverage.phones} 音素 · 修复前基线${reproducible ? '可复现' : '不可复现'}`,
  }
}

/**
 * Generalise a confirmed omission to the whole book. Two shapes are collected:
 *   - every word containing the same character at the same offset (便宜/占便宜…),
 *   - every dictionary word with the same "nasal coda + weak stop onset"
 *     phone adjacency that made 便 disappear (zhan4 + pian2).
 * Leads are measurement candidates; nothing here edits the overlay.
 */
export function discoverOmissionLeads(text, assets, cases, { limit = 20 } = {}) {
  const confirmed = cases.filter((item) => item.status === 'confirmed')
  if (!confirmed.length) return []
  const learned = confirmed.map((item) => {
    const phones = phoneticPhones(assets.effective.get(item.word) ?? '')
    const offset = item.offset ?? 0
    return {
      id: item.id,
      char: item.char,
      phone: item.phone,
      offset,
      prevPhone: phones[offset - 1] ?? '',
      nextPhone: phones[offset + 1] ?? '',
    }
  })
  const nasalCoda = /n(?:g)?[0-5]?$/
  const weakStop = /^(?:b|p|d|t|g|k|zh|ch|j|q)/
  // 2026-11-11: the merged syllable can also be the FIRST syllable of an OOV
  // two-character word (经历 jing1 + li4). Its own nasal coda plus the following
  // sonorant onset has the same "no clear boundary" shape as the 占便宜 case.
  const sonorantOnset = /^(?:l|r|m|n|f|h|w|y)/
  const buckets = new Map()
  for (const sentence of splitCorpus(text)) {
    const chars = Array.from(sentence)
    for (const [index, char] of chars.entries()) {
      for (const rule of learned) {
        if (char !== rule.char) continue
        // Rebuild the word shape of the historical fix around this character.
        const from = index - rule.offset
        if (from < 0) continue
        for (const length of [3, 2, 4]) {
          if (from + length > chars.length) continue
          const word = chars.slice(from, from + length).join('')
          if (![...word].every((item) => HAN.test(item))) continue
          const reading = assets.effective.get(word)
          if (!reading) continue
          const phones = phoneticPhones(reading)
          if (phones.length !== length || phones[rule.offset] !== rule.phone) continue
          if (/"/.test(reading)) continue
          if (assets.overlay.entries.has(word)) continue
          const sameChar = true
          const sameAdjacency =
            (nasalCoda.test(phones[rule.offset - 1] ?? '')
              && weakStop.test(phones[rule.offset + 1] ?? ''))
            || (rule.offset === 0 && nasalCoda.test(rule.phone)
              && sonorantOnset.test(phones[1] ?? ''))
          const key = `${word}|${rule.id}`
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = {
              family: 'omission',
              word,
              char,
              offset: rule.offset,
              phone: rule.phone,
              phones,
              learnedFrom: rule.id,
              confidence: sameChar && sameAdjacency ? 'high' : 'review',
              count: 0,
              evidence: [],
              sentences: [],
            }
            buckets.set(key, bucket)
          }
          bucket.count += 1
          if (bucket.evidence.length < 3) {
            const sample = clip(sentence, from, from + length)
            if (!bucket.evidence.includes(sample)) bucket.evidence.push(sample)
          }
          // Keep the WHOLE sentence: the P4 loop must never measure a clipped
          // window, which is exactly how the 占便宜 fix was mis-validated.
          // Very long paragraphs are skipped rather than clipped: synthesis
          // cost and prosody both stop being comparable to a feedback sentence.
          const hanCount = Array.from(sentence).filter((item) => HAN.test(item)).length
          if (hanCount <= 60 && bucket.sentences.length < 3
            && !bucket.sentences.includes(sentence)) {
            bucket.sentences.push(sentence)
          }
          break
        }
      }
    }
  }
  return [...buckets.values()]
    .filter((item) => item.evidence.length >= 1 && item.count >= 1)
    .sort((left, right) =>
      (left.confidence === 'high' ? 0 : 1) - (right.confidence === 'high' ? 0 : 1)
      || right.count - left.count
      || left.word.localeCompare(right.word, 'zh'))
    .slice(0, limit)
}
