// Dev-only helpers shared by the pronunciation audit scripts. The app never
// imports this file, so manifest/lexicon parsing stays out of the bundle.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MATCHA_PACK_ID = 'matcha-icefall-zh-baker'

// Neutral phones the Baker acoustic model was trained on. Sharing the data
// file with src/core/tts/bookLexicon.ts keeps the curated table, the automatic
// per-book overlay and the audits under one rule.
export const TRAINED_NEUTRAL_PHONES = new Set(
  readFileSync(join(ROOT, 'src', 'core', 'tts', 'trainedNeutrals.v1.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
)

export function parseEntries(text) {
  const entries = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    // Matcha stores lexicon lines in a map, so the last line for a word wins.
    entries.set(word, phones.join(' '))
  }
  return entries
}

export function parseOverlay(text) {
  const entries = new Map()
  const duplicates = []
  const malformed = []
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (!word || phones.length === 0) {
      malformed.push(`line ${index + 1}: ${trimmed}`)
      continue
    }
    if (entries.has(word)) {
      duplicates.push(`${word} (line ${index + 1})`)
      continue
    }
    entries.set(word, phones.join(' '))
  }
  return { entries, duplicates, malformed }
}

export function parseTokens(text) {
  const tokens = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0]
    if (token) tokens.add(token)
  }
  return tokens
}

// tokens.txt ID 7: the quote token, used as a silent boundary AFTER a word.
// It makes the acoustic model complete the final syllable (jian1: 35ms → 313ms)
// without lengthening the pause, because it merges with the natural pause that
// already followed the word. Do NOT move it inside the word: a comma there
// splits the word ("选、择") and the blank '_' (ID 1) becomes an extra syllable.
// It is not a reading, so every pronunciation check ignores it.
export const BOUNDARY_PHONE = '"'

export function phoneticPhones(reading) {
  return reading.split(/\s+/).filter((phone) => phone && phone !== BOUNDARY_PHONE)
}

export function maxWordLength(entries) {
  let max = 1
  for (const word of entries.keys()) {
    const length = Array.from(word).length
    if (length > max) max = length
  }
  return max
}

/**
 * Longest-match tokenisation that mirrors Matcha's own lexicon lookup: at each
 * character the longest entry wins, otherwise the character stands alone.
 */
export function tokenizeSpans(text, entries, maxLength = maxWordLength(entries)) {
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
    if (matched) {
      const length = Array.from(matched).length
      spans.push({ word: matched, start: index, end: index + length })
      index += length
    } else {
      spans.push({ word: chars[index], start: index, end: index + 1 })
      index += 1
    }
  }
  return spans
}

/** Resolves the reading of the nth occurrence of `char` in `text`. */
export function readingAt(text, char, occurrence, entries) {
  const chars = Array.from(text)
  let seen = 0
  let target = -1
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== char) continue
    seen += 1
    if (seen === occurrence) {
      target = index
      break
    }
  }
  if (target < 0) {
    throw new Error(`“${char}”第 ${occurrence} 次未出现在 ${JSON.stringify(text)}`)
  }
  const span = tokenizeSpans(text, entries).find(
    (item) => target >= item.start && target < item.end,
  )
  if (!span) {
    throw new Error(`无法定位 ${JSON.stringify(text)} 第 ${target + 1} 个字`)
  }
  const reading = entries.get(span.word)
  if (!reading) {
    throw new Error(`词条 ${span.word} 没有读音`)
  }
  return {
    phone: phoneticPhones(reading)[target - span.start],
    word: span.word,
    fallback: Array.from(span.word).length === 1,
  }
}

export async function loadMatchaAssets(overlayText) {
  const manifest = JSON.parse(
    await readFile(join(ROOT, 'public', 'models', 'manifest.json'), 'utf8'),
  )
  const pack = manifest.packs?.find((item) => item.id === MATCHA_PACK_ID)
  if (!pack) throw new Error(`manifest 中找不到 ${MATCHA_PACK_ID}`)
  const lexiconName = pack.model?.config?.lexicon
  const lexiconFile = pack.files?.find((file) => file.name === lexiconName)
  const tokensFile = pack.files?.find((file) => file.name === 'tokens.txt')
  if (!lexiconFile || !tokensFile) {
    throw new Error('manifest 中找不到词典或 tokens.txt')
  }

  const lexiconText = await readFile(
    join(ROOT, 'public', lexiconFile.url.replace(/^\/+/, '')),
    'utf8',
  )
  const tokensText = await readFile(
    join(ROOT, 'public', tokensFile.url.replace(/^\/+/, '')),
    'utf8',
  )
  const lexicon = parseEntries(lexiconText)
  const tokens = parseTokens(tokensText)
  const source =
    overlayText ??
    (await readFile(join(ROOT, 'src', 'core', 'tts', 'polyphones.v1.txt'), 'utf8'))
  const overlay = parseOverlay(source)
  const effective = new Map(lexicon)
  for (const [word, reading] of overlay.entries) effective.set(word, reading)

  return {
    manifest,
    pack,
    lexicon,
    lexiconText,
    tokens,
    tokensText,
    overlay,
    effective,
    maxLength: maxWordLength(effective),
    neutrals: TRAINED_NEUTRAL_PHONES,
  }
}
