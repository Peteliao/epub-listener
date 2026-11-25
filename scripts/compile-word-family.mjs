#!/usr/bin/env node
// Dev-only B1 word-family candidate compiler.
//
// Safety model:
//   * Dictionary/curated readings are the ONLY source of phonemes. A corpus
//     supplies complete sentences as evidence; it never supplies a reading.
//   * Output is scope=word/status=candidate JSONL under scripts/out. This script
//     has no --apply path and never writes polyphones.v1.txt or readingRules.
//   * Existing effective whole words are deduplicated when identical and
//     rejected as conflicts when different. Every emitted row describes one
//     differing character, ready for human review before compile-overlay.mjs.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadMatchaAssets, phoneticPhones, ROOT, tokenizeSpans } from './lib/reading.mjs'
import { loadCorpus, splitSentences } from './lib/corpus.mjs'

const OUT_PATH = resolve(ROOT, 'scripts/out/word-family-candidates.jsonl')
const REPORT_PATH = resolve(ROOT, 'scripts/out/word-family-report.json')
const HAN = /^\p{Script=Han}+$/u
const TWO_HAN = /^\p{Script=Han}{2}$/u
const PHONE = /^[a-z]+[0-5]?$/
const CORPUS_EXTENSIONS = new Set(['.txt', '.md', '.epub', '.fb2', '.jsonl'])
const POUR_OBJECTS = new Set(Array.from('水茶酒饭菜油汤药垃圾'))

export const TEMPLATES = Object.freeze({
  yiVerb: Object.freeze({ key: 'yiVerb', label: '一+单音节动词' }),
  xDao: Object.freeze({ key: 'xDao', label: 'X+倒' }),
  vGei: Object.freeze({ key: 'vGei', label: 'V+给' }),
})

// These are lexical exclusions, not pronunciation suggestions. In particular,
// 倒水/倒茶 are dào (pouring), while 给予/配给 are jǐ and do not match V+给.
export const EXCLUDED_WORDS = Object.freeze([
  '倒水', '倒茶', '倒酒', '倒饭', '倒菜', '倒油', '倒汤', '倒药', '倒垃圾',
  '给予', '配给', '供给', '自给', '补给', '进给', '仰给', '薪给', '取给',
  '一了', '一发', '一任', '一代', '一份', '一共', '一应', '一度', '一得',
  '一扎', '一打', '一撮', '一宿', '一服', '一朝', '一期', '一条', '一行',
  '一角', '一贯', '一觉', '一给', '不给', '给给', '倒倒',
])
const EXCLUDED = new Set(EXCLUDED_WORDS)

// A small, reviewable seed vocabulary. Contextual source words disambiguate
// polyphones; plain single-character verbs use their effective dictionary row.
// Additional verbs are discovered only from valid X+倒 / V+给 dictionary rows.
const VERB_SEEDS = Object.freeze([
  ['倒', '倒下', 0], ['跌', '跌倒', 0], ['晃', '一晃', 1], ['颤', '颤抖', 0],
  ['缩', '缩小', 0], ['躺', '躺倒', 0], ['摔', '摔倒', 0], ['晕', '晕倒', 0],
  ['绊', '绊倒', 0], ['推', '推倒', 0], ['吹', '吹倒', 0], ['撞', '撞倒', 0],
  ['还', '还给', 0], ['教', '教给', 0], ['发', '发给', 0], ['分', '分给', 0],
  ['吓', '吓倒', 0],
  ...Array.from('歪坐扑仰走跑跳飞笑看听说读写拿抛累开关起回到进出上下拉扳打放压举搬端递送献赐赠拨挂靠躲藏伸缩打滚爬钻砍割挖填涂扫擦洗切炒煮烤吃喝睡坐站躺').map(
    (char) => [char, null, 0],
  ),
])
const NON_VERB_DAO_PREFIXES = new Set(Array.from('官不'))
const NON_VERB_GEI_PREFIXES = new Set(Array.from('薪取配供补自进仰给'))

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function phonesOf(reading) {
  return phoneticPhones(String(reading ?? ''))
}

function layerOf(assets, word) {
  if (assets.overlay?.entries?.has(word)) return 'overlay'
  return 'lexicon'
}

function validPhone(phone, assets) {
  return PHONE.test(phone)
    && assets.tokens.has(phone)
    && (/[0-5]$/.test(phone) || assets.neutrals.has(phone))
}

function sourceRecord(assets, word, offset, phone) {
  return { word, layer: layerOf(assets, word), offset, phone }
}

function discoverVerbReadings(assets) {
  const readings = new Map()
  const conflicts = []
  const add = (char, phone, source, priority) => {
    if (!char || !phone || !validPhone(phone, assets)) return
    const list = readings.get(char) ?? []
    const existing = list.find((item) => item.phone === phone)
    if (existing && priority < existing.priority) {
      existing.source = source
      existing.priority = priority
    } else if (!existing) {
      list.push({ phone, source, priority })
    }
    readings.set(char, list)
  }

  const plainSeeds = []
  for (const [char, word, offset] of VERB_SEEDS) {
    if (!word) {
      plainSeeds.push(char)
      continue
    }
    const reading = assets.effective.get(word)
    const phone = phonesOf(reading)[offset]
    if (reading && phone) add(char, phone, sourceRecord(assets, word, offset, phone), 0)
  }

  for (const word of [...assets.effective.keys()].sort(compareText)) {
    if (!TWO_HAN.test(word)) continue
    const chars = Array.from(word)
    const phones = phonesOf(assets.effective.get(word))
    if (phones.length !== 2) continue
    if (chars[1] === '倒' && phones[1] === 'dao3' && !NON_VERB_DAO_PREFIXES.has(chars[0])) {
      add(chars[0], phones[0], sourceRecord(assets, word, 0, phones[0]), 1)
    }
    if (chars[1] === '给' && phones[1] === 'gei3' && !NON_VERB_GEI_PREFIXES.has(chars[0])) {
      add(chars[0], phones[0], sourceRecord(assets, word, 0, phones[0]), 1)
    }
  }

  // A contextual whole-word reading outranks the single-character default.
  // This avoids treating dictionary polysemy (e.g. 躺倒 tang2 vs 躺 tang3) as
  // a source conflict when a template-specific source already disambiguates it.
  for (const char of plainSeeds) {
    if (readings.has(char)) continue
    const phone = phonesOf(assets.effective.get(char))[0]
    add(char, phone, sourceRecord(assets, char, 0, phone), 3)
  }

  const verbs = new Map()
  for (const char of [...readings.keys()].sort(compareText)) {
    const options = readings.get(char)
    const distinct = [...new Set(options.map((item) => item.phone))].sort(compareText)
    if (distinct.length > 1) {
      conflicts.push({
        kind: 'source-reading', char,
        readings: distinct,
        sources: options.map((item) => item.source),
        reason: '有效词典/人工表对同一动词给出冲突读音，拒绝扩散',
      })
      continue
    }
    const selected = [...options].sort((a, b) => a.priority - b.priority || compareText(a.source.word, b.source.word))[0]
    verbs.set(char, { char, phone: selected.phone, source: selected.source })
  }
  return { verbs, conflicts }
}

function complementSource(assets, char, phone, preferred) {
  for (const word of preferred) {
    const reading = assets.effective.get(word)
    const chars = Array.from(word)
    const offset = chars.lastIndexOf(char)
    const actual = phonesOf(reading)[offset]
    if (offset >= 0 && actual === phone && validPhone(actual, assets)) {
      return sourceRecord(assets, word, offset, actual)
    }
  }
  for (const word of [...assets.effective.keys()].sort(compareText)) {
    if (!word.endsWith(char)) continue
    const offset = Array.from(word).length - 1
    const actual = phonesOf(assets.effective.get(word))[offset]
    if (actual === phone && validPhone(actual, assets)) return sourceRecord(assets, word, offset, actual)
  }
  return null
}

function currentPhones(assets, word) {
  const whole = assets.effective.get(word)
  if (whole !== undefined) return phonesOf(whole)
  return Array.from(word).map((char) => phonesOf(assets.effective.get(char))[0] ?? null)
}

function proposalFor(templateKey, verb, yiPhone, assets) {
  const chars = Array.from(`${templateKey === 'yiVerb' ? '一' : verb.char}${templateKey === 'yiVerb' ? verb.char : templateKey === 'xDao' ? '倒' : '给'}`)
  const word = chars.join('')
  if (EXCLUDED.has(word)) return null
  if (templateKey === 'xDao' && (verb.char === '倒' || verb.char === '一')) return null
  if (templateKey === 'vGei' && verb.char === '给') return null

  let reading
  let sources
  if (templateKey === 'yiVerb') {
    reading = [yiPhone, verb.phone]
    const baseYi = phonesOf(assets.effective.get('一'))[0]
    sources = [sourceRecord(assets, '一', 0, baseYi), verb.source]
  } else if (templateKey === 'xDao') {
    const source = complementSource(assets, '倒', 'dao3', ['倒下', '摔倒', '晕倒', '跌倒'])
    if (!source) return null
    reading = [verb.phone, 'dao3']
    sources = [verb.source, source]
  } else {
    const source = complementSource(assets, '给', 'gei3', ['递给', '交给', '送给', '还给'])
    if (!source) return null
    reading = [verb.phone, 'gei3']
    sources = [verb.source, source]
  }
  if (reading.length !== chars.length || reading.some((phone) => !validPhone(phone, assets))) return null
  return { word, templateKey, reading, sources }
}

function isExcludedOccurrence(templateKey, chars, start, end) {
  // Do not attach a valid X+倒 elsewhere in the sentence to a pouring phrase
  // such as 倒水/倒茶. The lexical blacklist above handles whole-word rows.
  if (templateKey !== 'xDao') return false
  return POUR_OBJECTS.has(chars[end] ?? '')
}

export function compileWordFamily({ assets, corpora = [] }) {
  const { verbs, conflicts } = discoverVerbReadings(assets)
  const yiPhone = phonesOf(assets.effective.get('一'))[0]
  const proposals = []
  const skipped = []

  if (!['yi1', 'yi2', 'yi4'].includes(yiPhone)) {
    skipped.push({ word: '一', reason: '有效词典缺少可用的一基音' })
  }
  for (const verb of verbs.values()) {
    // 一 is yì before first/second/third tone and yí before fourth tone.
    const sandhi = verb.phone.endsWith('4') ? 'yi2' : 'yi4'
    for (const templateKey of Object.keys(TEMPLATES)) {
      if (templateKey === 'yiVerb' && !['yi1', 'yi2', 'yi4'].includes(yiPhone)) continue
      const proposal = proposalFor(templateKey, verb, sandhi, assets)
      if (proposal) proposals.push(proposal)
    }
  }

  const dedup = []
  const accepted = []
  for (const proposal of proposals) {
    const { word, reading } = proposal
    const current = currentPhones(assets, word)
    const whole = assets.effective.get(word)
    if (whole !== undefined) {
      if (current.length === reading.length && current.every((phone, index) => phone === reading[index])) {
        dedup.push({ word, reading: whole, layer: layerOf(assets, word), reason: 'effective-reading-identical' })
      } else {
        conflicts.push({
          kind: 'effective-reading', word, template: TEMPLATES[proposal.templateKey].label,
          current: whole, proposed: reading.join(' '), layer: layerOf(assets, word),
          reason: '已有 effective/overlay 整词读数不同，拒绝候选',
        })
      }
      continue
    }
    if (current.length === reading.length && current.every((phone, index) => phone === reading[index])) {
      dedup.push({ word, reading: reading.join(' '), layer: 'fallback', reason: 'fallback-reading-identical' })
      continue
    }
    accepted.push(proposal)
  }

  const contexts = collectContexts(accepted, corpora, assets)
  const rows = []
  for (const proposal of accepted) {
    const current = currentPhones(assets, proposal.word)
    const evidence = contexts.get(proposal.word) ?? []
    for (let offset = 0; offset < proposal.reading.length; offset += 1) {
      if (current[offset] === proposal.reading[offset]) continue
      rows.push({
        id: `wf-${proposal.templateKey}-${proposal.word}-${offset}`,
        status: 'candidate',
        class: 'phone',
        scope: 'word',
        template: TEMPLATES[proposal.templateKey].label,
        templateKey: proposal.templateKey,
        word: proposal.word,
        char: Array.from(proposal.word)[offset],
        offset,
        phone: proposal.reading[offset],
        from: current[offset] ?? null,
        reading: proposal.reading.join(' '),
        boundary: 'keep',
        source: 'word-family-dictionary',
        readingSources: proposal.sources,
        confidence: 'candidate',
        context: evidence[0]?.sentence ?? null,
        contexts: evidence,
        evidence: evidence.map((item) => item.sentence),
        note: evidence.length
          ? '词典读音＋真实完整语境；仍需人工确认后才能进入 readingRules'
          : '无真实语境：仅由词典生成，需人工补证后再确认',
      })
    }
  }
  rows.sort((a, b) =>
    compareText(a.word, b.word) || a.offset - b.offset || compareText(a.id, b.id))
  dedup.sort((a, b) => compareText(a.word, b.word))
  skipped.sort((a, b) => compareText(a.word, b.word))

  const words = new Set(rows.map((row) => row.word))
  const withContext = [...words].filter((word) => (contexts.get(word) ?? []).length > 0)
  return {
    rows,
    conflicts,
    dedup,
    skipped,
    contexts,
    summary: {
      candidates: rows.length,
      words: words.size,
      withContext: withContext.length,
      withoutContext: words.size - withContext.length,
      deduplicated: dedup.length,
      conflicts: conflicts.length,
      skipped: skipped.length,
      verbs: verbs.size,
      corpusFiles: corpora.length,
      corpusSentences: corpora.reduce((sum, corpus) => sum + corpus.sentences, 0),
      noRealContext: corpora.length === 0,
      templates: Object.fromEntries(Object.entries(TEMPLATES).map(([key, value]) => [
        key, rows.filter((row) => row.templateKey === key).length,
      ])),
    },
  }
}

export function collectContexts(proposals, corpora, assets) {
  const byWord = new Map(proposals.map((proposal) => [proposal.word, proposal]))
  const found = new Map()
  const maxLength = assets.maxLength ?? Math.max(2, ...[...assets.effective.keys()].map((word) => Array.from(word).length))
  for (const corpus of corpora) {
    for (const sentence of corpus.sentencesList ?? splitSentences(corpus.text)) {
      const chars = Array.from(sentence)
      const spans = tokenizeSpans(sentence, assets.effective, maxLength)
      for (const [word, proposal] of byWord) {
        const wordChars = Array.from(word)
        for (let start = 0; start <= chars.length - wordChars.length; start += 1) {
          if (!wordChars.every((char, offset) => chars[start + offset] === char)) continue
          const end = start + wordChars.length
          // Candidates are OOV, so longest-match cannot return them directly.
          // Reject only positions swallowed by an existing longer word; an
          // existing word beginning inside the candidate (倒 + 给我) is fine,
          // because the proposed whole word would win once it is approved.
          const blocked = spans.some((span) =>
            (span.start < start && span.end > start)
            || (span.start === start && span.end > end))
          if (!blocked && !isExcludedOccurrence(proposal.templateKey, chars, start, end)) {
            const list = found.get(word) ?? []
            const occurrence = { sentence, source: corpus.source }
            if (list.length < 3 && !list.some((item) => item.sentence === sentence && item.source === corpus.source)) {
              list.push(occurrence)
            }
            found.set(word, list)
          }
        }
      }
    }
  }
  return found
}

function corpusDisplayPath(path) {
  return relative(ROOT, path).replaceAll('\\', '/') || path
}

async function corpusFiles(path) {
  const info = await stat(path)
  if (info.isFile()) return [path]
  if (!info.isDirectory()) throw new Error(`语料不是文件或目录：${path}`)
  const files = []
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => compareText(a.name, b.name))
    for (const entry of entries) {
      const child = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && CORPUS_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(child)
    }
  }
  await walk(path)
  if (!files.length) throw new Error(`语料目录没有可读取的 EPUB/TXT/MD/FB2/JSONL：${path}`)
  return files.sort(compareText)
}

export async function loadWordFamilyCorpora(paths) {
  const corpora = []
  for (const input of paths) {
    for (const path of await corpusFiles(input)) {
      const corpus = await loadCorpus(path)
      const sentencesList = splitSentences(corpus.text)
      corpora.push({
        ...corpus,
        source: corpusDisplayPath(path),
        sentencesList,
        sentences: sentencesList.length,
      })
    }
  }
  return corpora
}

export function serializeCandidates(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`
}

export function parseCandidateJsonl(text) {
  const rows = []
  const errors = []
  const ids = new Set()
  const positions = new Set()
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      errors.push(`第 ${index + 1} 行不是合法 JSON`)
      continue
    }
    rows.push(row)
    if (ids.has(row?.id)) errors.push(`第 ${index + 1} 行 id 重复：${row?.id}`)
    if (positions.has(`${row?.word}\0${row?.offset}`)) errors.push(`第 ${index + 1} 行差异字重复：${row?.word}/${row?.offset}`)
    ids.add(row?.id)
    positions.add(`${row?.word}\0${row?.offset}`)
  }
  return { rows, errors }
}

export function validateCandidateRows(rows) {
  const errors = []
  if (!Array.isArray(rows)) return ['候选输出必须是 JSONL 行数组']
  const ids = new Set()
  const positions = new Set()
  rows.forEach((row, index) => {
    const at = `第 ${index + 1} 行`
    if (!row || typeof row !== 'object') { errors.push(`${at} 不是对象`); return }
    if (row.status !== 'candidate' || row.scope !== 'word' || row.class !== 'phone') errors.push(`${at} status/scope/class 非法`)
    if (!TEMPLATES[row.templateKey] || row.template !== TEMPLATES[row.templateKey].label) errors.push(`${at} template 非法`)
    if (typeof row.word !== 'string' || !HAN.test(row.word) || Array.from(row.word).length < 2) errors.push(`${at} word 非法`)
    if (EXCLUDED.has(row.word)) errors.push(`${at} 命中排除词 ${row.word}`)
    if (!Number.isInteger(row.offset) || row.offset < 0 || Array.from(row.word)[row.offset] !== row.char) errors.push(`${at} offset/char 不匹配`)
    if (!PHONE.test(row.phone ?? '')) errors.push(`${at} phone 非法`)
    if (row.boundary !== 'keep') errors.push(`${at} boundary 非法`)
    const reading = typeof row.reading === 'string' ? row.reading.split(/\s+/) : []
    if (reading.length !== Array.from(row.word).length || reading[row.offset] !== row.phone) errors.push(`${at} reading 与差异字不一致`)
    if (row.from !== null && !PHONE.test(row.from ?? '')) errors.push(`${at} from 非法`)
    if (row.id !== `wf-${row.templateKey}-${row.word}-${row.offset}`) errors.push(`${at} id 非法`)
    if (ids.has(row.id)) errors.push(`${at} id 重复`)
    if (positions.has(`${row.word}\0${row.offset}`)) errors.push(`${at} 差异字重复`)
    ids.add(row.id)
    positions.add(`${row.word}\0${row.offset}`)
    if (!Array.isArray(row.readingSources) || !row.readingSources.length || row.readingSources.some((source) =>
      !source || typeof source.word !== 'string' || !HAN.test(source.word)
      || !['lexicon', 'overlay'].includes(source.layer)
      || !Number.isInteger(source.offset) || source.offset < 0
      || !PHONE.test(source.phone ?? ''))) errors.push(`${at} readingSources 非法`)
    if (!Array.isArray(row.contexts) || row.contexts.some((item) =>
      !item || typeof item.sentence !== 'string' || !item.sentence.trim() || typeof item.source !== 'string')) errors.push(`${at} contexts 非法`)
    if (!Array.isArray(row.evidence) || row.evidence.some((item) => typeof item !== 'string' || !item.trim())) errors.push(`${at} evidence 非法`)
    if (row.context !== (row.contexts?.[0]?.sentence ?? null)) errors.push(`${at} context 与 contexts 不一致`)
    if (typeof row.note !== 'string' || !row.note.trim()) errors.push(`${at} 缺少 note`)
    if (row.templateKey === 'xDao' && (!row.word.endsWith('倒') || reading.at(-1) !== 'dao3')) errors.push(`${at} X+倒只能候选 dao3`)
    if (row.templateKey === 'vGei' && (!row.word.endsWith('给') || reading.at(-1) !== 'gei3')) errors.push(`${at} V+给只能候选 gei3`)
    if (row.templateKey === 'yiVerb' && !row.word.startsWith('一')) errors.push(`${at} 一+动词模板不匹配`)
  })
  const sorted = [...rows].sort((a, b) => compareText(a?.word ?? '', b?.word ?? '') || (a?.offset ?? 0) - (b?.offset ?? 0) || compareText(a?.id ?? '', b?.id ?? ''))
  if (JSON.stringify(rows) !== JSON.stringify(sorted)) errors.push('候选输出未按 word/offset/id 确定性排序')
  return errors
}

function parseArgs(argv) {
  const options = { corpora: [], out: OUT_PATH, report: REPORT_PATH, verify: false }
  for (const arg of argv) {
    if (arg.startsWith('--corpus=')) {
      const value = arg.slice(9)
      if (!value) throw new Error('--corpus 不能为空')
      options.corpora.push(resolve(ROOT, value))
    } else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--report=')) options.report = resolve(ROOT, arg.slice(9))
    else if (arg === '--verify') options.verify = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}；本脚本只产候选，不提供 --apply`)
  }
  return options
}

function printSummary(result, options) {
  const s = result.summary
  console.log(`词族候选 ${s.words} 词 / ${s.candidates} 个差异字；去重 ${s.deduplicated} / 冲突 ${s.conflicts} / 跳过 ${s.skipped}`)
  console.log(`模板 ${Object.entries(s.templates).map(([key, count]) => `${TEMPLATES[key].label} ${count}`).join(' · ')}`)
  console.log(`真实完整语境 ${s.withContext} 词 / 无真实语境 ${s.withoutContext} 词${s.noRealContext ? '（未提供 corpus）' : ''}`)
  if (s.noRealContext) console.log('注意：当前候选没有真实语境，不能据此直接确认生产规则。')
  for (const conflict of result.conflicts) console.log(`  冲突 ${conflict.word ?? conflict.char}: ${conflict.reason}`)
  console.log(`候选 ${options.out}`)
  if (!options.verify) console.log(`报告 ${options.report}`)
  console.log('安全边界：默认只写 scripts/out 候选；确认流程仍由 compile-overlay.mjs 仅接收 approved 整词规则。')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`用法: node scripts/compile-word-family.mjs [--corpus=<epub或目录>] [--out=<jsonl>] [--report=<json>] [--verify]

模板：一+单音节动词、X+倒（只 dao3）、V+给（只 gei3）。
无 corpus 时从有效词典/人工表生成候选并明确标注无真实语境；语料只补完整句子。
--verify 重复生成、校验结构并逐字比对已有候选；风险/冲突不单独导致失败。`)
    return
  }
  const assets = await loadMatchaAssets()
  const corpora = await loadWordFamilyCorpora(options.corpora)
  const result = compileWordFamily({ assets, corpora })
  const repeated = compileWordFamily({ assets, corpora })
  const expected = serializeCandidates(result.rows)
  const structureErrors = validateCandidateRows(result.rows)
  if (expected !== serializeCandidates(repeated.rows)) structureErrors.push('重复生成结果不确定')
  if (structureErrors.length) throw new Error(`候选结构错误：\n${structureErrors.join('\n')}`)

  if (options.verify) {
    const current = await readFile(options.out, 'utf8')
    const parsed = parseCandidateJsonl(current)
    const outputErrors = validateCandidateRows(parsed.rows)
    if (parsed.errors.length || outputErrors.length) {
      throw new Error(`输出结构错误：\n${[...parsed.errors, ...outputErrors].join('\n')}`)
    }
    if (current !== expected) throw new Error('候选输出已漂移，请用相同 corpus 参数重新运行 compile:word-family')
    printSummary(result, options)
    console.log('验证通过：结构合法、重复生成一致、输出逐字一致。')
    return
  }

  await mkdir(dirname(options.out), { recursive: true })
  await mkdir(dirname(options.report), { recursive: true })
  await writeFile(options.out, expected, 'utf8')
  await writeFile(options.report, `${JSON.stringify({
    summary: result.summary,
    conflicts: result.conflicts,
    deduplicated: result.dedup,
    skipped: result.skipped,
    candidates: result.rows,
  }, null, 2)}\n`, 'utf8')
  printSummary(result, options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
