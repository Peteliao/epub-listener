import { readFileSync } from 'node:fs'
import { readingAt, phoneticPhones } from './reading.mjs'
import { maxWordLength } from './reading.mjs'

const CONNECTIVE = /^(但是|可是|然而|而是|因此|因而|于是|那么|然后|接着|随后|如果|假如|要是|虽然|尽管|即使|无论|不管|只要|只有|除非|由于|而且|并且|况且|何况|否则|不然|例如|比如|譬如|尤其是|特别是|也就是说|换句话说)/

function parseJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line))
}

export function loadG2pContext(path) {
  return parseJsonl(path)
}

export function loadProsodyBoundaries(path) {
  return parseJsonl(path)
}

export function normalizeExternalReading(reading) {
  // The external corpus writes ü as v and tone-5 as 5; Matcha lexicons write
  // yu/qu/... and bare neutral syllables.
  return String(reading ?? '').trim().replace(/5$/g, '').replace(/v/gi, 'u')
}

/** Advisory agreement check; the external corpus is never used to auto-edit. */
export function auditG2pContext(examples, assets, options = {}) {
  const effective = assets.effective
  const maxLength = assets.maxLength ?? maxWordLength(effective)
  const limit = options.limit ?? 50
  let matches = 0
  const mismatches = []
  for (const item of examples) {
    const chars = [...item.text]
    if (!chars[item.index] || chars[item.index] !== item.char) continue
    const occurrence = chars.slice(0, item.index).filter((char) => char === item.char).length + 1
    const current = readingAt(item.text, item.char, occurrence, effective)
    if (!current) continue
    const actual = normalizeExternalReading(phoneticPhones(current.phone)[0])
    const expected = normalizeExternalReading(item.reading)
    if (actual === expected) {
      matches += 1
      continue
    }
    if (mismatches.length < limit) {
      mismatches.push({
        char: item.char,
        expected,
        actual,
        word: current.word,
        left: item.left,
        right: item.right,
      })
    }
  }
  return { total: matches + mismatches.length, matches, mismatches }
}

export function summarizeProsody(boundaries) {
  let connectives = 0
  let level3 = 0
  let level4 = 0
  for (const item of boundaries) {
    if (item.level === 3) level3 += 1
    if (item.level === 4) level4 += 1
    const right = String(item.right ?? '').trim().replace(/^[^\p{Script=Han}]+/u, '')
    if (CONNECTIVE.test(right)) connectives += 1
  }
  return { total: boundaries.length, level3, level4, connectives }
}
