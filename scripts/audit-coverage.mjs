#!/usr/bin/env node
// Finds the next batch of 山岚 pronunciation gaps in a real book.
//
// Unlike audit-polyphones.mjs (which compares pinyin-pro against the raw
// lexicon), this uses the *effective* lexicon (base + curated overlay), reports
// single-character fallback directly, and separates three actionable buckets:
// missing words, lost neutral tones, and syllable disagreements that need a
// human ear. Nothing here is auto-applied; candidates are reviewed by hand.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { JSDOM, VirtualConsole } from 'jsdom'
import { OutputFormat, pinyin, segment } from 'pinyin-pro'
import {
  loadMatchaAssets,
  tokenizeSpans,
  phoneticPhones,
  TRAINED_NEUTRAL_PHONES,
  ROOT,
} from './lib/reading.mjs'

const args = process.argv.slice(2)
const corpusArg = args.find((arg) => !arg.startsWith('--')) ?? 'public/sample.epub'
const topFlag = args.find((arg) => arg.startsWith('--top='))
const top = Number(topFlag?.slice(6) ?? 25)
const corpusPath = resolve(ROOT, corpusArg)
const assets = await loadMatchaAssets()
const virtualConsole = new VirtualConsole()

async function readCorpus(path) {
  if (/\.epub$/i.test(path)) {
    const zip = await JSZip.loadAsync(await readFile(path))
    const texts = []
    for (const name of Object.keys(zip.files)) {
      if (!/\.x?html?$/i.test(name)) continue
      const dom = new JSDOM(await zip.file(name).async('text'), { virtualConsole })
      dom.window.document
        .querySelectorAll('script,style,noscript,rt,rp')
        .forEach((el) => el.remove())
      texts.push(dom.window.document.body?.textContent ?? '')
    }
    return texts.join('\n')
  }
  return await readFile(path, 'utf8')
}

function splitPhone(phone) {
  const match = /^([a-z]+)([0-5])?$/.exec(phone)
  const digit = match?.[2] ? Number(match[2]) : 0
  // pinyin-pro writes neutral tone as 0 (zhe0/ge0); treat it like a toneless
  // lexicon phone, otherwise the neutral-gap check never fires.
  return { base: match?.[1] ?? phone, tone: digit === 0 || digit === 5 ? null : digit }
}

const HAN = /^\p{Script=Han}+$/u
const text = await readCorpus(corpusPath)
const sentences = text
  .split(/(?<=[。！？!?；;…\n])/u)
  .map((part) => part.replace(/\s+/g, ' ').trim())
  .filter(Boolean)

const oov = new Map()
const neutralGaps = new Map()
// A full-tone reading is intentional when the neutral phone is not trained:
// "补齐" would reintroduce the garbled/silent syllable this audit is guarding.
const untrainableNeutralGaps = new Map()
const syllableDiffs = new Map()
let wordTokens = 0
let fallbackTokens = 0

function record(map, word, detail) {
  const entry = map.get(word) ?? { count: 0, detail }
  entry.count += 1
  map.set(word, entry)
}

for (const sentence of sentences) {
  let words = []
  try {
    words = segment(sentence, {
      toneType: 'num',
      v: true,
      format: OutputFormat.ZhSegment,
    })
  } catch {
    continue
  }
  let offset = 0
  for (const word of words) {
    const start = offset
    const chars = Array.from(word)
    offset += chars.length
    if (chars.length < 2 || !HAN.test(word)) continue
    wordTokens += 1
    const reading = assets.effective.get(word)
    if (reading) {
      const phones = phoneticPhones(reading)
      if (phones.length !== chars.length) continue
      let reference = []
      try {
        reference = pinyin(word, { toneType: 'num', v: true, type: 'array' }).map(
          (item) => String(item).toLowerCase().replace(/ü/g, 'v'),
        )
      } catch {
        continue
      }
      if (reference.length !== chars.length) continue
      for (let index = 0; index < chars.length; index += 1) {
        const actual = splitPhone(phones[index])
        const expected = splitPhone(reference[index])
        if (actual.base !== expected.base) {
          record(
            syllableDiffs,
            word,
            `${chars[index]} 词库=${phones[index]} 参考=${reference[index]}`,
          )
          break
        }
        if (
          actual.tone !== null &&
          expected.tone === null &&
          chars.length <= 3
        ) {
          record(
            TRAINED_NEUTRAL_PHONES.has(expected.base)
              ? neutralGaps
              : untrainableNeutralGaps,
            word,
            `${chars[index]} 词库=${phones[index]} 参考=${reference[index]}`,
          )
          break
        }
      }
      continue
    }

    let fallback = true
    for (const span of tokenizeSpans(word, assets.effective)) {
      if (Array.from(span.word).length > 1 && assets.effective.has(span.word)) {
        fallback = false
        break
      }
    }
    if (fallback) {
      fallbackTokens += 1
      record(oov, word, `${start} 字起 · 单字兜底`)
    }
  }
}

function print(title, map, limit = top) {
  const sorted = [...map.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'zh'),
  )
  console.log(`\n${title}：${sorted.length} 个词 / ${sorted.reduce((n, [, v]) => n + v.count, 0)} 次`)
  for (const [word, entry] of sorted.slice(0, limit)) {
    console.log(`  ${String(entry.count).padStart(3)}× ${word}  ${entry.detail}`)
  }
  if (sorted.length > limit) console.log(`  …另有 ${sorted.length - limit} 个`)
}

console.log('山岚语料覆盖审计')
console.log(`  语料 ${corpusArg} · ${Array.from(text).length.toLocaleString()} 字符 / ${sentences.length.toLocaleString()} 句`)
console.log(
  `  多字词命中 ${wordTokens - fallbackTokens}/${wordTokens}` +
    `（${wordTokens ? (((wordTokens - fallbackTokens) / wordTokens) * 100).toFixed(1) : '0.0'}%），` +
    `单字兜底 ${fallbackTokens}`,
)
print('词库缺条（pinyin-pro 能分词，最长匹配仍按单字读）', oov)
print('词库标全调、参考为轻声（高可信候选）', neutralGaps)
print('模型未训练的轻声（保持全调，勿补齐）', untrainableNeutralGaps)
print('音节不一致（需人工确认，多数是参考词典错）', syllableDiffs)
