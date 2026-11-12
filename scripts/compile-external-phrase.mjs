#!/usr/bin/env node
// Compile the vendored MIT phrase-pinyin-data into a static runtime overlay.
//
// Source, licence and the reason for the conservative filter are recorded in
// scripts/data/phrase-pinyin-data/SOURCE.md (read it before changing rules).
//
// Only genuine polyphone differences (a different INITIAL or FINAL from the
// bundled lexicon / single-character defaults) are emitted. Pure tone
// differences are excluded: most of them are 3+3 sandhi or the 一/不 sandhi
// already applied by the model lexicon and bookLexicon.ts, so importing them
// would UNDO correct readings. Words containing 一/不 are excluded outright.
//
// Safety model matches scripts/compile-overlay.mjs: default only writes a
// candidate + JSON report; --apply requires --confirm and zero conflicts.
// --verify regenerates and compares byte-for-byte with the committed asset.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import {
  ROOT, parseEntries, parseTokens, parseOverlay, TRAINED_NEUTRAL_PHONES,
} from './lib/reading.mjs'

const { normalizePinyinReading, normalizeOverlayText } = await import('../src/core/tts/pinyinTones.ts')

const SOURCE = join(ROOT, 'scripts/data/phrase-pinyin-data/pinyin.txt')
const LICENCE = join(ROOT, 'scripts/data/phrase-pinyin-data/LICENSE')
const LEXICON = join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt')
const TOKENS = join(ROOT, 'public/models/matcha-icefall-zh-baker/tokens.txt')
const CURATED = join(ROOT, 'src/core/tts/polyphones.v1.txt')
const OUT = join(ROOT, 'src/core/tts/phraseReadings.v1.txt')
const REPORT = join(ROOT, 'scripts/out/external-phrase-report.json')
const CANDIDATES = join(ROOT, 'scripts/out/external-phrase-candidates.txt')

const SOURCE_SHA256 = '5d4d86b1337bb2fca95bc5135564a821bfdb40597481ee3e3871bf52d4668622'
const VERSION = 'v0.20.0'
const MAX_ENTRIES = 2000
const HAN = /^\p{Script=Han}+$/u
const SANDHI_EXEMPT = new Set(['一', '不'])
const baseOf = (phone) => phone.replace(/[0-4]$/, '')
const phonesOf = (reading) => reading.split(/\s+/).filter((phone) => phone && phone !== '"')

const args = process.argv.slice(2)
const verify = args.includes('--verify')
const apply = args.includes('--apply')
const confirm = args.includes('--confirm')
const outArg = args.find((a) => a.startsWith('--out='))
const target = outArg ? resolve(ROOT, outArg.slice('--out='.length)) : OUT

async function main() {
  const [source, licence, lexiconText, tokensText, curatedText] = await Promise.all([
    readFile(SOURCE, 'utf8'), readFile(LICENCE, 'utf8'),
    readFile(LEXICON, 'utf8'), readFile(TOKENS, 'utf8'), readFile(CURATED, 'utf8'),
  ])

  const sha = createHash('sha256').update(source).digest('hex')
  if (sha !== SOURCE_SHA256) {
    throw new Error(`源数据校验和不匹配（期望 ${SOURCE_SHA256}，实际 ${sha}）；请核对 SOURCE.md 与固定版本。`)
  }
  if (!licence.includes('MIT License') || !licence.includes('Copyright (c) 2017 mozillazg')) {
    throw new Error('LICENSE 内容与核实记录不符，拒绝编译。')
  }

  const lexicon = parseEntries(lexiconText)
  const tokens = parseTokens(tokensText)
  const neutrals = TRAINED_NEUTRAL_PHONES
  const curated = parseOverlay(curatedText).entries
  const singleDefault = (char) => {
    const row = lexicon.get(char)
    const phone = row ? phonesOf(row)[0] : null
    return phone ?? null
  }

  const reject = {
    notHan: 0, badLength: 0, sandhiWord: 0, badPhones: 0,
    unknownPhone: 0, untrainedNeutral: 0, curated: 0, duplicate: 0,
    sameAsLexicon: 0, unchanged: 0, toneOnly: 0, boundary: 0,
    ambiguousWord: 0,
  }
  const accepted = new Map()
  const conflicts = []
  const seenReadings = new Map()
  const ambiguous = new Set()

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const word = line.slice(0, colon).trim()
    const pinyinText = line.slice(colon + 1).split('#')[0].trim()
    if (!HAN.test(word)) { reject.notHan += 1; continue }
    const chars = Array.from(word)
    if (chars.length < 2 || chars.length > 6) { reject.badLength += 1; continue }
    if (chars.some((char) => SANDHI_EXEMPT.has(char))) { reject.sandhiWord += 1; continue }
    const phones = normalizePinyinReading(pinyinText).split(/\s+/).filter(Boolean)
    if (phones.length !== chars.length) { reject.badPhones += 1; continue }
    if (phones.some((phone) => phone.includes('"'))) { reject.boundary += 1; continue }
    if (phones.some((phone) => !tokens.has(phone))) { reject.unknownPhone += 1; continue }
    if (phones.some((phone) => !/[0-4]$/.test(phone) && !neutrals.has(phone))) {
      reject.untrainedNeutral += 1
      continue
    }
    if (curated.has(word)) { reject.curated += 1; continue }
    // phrase-pinyin-data lists genuinely polyphonic words on several lines
    // (e.g. 那些: nà xiē AND nèi xiē). A static overlay cannot pick one, so
    // drop the whole word instead of silently taking the last row.
    const readingCandidate = phones.join(' ')
    const previousReading = seenReadings.get(word)
    if (previousReading !== undefined) {
      if (previousReading !== readingCandidate) {
        ambiguous.add(word)
        accepted.delete(word)
      } else {
        reject.duplicate += 1
      }
      continue
    }
    if (ambiguous.has(word)) continue
    seenReadings.set(word, readingCandidate)

    const existing = lexicon.get(word)
    const existingPhones = existing ? phonesOf(existing) : null
    const reading = phones.join(' ')
    if (existingPhones && existingPhones.join(' ') === reading) {
      reject.sameAsLexicon += 1
      continue
    }
    const diff = []
    for (let index = 0; index < chars.length; index += 1) {
      const ref = existingPhones?.[index] ?? singleDefault(chars[index])
      if (ref && ref !== phones[index]) {
        diff.push({ char: chars[index], from: ref, to: phones[index] })
      }
    }
    if (!diff.length) { reject.unchanged += 1; continue }
    if (diff.every((item) => baseOf(item.from) === baseOf(item.to))) {
      reject.toneOnly += 1
      continue
    }
    // Never shadow the curated table (it still wins at runtime, but emitting a
    // duplicate would break the one-row-per-word invariant in the audit gates).
    accepted.set(word, reading)
  }

  reject.ambiguousWord = ambiguous.size
  const rows = [...accepted.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .slice(0, MAX_ENTRIES)
  const truncated = accepted.size - rows.length
  const candidateText = [
    '# 外部词组读音候选（mozillazg/phrase-pinyin-data v0.20.0，MIT）',
    '# 由 scripts/compile-external-phrase.mjs 生成，需人工复核后 --apply --confirm',
    ...rows.map((word) => `${word} ${accepted.get(word)}`),
    '',
  ].join('\n')

  const header = [
    '# 通用词组读音补充（编译产物，请勿手工编辑）',
    `# 来源：mozillazg/phrase-pinyin-data ${VERSION}，MIT License，Copyright (c) 2017 mozillazg`,
    '# 许可全文与来源/筛选说明：scripts/data/phrase-pinyin-data/{LICENSE,SOURCE.md}',
    `# 生成命令：npm run phrase:compile -- --apply --confirm`,
    `# 源数据 SHA-256：${SOURCE_SHA256}`,
    '# 只含声母/韵母真变化的多音字词组；排除一/不变调、纯声调差异与人工表已有词。',
    '',
  ].join('\n')
  const body = header + normalizeOverlayText(
    rows.map((word) => `${word} ${accepted.get(word)}`).join('\n'),
  ) + '\n'

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      repository: 'https://github.com/mozillazg/phrase-pinyin-data',
      version: VERSION,
      licence: 'MIT',
      copyright: 'Copyright (c) 2017 mozillazg',
      file: 'pinyin.txt',
      sha256: sha,
    },
    entries: rows.length,
    truncated,
    conflicts,
    ambiguousWords: [...ambiguous].sort((a, b) => a.localeCompare(b, 'zh')),
    rejected: reject,
    rules: 'genuine initial/final difference only; see SOURCE.md',
  }

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
      console.error('外部词表编译产物已漂移，请运行 npm run phrase:compile -- --apply --confirm。')
      process.exitCode = 1
      return
    }
    console.log(`外部词表编译产物一致：${rows.length} 条 / sha256 ${sha.slice(0, 12)}`)
    return
  }

  await mkdir(dirname(REPORT), { recursive: true })
  await writeFile(CANDIDATES, candidateText, 'utf8')
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`候选 ${rows.length} 条；过滤明细 ${JSON.stringify(reject)}`)
  console.log(`候选文件 ${CANDIDATES}`)
  console.log(`报告 ${REPORT}`)

  if (!apply) {
    console.log('默认只产候选。写入运行时资产需 --apply --confirm。')
    return
  }
  if (!confirm) throw new Error('--apply 必须同时给出 --confirm')
  if (conflicts.length) throw new Error(`存在 ${conflicts.length} 条冲突，拒绝写入`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body, 'utf8')
  console.log(`已写入 ${target}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
