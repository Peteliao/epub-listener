// Dev-only: scan a book corpus for 便 readings, focusing on 便宜-family pián2
// cases that the Matcha front end could resolve to bian4 (single-char fallback
// or a longer word stealing the 便).
//
// Mirrors the app: preparePronunciationText() inserts U+200B/U+2060, both of
// which force the front end to restart its longest-match lookup, so each
// segment between markers is tokenised independently.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT, loadMatchaAssets, tokenizeSpans, phoneticPhones,
} from '../lib/reading.mjs'
import { loadWordLists, prepareRuntimeText } from '../lib/wordFamily.mjs'

const corpusPath = process.argv[2] ?? join(ROOT, 'scripts/out/ming.txt')
const text = readFileSync(corpusPath, 'utf8')
const assets = await loadMatchaAssets()
const lists = loadWordLists()

const PIAN_WORDS = [...assets.lexicon]
  .filter(([word, reading]) => {
    const chars = Array.from(word)
    const index = chars.indexOf('便')
    return index >= 0 && phoneticPhones(reading)[index] === 'pian2'
  })
  .map(([word]) => word)
  .sort()

const counts = new Map()
const piYin = []
const suspicious = []

function bump(key) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const sentences = text.split(/(?<=[。！？；!?;\n])/u)
for (const sentence of sentences) {
  if (!sentence.includes('便')) continue
  const prepared = prepareRuntimeText(sentence, lists)
  for (const segment of prepared.split(/[\u200b\u2060]/u)) {
    if (!segment.includes('便')) continue
    const chars = Array.from(segment)
    for (const span of tokenizeSpans(segment, assets.effective)) {
      if (!span.word.includes('便')) continue
      const reading = assets.effective.get(span.word)
      if (!reading) continue
      const phones = phoneticPhones(reading)
      const wordChars = Array.from(span.word)
      for (let offset = 0; offset < wordChars.length; offset += 1) {
        if (wordChars[offset] !== '便') continue
        const phone = phones[offset]
        bump(`${span.word} -> ${phone}`)
        const next = chars[span.end] ?? ''
        if (next === '宜') {
          const item = {
            word: span.word,
            phone,
            fallback: wordChars.length === 1,
            context: segment.slice(Math.max(0, span.start - 12), span.end + 12),
          }
          piYin.push(item)
          if (phone === 'bian4') suspicious.push(item)
        }
        if (next === '便') {
          const dbl = { word: span.word, phone, next, context: segment.slice(Math.max(0, span.start - 10), span.end + 10) }
          piYin.push(dbl)
          if (phone === 'bian4') suspicious.push(dbl)
        }
      }
    }
  }
}

console.log(`语料 ${corpusPath}`)
console.log(`基础词典 pian2 词条 ${PIAN_WORDS.length}：${PIAN_WORDS.join(' / ')}`)
console.log('\n全书「便」词条命中（前 25）：')
for (const [key, value] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(value).padStart(5)}  ${key}`)
}

console.log(`\n「便」后接「宜」/「便」的语境 ${piYin.length} 条：`)
for (const item of piYin.slice(0, 40)) {
  console.log(`  ${item.phone} · ${item.word}${item.fallback ? '（单字兜底）' : ''} · ${item.context.replace(/\s+/g, '')}`)
}

console.log(`\n疑似 pián→biàn ${suspicious.length} 条：`)
for (const item of suspicious) {
  console.log(`  ${item.word} -> ${item.phone} · ${item.context.replace(/\s+/g, '')}`)
}
