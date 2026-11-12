#!/usr/bin/env node
// Compile the hand-verified, explicitly registered polyphone knowledge into a
// runtime constant. The JSONL rule file is dev-only (see its header), so the
// app must never parse it at runtime.
//
// The whitelist is keyed by CHARACTER + allowed phoneme BASE, not by whole
// word: generateBookLexicon() only reaches its "context reading differs from
// standalone reading" branch for OOV words, and every whole word registered in
// readingRules.v1.jsonl is already in polyphones.v1.txt. A character-level
// whitelist is what actually admits new OOV candidates without bypassing the
// existing guard pipeline.
//
// Sources of allowed bases:
//   1. polyphones.v1.txt rows whose reading differs from the single-character
//      default in the bundled lexicon (same rule as deriveReservedChars()).
//   2. approved / scope=word / non-frontend rules in readingRules.v1.jsonl.
// Words explicitly marked `rejected` are emitted as a blacklist and never
// admitted, even if the character/base pair looks registered.
//
// Deterministic output (sorted) plus an fnv1a hash so the per-book lexicon
// cache can be invalidated when the whitelist changes.
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT, parseEntries, parseTokens, TRAINED_NEUTRAL_PHONES } from './lib/reading.mjs'

const RULES = join(ROOT, 'src/core/tts/readingRules.v1.jsonl')
const OUT = join(ROOT, 'src/core/tts/approvedOverrides.v1.ts')
const LEXICON = join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt')
const TOKENS = join(ROOT, 'public/models/matcha-icefall-zh-baker/tokens.txt')
const CURATED = join(ROOT, 'src/core/tts/polyphones.v1.txt')

const args = process.argv.slice(2)
const verify = args.includes('--verify')
const outArg = args.find((a) => a.startsWith('--out='))
const target = outArg ? resolve(ROOT, outArg.slice('--out='.length)) : OUT

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const baseOf = (phone) => String(phone).toLowerCase().replace(/ü/g, 'v').replace(/[0-5]$/, '')
const phonesOf = (reading) => String(reading).split(/\s+/).filter((p) => p && p !== '"')

async function main() {
  const [rulesText, lexiconText, tokensText, curatedText] = await Promise.all([
    readFile(RULES, 'utf8'), readFile(LEXICON, 'utf8'),
    readFile(TOKENS, 'utf8'), readFile(CURATED, 'utf8'),
  ])
  const lexicon = parseEntries(lexiconText)
  const tokens = parseTokens(tokensText)
  const neutrals = TRAINED_NEUTRAL_PHONES
  const singleDefault = (char) => {
    const row = lexicon.get(char)
    const phone = row ? phonesOf(row)[0] : null
    return phone ? baseOf(phone) : null
  }

  const rules = []
  const errors = []
  const ids = new Set()
  for (const [index, line] of rulesText.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let rule
    try {
      rule = JSON.parse(trimmed)
    } catch {
      errors.push(`第 ${index + 1} 行不是合法 JSON`)
      continue
    }
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)) {
      errors.push(`第 ${index + 1} 行 id 缺失或重复`)
      continue
    }
    ids.add(rule.id)
    rules.push(rule)
  }
  if (errors.length) throw new Error(errors.join('\n'))

  const rejectedWords = new Set(
    rules.filter((r) => r.status === 'rejected' && typeof r.word === 'string')
      .map((r) => r.word),
  )

  // Character -> allowed phoneme bases, verified by a human listener.
  const charBases = new Map()
  const allow = (char, phone) => {
    const base = baseOf(phone)
    if (!base) return false
    const set = charBases.get(char) ?? new Set()
    set.add(base)
    charBases.set(char, set)
    return true
  }

  // Source 1: curated overlay rows.
  let curatedPairs = 0
  for (const line of curatedText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...rest] = trimmed.split(/\s+/)
    const phones = phonesOf(rest.join(' '))
    const chars = Array.from(word)
    if (phones.length !== chars.length) continue
    for (let i = 0; i < chars.length; i += 1) {
      const def = singleDefault(chars[i])
      if (def && baseOf(phones[i]) !== def) {
        if (allow(chars[i], phones[i])) curatedPairs += 1
      }
    }
  }

  // Source 2: approved word-scoped rules (frontend rules have no reading).
  let rulePairs = 0
  const skipped = { nonApproved: 0, frontend: 0, family: 0, rejectedWord: 0, invalid: 0 }
  for (const rule of rules) {
    if (rule.status !== 'approved') { skipped.nonApproved += 1; continue }
    if (rule.class === 'frontend') { skipped.frontend += 1; continue }
    if (rule.scope !== 'word') { skipped.family += 1; continue }
    if (rejectedWords.has(rule.word)) { skipped.rejectedWord += 1; continue }
    const chars = Array.from(String(rule.word ?? ''))
    const phone = String(rule.phone ?? '')
    if (
      !Number.isInteger(rule.offset) || rule.offset < 0 || rule.offset >= chars.length ||
      chars[rule.offset] !== rule.char || !/^[a-z]+[0-4]?$/.test(phone) ||
      !tokens.has(phone) || (!/[0-4]$/.test(phone) && !neutrals.has(phone))
    ) {
      skipped.invalid += 1
      errors.push(`${rule.id}: 词/位置/音素非法或模型未训练`)
      continue
    }
    if (allow(chars[rule.offset], phone)) rulePairs += 1
  }
  if (errors.length) throw new Error(errors.join('\n'))

  const chars = [...charBases.keys()].sort((a, b) => a.localeCompare(b, 'zh'))
  const rejected = [...rejectedWords].sort((a, b) => a.localeCompare(b, 'zh'))
  const serialized = [
    ...chars.map((c) => `${c}=${[...charBases.get(c)].sort().join(',')}`),
    ...rejected.map((w) => `!${w}`),
  ].join('\n')
  const hash = fnv1a(serialized)

  const charLines = chars.map((c) => {
    const bases = [...charBases.get(c)].sort()
    return `  '${c}': [${bases.map((b) => `'${b}'`).join(', ')}],`
  })
  const body = `// GENERATED by scripts/compile-approved-overrides.mjs. Do not edit by hand.
// Sources: src/core/tts/readingRules.v1.jsonl + polyphones.v1.txt (both dev-only
// at runtime). Character-level whitelist: the per-book lexicon generator only
// reaches the ambiguity branch for OOV words, so whole-word entries would be
// skipped by the curated overlay before ever being considered.
export interface ApprovedOverridesData {
  /** Verified phoneme bases a character is allowed to take in context. */
  charBases: Readonly<Record<string, readonly string[]>>
  /** Whole words explicitly rejected after listening; never admitted. */
  rejectedWords: readonly string[]
}

/** ${chars.length} characters / ${[...charBases.values()].reduce((n, s) => n + s.size, 0)} verified bases / ${rejected.length} rejected words. */
export const APPROVED_OVERRIDES: ApprovedOverridesData = Object.freeze({
  charBases: Object.freeze({
${charLines.join('\n')}
  }),
  rejectedWords: Object.freeze([${rejected.map((w) => `'${w}'`).join(', ')}]),
})

/** Fingerprint of the exact entries above; part of the per-book cache key. */
export const APPROVED_OVERRIDES_HASH = '${hash}'
`

  if (verify) {
    let current
    try {
      current = await readFile(target, 'utf8')
    } catch {
      console.error(`缺少编译产物：${target}`)
      process.exitCode = 1
      return
    }
    if (current !== body) {
      console.error('白名单编译产物已漂移，请运行 npm run overrides:compile 重新生成。')
      process.exitCode = 1
      return
    }
    console.log(`白名单编译产物一致：${chars.length} 字 / hash ${hash}`)
    return
  }

  await writeFile(target, body, 'utf8')
  console.log(`已生成 ${target}`)
  console.log(`  ${chars.length} 字 / ${[...charBases.values()].reduce((n, s) => n + s.size, 0)} 个已确认音素 / ${rejected.length} 个排除词 / hash ${hash}`)
  console.log(`  来源：人工表 ${curatedPairs} 对，归因规则 ${rulePairs} 对`)
  console.log(`  跳过：${JSON.stringify(skipped)}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
