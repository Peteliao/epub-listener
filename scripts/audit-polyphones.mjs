#!/usr/bin/env node
// Dev-only audit. Never imported by the app; pinyin-pro/jszip stay out of the bundle.
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { JSDOM, VirtualConsole } from 'jsdom'
import { OutputFormat, pinyin, segment } from 'pinyin-pro'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(ROOT, 'public/models/manifest.json')
const OVERLAY_PATH = join(ROOT, 'src/core/tts/polyphones.v1.txt')
const HAN = /\p{Script=Han}/u
const PINYIN_OPTS = { toneType: 'num', v: true }
const NEUTRAL_PHONES = new Set([
  'de', 'le', 'zhe', 'me', 'zi', 'men', 'ba', 'shi', 'yi', 'tou', 'jia', 'li',
])
const virtualConsole = new VirtualConsole()

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const fileArgs = args.filter((arg) => !arg.startsWith('--'))
const overlayOnly = flags.has('--overlay-only')
const top = numberFlag('--top', 40)

function numberFlag(name, fallback) {
  const raw = args.find((arg) => arg.startsWith(`${name}=`))
  const value = Number(raw?.slice(name.length + 1))
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function isNeutral(tone) {
  return tone === null || tone === undefined || tone === 0 || tone === 5
}

function splitPhone(phone) {
  const lower = String(phone).toLowerCase().replace(/ü/g, 'v')
  const match = /^([a-z]+)([0-5])?$/.exec(lower)
  if (!match) return { base: lower, tone: null }
  const value = match[2] === undefined ? null : Number(match[2])
  return { base: match[1], tone: value === 0 || value === 5 ? null : value }
}

function phonesOf(reading) {
  return reading.split(/\s+/).filter(Boolean).map(splitPhone)
}

function pinyinReading(text) {
  return pinyin(text, { ...PINYIN_OPTS, type: 'array' })
    .map((item) => String(item).toLowerCase().replace(/ü/g, 'v'))
}

function pinyinDefaultReading(text) {
  return Array.from(text, (char) => pinyinReading(char)[0] ?? '')
}

function hasPhraseReading(word) {
  return pinyinReading(word).join(' ') !== pinyinDefaultReading(word).join(' ')
}

function parseLexicon(text) {
  const entries = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    // sherpa-onnx keeps the first duplicate, so the audit must do the same.
    if (!entries.has(word)) entries.set(word, phones.join(' '))
  }
  return entries
}

function parseTokens(text) {
  const tokens = new Set()
  for (const line of text.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0]
    if (token) tokens.add(token)
  }
  return tokens
}

function parseOverlay(source) {
  const entries = new Map()
  const duplicates = []
  const structure = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    const lineNo = index + 1
    if (!word || phones.length === 0) {
      structure.push(`line ${lineNo}: ${trimmed}`)
      continue
    }
    if (entries.has(word)) {
      duplicates.push(`${word} (line ${lineNo}, first at line ${entries.get(word).line})`)
      continue
    }
    entries.set(word, { word, reading: phones.join(' '), line: lineNo })
  }
  return { entries, duplicates, structure }
}

function auditOverlay(entries, lexicon, tokens) {
  const result = {
    count: entries.size,
    structure: [],
    missingPhones: [],
    neutralPhones: [],
    redundant: [],
    duplicates: [],
    mismatches: [],
    toneDiffs: [],
    neutralDiffs: [],
    sandhiSuggestions: [],
  }
  for (const entry of entries.values()) {
    const chars = Array.from(entry.word)
    const phones = phonesOf(entry.reading)
    if (chars.length !== phones.length) {
      result.structure.push(`${entry.word}: ${chars.length} 字 / ${phones.length} 音`)
    }
    if (chars.length === 1 && !(entry.word === '得' && entry.reading === 'de')) {
      result.structure.push(`${entry.word}: 单字覆盖（仅允许“得 de”）`)
    }
    for (const phone of entry.reading.split(/\s+/)) {
      if (!tokens.has(phone)) result.missingPhones.push(`${entry.word}: ${phone}`)
      if (!/\d$/.test(phone) && !NEUTRAL_PHONES.has(phone)) {
        result.neutralPhones.push(`${entry.word}: ${phone}`)
      }
    }
    if (lexicon.get(entry.word) === entry.reading) {
      result.redundant.push(entry.word)
    }
    if (chars.length !== phones.length) continue

    const reference = pinyinReading(entry.word)
    if (reference.length !== chars.length) {
      result.structure.push(`${entry.word}: pinyin-pro 返回 ${reference.length} 个音节`)
      continue
    }
    const referencePhones = reference.map(splitPhone)
    for (let index = 0; index < phones.length; index += 1) {
      const actual = phones[index]
      const expected = referencePhones[index]
      if (actual.base !== expected.base) {
        result.mismatches.push({
          ...entry,
          reference,
          phrase: hasPhraseReading(entry.word),
        })
        continue
      }
      if (actual.tone === expected.tone) continue
      if (isNeutral(actual.tone) || isNeutral(expected.tone)) {
        result.neutralDiffs.push({ ...entry, reference })
        continue
      }
      if (explainedBySandhi(phones, referencePhones, index)) continue
      result.toneDiffs.push({ ...entry, reference })
    }

    for (let index = 0; index < phones.length - 1; index += 1) {
      if (phones[index].tone === 3 && phones[index + 1].tone === 3) {
        result.sandhiSuggestions.push({ ...entry, index })
      }
    }
  }
  return result
}

function explainedBySandhi(actual, reference, index) {
  const current = actual[index]
  const expected = reference[index]
  if (
    current.tone === 2 &&
    expected.tone === 3 &&
    (reference[index + 1]?.tone === 3 || actual[index + 1]?.tone === 3)
  ) {
    return true
  }
  // 一/不 sandhi depends on lexicalized context; treat tone-only changes as expected.
  return ['yi', 'bu'].includes(current.base)
}

function groupDifferences(records) {
  const groups = new Map()
  for (const record of records) {
    const chars = Array.from(record.word)
    const actual = phonesOf(record.reading)
    const reference = record.reference.map(splitPhone)
    let index = 0
    while (index < chars.length && actual[index]?.base === reference[index]?.base) index += 1
    if (index >= chars.length) index = 0
    const actualPhone = actual[index]
    const referencePhone = reference[index]
    const key =
      `${chars[index] ?? '?'} ` +
      `${actualPhone ? `${actualPhone.base}${actualPhone.tone ?? ''}` : '?'}/` +
      `${referencePhone ? `${referencePhone.base}${referencePhone.tone ?? ''}` : '?'}`
    if (!groups.has(key)) groups.set(key, { key, records: [] })
    groups.get(key).records.push(record)
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      unique: Array.from(new Map(group.records.map((record) => [record.word, record])).values()),
    }))
    .sort((left, right) => right.unique.length - left.unique.length || left.key.localeCompare(right.key, 'zh'))
}

function printDifferences(title, records, limit) {
  const uniqueCount = new Set(records.map((record) => record.word)).size
  console.log(`\n${title}：${records.length} 处 / ${uniqueCount} 个词`)
  if (!records.length) return
  const groups = groupDifferences(records)
  const common = groups.filter((group) => group.unique.length > 3)
  const rare = groups.filter((group) => group.unique.length <= 3)

  if (common.length) {
    console.log('  高频读音族（多为已知多音字/助词，按组汇总）：')
    for (const group of common.slice(0, limit)) {
      const words = group.unique.slice(0, 6).map((record) => record.word).join('、')
      console.log(
        `    ${group.key} ×${group.unique.length}：${words}${group.unique.length > 6 ? '…' : ''}`,
      )
    }
    if (common.length > limit) console.log(`    …另有 ${common.length - limit} 组`)
  }

  if (rare.length) {
    console.log('  低频/单独条目（优先人工确认）：')
    const rareRecords = rare.flatMap((group) => group.unique)
    for (const record of rareRecords.slice(0, limit)) {
      const source = record.phrase ? '词组' : '单字默认'
      console.log(
        `    line ${record.line}  ${record.word}: 覆盖=${record.reading}  pinyin-pro=${record.reference.join(' ')}  [${source}]`,
      )
    }
    if (rareRecords.length > limit) {
      console.log(`    …另有 ${rareRecords.length - limit} 条，调整 --top 查看`)
    }
  }
}

function printD1(result) {
  console.log('D1 覆盖表自检')
  console.log(`覆盖表：${result.count} 条`)
  console.log(`结构问题：${result.structure.length}`)
  for (const item of result.structure.slice(0, top)) console.log(`  - ${item}`)
  console.log(`tokens.txt 缺失音素：${result.missingPhones.length}`)
  for (const item of result.missingPhones.slice(0, top)) console.log(`  - ${item}`)
  console.log(`未在词库出现的轻声音素：${result.neutralPhones.length}`)
  for (const item of result.neutralPhones.slice(0, top)) console.log(`  - ${item}`)
  console.log(`与词库重复且读音相同：${result.redundant.length}`)
  if (result.duplicates.length) {
    console.log(`重复词条：${result.duplicates.length}`)
    for (const item of result.duplicates) console.log(`  - ${item}`)
  }

  printDifferences('pinyin-pro 音节不一致（需人工确认）', result.mismatches, top)
  printDifferences('pinyin-pro 声调不同（非音节错误）', result.toneDiffs, top)

  console.log(`\n轻声差异（多为覆盖表沿用词库的轻声/全调差异）：${result.neutralDiffs.length} 处`)
  for (const item of result.neutralDiffs.slice(0, Math.min(top, 10))) {
    console.log(`  ${item.word}: 覆盖=${item.reading}  pinyin-pro=${item.reference.join(' ')}`)
  }

  console.log(`\n缺少 3+3 变调（按本表约定建议 2+3）：${result.sandhiSuggestions.length} 处`)
  for (const item of result.sandhiSuggestions) {
    console.log(`  line ${item.line}  ${item.word}: ${item.reading}`)
  }

  if (
    !result.structure.length &&
    !result.mismatches.length &&
    !result.toneDiffs.length &&
    !result.sandhiSuggestions.length
  ) {
    console.log('\n覆盖表未发现需要人工处理的问题。')
  }
  console.log('\n提示：pinyin-pro 未收录的词会按单字默认音（如“长满”“得问”）；它的词组读音也可能错（如“为宜”）。')
}

function isHanWord(word) {
  const chars = Array.from(word)
  return chars.length >= 2 && chars.every((char) => HAN.test(char))
}

function tokenize(sentence, lexicon, maxLength) {
  const chars = Array.from(sentence)
  const tokens = []
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    if (HAN.test(char)) {
      let matched = ''
      const limit = Math.min(maxLength, chars.length - index)
      for (let length = limit; length >= 1; length -= 1) {
        const candidate = chars.slice(index, index + length).join('')
        if (lexicon.has(candidate)) {
          matched = candidate
          break
        }
      }
      if (matched) {
        const length = Array.from(matched).length
        tokens.push({ word: matched, start: index, end: index + length })
        index += length
      } else {
        tokens.push({ word: char, start: index, end: index + 1 })
        index += 1
      }
      continue
    }
    if (/[A-Za-z0-9]/.test(char)) {
      let end = index + 1
      while (end < chars.length && /[A-Za-z0-9'’-]/.test(chars[end])) end += 1
      tokens.push({ word: chars.slice(index, end).join(''), start: index, end })
      index = end
      continue
    }
    tokens.push({ word: char, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

function splitSentences(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .split(/(?<=[。！？!?；;…\n])/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((sentence) => chunkSentence(sentence, 400))
}

function chunkSentence(sentence, max) {
  const chars = Array.from(sentence)
  if (chars.length <= max) return [sentence]
  const chunks = []
  for (let index = 0; index < chars.length; index += max) {
    chunks.push(chars.slice(index, index + max).join(''))
  }
  return chunks
}

function makeContext(sentence, start, end) {
  const chars = Array.from(sentence)
  const from = Math.max(0, start - 14)
  const to = Math.min(chars.length, end + 14)
  return `${from > 0 ? '…' : ''}${chars.slice(from, to).join('').replace(/\s+/g, ' ')}${to < chars.length ? '…' : ''}`
}

function xmlDocument(xml) {
  return new JSDOM(xml, { contentType: 'text/xml', virtualConsole }).window.document
}

function collectHtmlText(html) {
  const dom = new JSDOM(html, { virtualConsole })
  const document = dom.window.document
  document.querySelectorAll('script,style,noscript').forEach((element) => element.remove())
  return (document.body?.textContent ?? document.documentElement.textContent ?? '')
    .replace(/\u00a0/g, ' ')
}

async function readEpub(path) {
  const zip = await JSZip.loadAsync(await readFile(path))
  let opfPath = null
  const container = zip.file('META-INF/container.xml')
  if (container) {
    const document = xmlDocument(await container.async('text'))
    opfPath = document.getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ?? null
  }
  if (!opfPath) {
    opfPath = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.opf')) ?? null
  }

  let opfDir = ''
  let hrefs = []
  if (opfPath) {
    const directory = posix.dirname(opfPath)
    opfDir = directory === '.' ? '' : directory
    const opfFile = zip.file(opfPath)
    if (opfFile) {
      const document = xmlDocument(await opfFile.async('text'))
      const items = new Map()
      for (const item of document.getElementsByTagName('item')) {
        const id = item.getAttribute('id')
        const href = item.getAttribute('href')
        if (id && href) items.set(id, href)
      }
      for (const itemref of document.getElementsByTagName('itemref')) {
        const idref = itemref.getAttribute('idref')
        const href = idref ? items.get(idref) : null
        if (href) hrefs.push(href)
      }
    }
  }
  if (!hrefs.length) {
    hrefs = Object.keys(zip.files).filter((name) => /\.x?html?$/i.test(name))
  }

  const sections = []
  for (const href of hrefs) {
    let decoded = href.split('#')[0]
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      // Keep the raw href for malformed percent escapes.
    }
    const entryName = opfDir ? posix.normalize(posix.join(opfDir, decoded)) : posix.normalize(decoded)
    const entry = zip.file(entryName) ?? zip.file(decoded)
    if (!entry) continue
    const text = collectHtmlText(await entry.async('text'))
    if (text.trim()) sections.push(text)
  }
  const text = sections.join('\n')
  return { path, sections: sections.length, chars: Array.from(text).length, text }
}

async function readFb2(path) {
  const document = xmlDocument(await readFile(path, 'utf8'))
  document.querySelectorAll('binary,script,style').forEach((element) => element.remove())
  const text = document.documentElement.textContent ?? ''
  return { path, sections: 1, chars: Array.from(text).length, text }
}

async function readCorpus(path) {
  const absolute = resolve(path)
  const extension = extname(absolute).toLowerCase()
  if (extension === '.txt' || extension === '.md') {
    const text = await readFile(absolute, 'utf8')
    return { path, sections: 1, chars: Array.from(text).length, text }
  }
  if (extension === '.epub') return readEpub(absolute)
  if (extension === '.fb2') return readFb2(absolute)
  throw new Error(`暂不支持 ${extension || '无扩展名'}（D2 支持 .epub/.txt/.md/.fb2）`)
}

function sameBase(left, right) {
  return left.base === right.base
}

function toneExplainedBySandhi(engine, reference, index) {
  const actual = engine[index]
  const expected = reference[index]
  if (actual.tone === 2 && expected.tone === 3 && reference[index + 1]?.tone === 3) {
    return true
  }
  if (expected.tone === 2 && actual.tone === 3 && engine[index + 1]?.tone === 3) {
    return true
  }
  return ['yi', 'bu'].includes(actual.base) || ['yi', 'bu'].includes(expected.base)
}

function referenceSpan(alignment, start, end) {
  const reference = []
  for (let index = start; index < end; index += 1) {
    const item = alignment[index]
    if (item?.isZh && item.pinyin) reference.push(splitPhone(item.pinyin))
  }
  return reference
}

async function auditCorpus(files, lexicon, overlay, maxLength) {
  const candidates = new Map()
  const oovCandidates = new Map()
  const stats = {
    files: [],
    failed: [],
    sentences: 0,
    tokens: 0,
    chars: 0,
    sections: 0,
    overlayHits: 0,
    overlayWords: new Set(),
    mismatchOccurrences: 0,
    coveredMismatches: 0,
    misaligned: 0,
    oovOccurrences: 0,
    oovWords: new Set(),
  }
  const phraseKnownCache = new Map()

  for (const file of files) {
    let corpus
    try {
      corpus = await readCorpus(file)
    } catch (error) {
      stats.failed.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    stats.files.push({ path: corpus.path, sections: corpus.sections, chars: corpus.chars })
    stats.chars += corpus.chars
    stats.sections += corpus.sections

    for (const sentence of splitSentences(corpus.text)) {
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
      const tokens = tokenize(sentence, lexicon, maxLength)
      const knownWord = new Array(chars.length).fill(false)
      for (const token of tokens) {
        if (Array.from(token.word).length < 2) continue
        for (let index = token.start; index < token.end; index += 1) knownWord[index] = true
      }
      for (const token of tokens) {
        if (!isHanWord(token.word)) continue
        stats.tokens += 1
        if (overlay.has(token.word)) {
          stats.overlayHits += 1
          stats.overlayWords.add(token.word)
        }

        const engineReading = lexicon.get(token.word)
        if (!engineReading) continue
        const engine = phonesOf(engineReading)
        const reference = referenceSpan(alignment, token.start, token.end)
        if (engine.length !== reference.length) continue

        let baseDifference = false
        let toneDifference = false
        for (let index = 0; index < engine.length; index += 1) {
          if (!sameBase(engine[index], reference[index])) {
            baseDifference = true
            break
          }
          if (engine[index].tone === reference[index].tone) continue
          if (isNeutral(engine[index].tone) || isNeutral(reference[index].tone)) continue
          if (toneExplainedBySandhi(engine, reference, index)) continue
          toneDifference = true
        }
        if (!baseDifference && !toneDifference) continue

        stats.mismatchOccurrences += 1
        if (overlay.has(token.word)) {
          stats.coveredMismatches += 1
          continue
        }

        const kind = baseDifference ? 'syllable' : 'tone'
        const key = `${kind}|${token.word}|${engineReading}|${reference.map((phone) => `${phone.base}${phone.tone ?? 0}`).join(' ')}`
        let candidate = candidates.get(key)
        if (!candidate) {
          if (!phraseKnownCache.has(token.word)) {
            phraseKnownCache.set(token.word, hasPhraseReading(token.word))
          }
          candidate = {
            word: token.word,
            kind,
            engine: engineReading,
            reference: reference.map((phone) => `${phone.base}${phone.tone ?? ''}`).join(' '),
            count: 0,
            phrase: phraseKnownCache.get(token.word),
            contexts: [],
          }
          candidates.set(key, candidate)
        }
        candidate.count += 1
        if (candidate.contexts.length < 2) {
          const context = makeContext(sentence, token.start, token.end)
          if (!candidate.contexts.includes(context)) candidate.contexts.push(context)
        }
      }
      scanOovSegments(sentence, alignment, lexicon, knownWord, oovCandidates, stats)
    }
  }

  const sorted = Array.from(candidates.values()).sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'syllable' ? -1 : 1
    if (right.count !== left.count) return right.count - left.count
    return left.word.localeCompare(right.word, 'zh')
  })
  const sortedOov = Array.from(oovCandidates.values()).sort(
    (left, right) => right.count - left.count || left.word.localeCompare(right.word, 'zh'),
  )
  return { stats, candidates: sorted, oovCandidates: sortedOov }
}

function scanOovSegments(sentence, alignment, lexicon, knownWord, oovCandidates, stats) {
  let words
  try {
    words = segment(sentence, { ...PINYIN_OPTS, format: OutputFormat.ZhSegment })
  } catch {
    return
  }
  let offset = 0
  for (const word of words) {
    const start = offset
    const length = Array.from(word).length
    offset += length
    if (!isHanWord(word) || lexicon.has(word)) continue
    // A longer lexicon word already swallowed this span; the engine never falls back here.
    let covered = false
    for (let index = start; index < start + length; index += 1) {
      if (knownWord[index]) {
        covered = true
        break
      }
    }
    if (covered) continue

    stats.oovOccurrences += 1
    stats.oovWords.add(word)
    const chars = Array.from(word)
    const reference = referenceSpan(alignment, start, start + length)
    if (reference.length !== chars.length) continue
    const engine = chars.map((char) => {
      const reading = lexicon.get(char)
      return reading ? phonesOf(reading)[0] : null
    })
    if (engine.some((phone) => !phone)) continue

    let baseDifference = false
    let toneDifference = false
    for (let index = 0; index < engine.length; index += 1) {
      if (!sameBase(engine[index], reference[index])) {
        baseDifference = true
        break
      }
      if (engine[index].tone === reference[index].tone) continue
      if (isNeutral(engine[index].tone) || isNeutral(reference[index].tone)) continue
      if (toneExplainedBySandhi(engine, reference, index)) continue
      toneDifference = true
    }
    if (!baseDifference && !toneDifference) continue

    const kind = baseDifference ? 'syllable' : 'tone'
    const engineReading = engine.map((phone) => `${phone.base}${phone.tone ?? ''}`).join(' ')
    const key = `oov|${word}|${engineReading}|${reference.map((phone) => `${phone.base}${phone.tone ?? 0}`).join(' ')}`
    let candidate = oovCandidates.get(key)
    if (!candidate) {
      candidate = {
        word,
        kind,
        engine: engineReading,
        reference: reference.map((phone) => `${phone.base}${phone.tone ?? ''}`).join(' '),
        count: 0,
        contexts: [],
      }
      oovCandidates.set(key, candidate)
    }
    candidate.count += 1
    if (candidate.contexts.length < 2) {
      const context = makeContext(sentence, start, start + length)
      if (!candidate.contexts.includes(context)) candidate.contexts.push(context)
    }
  }
}

function printD2(result) {
  const { stats, candidates, oovCandidates } = result
  console.log('\nD2 语料扫描')
  if (stats.failed.length) {
    console.log(`跳过 ${stats.failed.length} 个文件：`)
    for (const item of stats.failed) console.log(`  - ${item}`)
  }
  if (!stats.files.length) {
    console.log('没有可扫描的语料。')
    return
  }
  for (const file of stats.files) {
    console.log(`  ${file.path}: ${file.sections} 节，${file.chars.toLocaleString()} 字`)
  }
  const coveredRate = stats.mismatchOccurrences
    ? ((stats.coveredMismatches / stats.mismatchOccurrences) * 100).toFixed(1)
    : '0.0'
  console.log(
    `句子 ${stats.sentences.toLocaleString()}，词元 ${stats.tokens.toLocaleString()}；` +
      `覆盖表命中 ${stats.overlayHits.toLocaleString()} 次（${stats.overlayWords.size} 个词条）`,
  )
  console.log(
    `与 pinyin-pro 不一致的词元 ${stats.mismatchOccurrences.toLocaleString()} 次，` +
      `覆盖表已覆盖 ${stats.coveredMismatches.toLocaleString()} 次（${coveredRate}%）`,
  )
  if (stats.misaligned) console.log(`对齐失败跳过 ${stats.misaligned} 句`)

  const syllable = candidates.filter((item) => item.kind === 'syllable').length
  const tone = candidates.length - syllable
  console.log(`候选 ${candidates.length} 个（音节 ${syllable} / 仅声调 ${tone}）`)
  if (!candidates.length) {
    console.log('未发现未覆盖的音节或声调差异。')
    return
  }

  console.log('\n按频次排序（[词组] 表示 pinyin-pro 命中了词组词典；[单字] 表示它只能按单字猜）：')
  for (const candidate of candidates.slice(0, top)) {
    const label = candidate.kind === 'syllable' ? '音节' : '声调'
    const source = candidate.phrase ? '词组' : '单字'
    console.log(
      `  ${String(candidate.count).padStart(3)}× [${label}] ${candidate.word}  词库=${candidate.engine}  pinyin-pro=${candidate.reference}  [${source}]`,
    )
    if (candidate.contexts[0]) console.log(`       «${candidate.contexts[0]}»`)
  }
  if (candidates.length > top) {
    console.log(`  …另有 ${candidates.length - top} 个候选，调整 --top 查看`)
  }

  console.log(
    `\nOOV 多字词（pinyin-pro 能分词、词库未收录）：${stats.oovOccurrences} 次 / ${stats.oovWords.size} 个词`,
  )
  if (stats.oovWords.size) {
    const words = Array.from(stats.oovWords).sort((left, right) => left.localeCompare(right, 'zh'))
    console.log(`  ${words.slice(0, 20).join('、')}${words.length > 20 ? '…' : ''}`)
  }
  if (!oovCandidates.length) {
    console.log('  未发现按单字兜底时读音有差异的 OOV 词。')
  } else {
    console.log(`  读音有差异的候选 ${oovCandidates.length} 个：`)
    for (const candidate of oovCandidates.slice(0, top)) {
      const label = candidate.kind === 'syllable' ? '音节' : '声调'
      console.log(
        `  ${String(candidate.count).padStart(3)}× [${label}] ${candidate.word}  单字兜底=${candidate.engine}  pinyin-pro=${candidate.reference}`,
      )
      if (candidate.contexts[0]) console.log(`       «${candidate.contexts[0]}»`)
    }
    if (oovCandidates.length > top) {
      console.log(`  …另有 ${oovCandidates.length - top} 个候选，调整 --top 查看`)
    }
  }

  console.log('\n说明：候选只代表“词库与 pinyin-pro 不一致”，不是自动判错；B 阶段应只采用人工确认过的高置信词。')
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const pack = manifest.packs?.find((item) => item.id === 'matcha-icefall-zh-baker')
  if (!pack) throw new Error('manifest 中找不到 matcha-icefall-zh-baker')
  const lexiconName = pack.model?.config?.lexicon
  const lexiconFile = pack.files?.find((file) => file.name === lexiconName)
  const tokensFile = pack.files?.find((file) => file.name === 'tokens.txt')
  if (!lexiconFile || !tokensFile) throw new Error('manifest 中找不到词典或 tokens.txt')

  const lexicon = parseLexicon(
    await readFile(join(ROOT, 'public', lexiconFile.url.replace(/^\/+/, '')), 'utf8'),
  )
  const tokens = parseTokens(
    await readFile(join(ROOT, 'public', tokensFile.url.replace(/^\/+/, '')), 'utf8'),
  )
  const parsed = parseOverlay(await readFile(OVERLAY_PATH, 'utf8'))
  const audit = auditOverlay(parsed.entries, lexicon, tokens)
  audit.duplicates = parsed.duplicates
  audit.structure.push(...parsed.structure)
  printD1(audit)

  if (overlayOnly) return
  const effective = new Map(lexicon)
  for (const [word, entry] of parsed.entries) effective.set(word, entry.reading)
  let maxLength = 1
  for (const word of effective.keys()) {
    maxLength = Math.max(maxLength, Array.from(word).length)
  }
  const files = fileArgs.length ? fileArgs : [join('public', 'sample.epub')]
  const corpus = await auditCorpus(files, effective, parsed.entries, maxLength)
  printD2(corpus)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
