#!/usr/bin/env node
// Dev-only: turn exported pronunciation feedback JSONL into overlay candidates.
// Never imported by the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OutputFormat, convert, pinyin, segment } from 'pinyin-pro'
import { loadMatchaAssets, phoneticPhones } from './lib/reading.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OVERLAY_PATH = resolve(ROOT, 'src/core/tts/polyphones.v1.txt')
const HAN = /^\p{Script=Han}+$/u
const TONE_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]/u

function parseArgs(argv) {
  const files = []
  let out = null
  let golden = null
  let risks = null
  let triage = null
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg.startsWith('--golden=')) golden = arg.slice('--golden='.length)
    else if (arg.startsWith('--risks=')) risks = arg.slice('--risks='.length)
    else if (arg.startsWith('--triage=')) triage = arg.slice('--triage='.length)
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('--')) files.push(arg)
  }
  return { files, out, golden, risks, triage }
}

function printHelp() {
  console.log(`用法: node scripts/reports-to-overlay.mjs <reports.jsonl> [--out=path] [--golden=path]

从「读音反馈记录」导出的 JSONL 生成 polyphones.v1.txt 候选行。
按「当前有效词典读音」与「反馈期望读音」分为四类：
  new              词典无此词，可新增整词条目
  override-lexicon 基础词典已有此词但读音不符，覆盖它（旧版会漏掉）
  conflict-curated 人工表已有此词且读音不同，需人工决定是否覆盖
  acoustic         读音已正确，属吞音/断词等声学问题，转声学审计
单字语境不再静默跳过，而是标记 needs-family-rule 并给出同类位置数。
--risks=<file> 关联 scan-pronunciation-risks.mjs 的清单，输出每条反馈
    在全书可覆盖的同类位置数；--triage=<file> 输出分类结果 JSONL。
--golden 额外输出读音黄金集候选行。所有结果都需人工复核后再合并。

示例:
  node scripts/reports-to-overlay.mjs ~/Downloads/pronunciation-reports-20261102.jsonl
  node scripts/reports-to-overlay.mjs reports.jsonl --risks=scripts/out/pronunciation-risks.jsonl --triage=scripts/out/triage.jsonl
  node scripts/reports-to-overlay.mjs reports.jsonl --out=scripts/out/overlay-candidates.txt --golden=scripts/out/golden-candidates.jsonl`)
}

function normalizePhone(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return ''
  value = value.normalize('NFC').toLowerCase().replace(/ü/g, 'v')
  if (TONE_MARK.test(value)) {
    value = convert(value, { format: 'symbolToNum' })
      .toLowerCase()
      .replace(/ü/g, 'v')
  }
  return value.replace(/[05]$/u, '')
}

function splitPhones(reading) {
  return String(reading ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizePhone)
}

function pinyinPhones(word) {
  return (pinyin(word, { toneType: 'num', type: 'array' }) ?? []).map(
    normalizePhone,
  )
}

function parseOverlay(text) {
  const entries = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (word) entries.set(word, phones.join(' '))
  }
  return entries
}

function groupsOf(text) {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    return Array.from(segmenter.segment(text), (part) => ({
      word: part.segment,
      start: part.index,
      end: part.index + part.segment.length,
    }))
  }

  const groups = []
  let start = 0
  for (const chars of segment(text, { format: OutputFormat.ZhArray })) {
    const word = chars.join('')
    groups.push({ word, start, end: start + word.length })
    start += word.length
  }
  return groups
}

function storedWordOf(text, mark, charIndex) {
  const word = typeof mark.word === 'string' ? mark.word : ''
  const start = Number(mark.wordStart)
  const end = Number(mark.wordEnd)
  if (!word || !HAN.test(word)) return null
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end <= start || end > text.length) return null
  if (text.slice(start, end) !== word) return null
  if (charIndex < start || charIndex >= end) return null
  return { word, start, end }
}

function loadReports(path) {
  return readFile(path, 'utf8').then((text) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`第 ${index + 1} 行不是有效 JSON`)
        }
      }),
  )
}

function collectCandidates(reports, effective) {
  const candidates = new Map()
  const words = new Map()
  const warnings = []
  const singleCharMarks = []
  let markCount = 0

  for (const report of reports) {
    const paragraph = report?.paragraph
    const marks = Array.isArray(report?.marks) ? report.marks : []
    if (!paragraph?.text || !marks.length) continue

    const groups = groupsOf(paragraph.text)
    const reportWords = new Set()
    for (const mark of marks) {
      const charIndex = Number(mark.charIndex)
      const phone = normalizePhone(mark.expectedPinyin)
      if (!Number.isInteger(charIndex) || !phone) {
        warnings.push(`${report?.id ?? '未知报告'}：标记缺少读音或位置`)
        continue
      }
      if (!/^[a-z]+[1-4]?$/.test(phone)) {
        warnings.push(`${report?.id ?? '未知报告'}：读音「${mark.expectedPinyin}」格式无效`)
        continue
      }

      const stored = storedWordOf(paragraph.text, mark, charIndex)
      const group =
        stored && Array.from(stored.word).length >= 2
          ? stored
          : groups.find(
              (item) => charIndex >= item.start && charIndex < item.end,
            )
      if (!group || !HAN.test(group.word)) {
        warnings.push(
          `${report?.id ?? '未知报告'}：「${mark.char}」不在可用的中文词组内`,
        )
        continue
      }

      const chars = Array.from(group.word)
      if (chars.length < 2) {
        singleCharMarks.push({
          char: mark.char,
          phone,
          text: paragraph.text,
          reportId: report?.id ?? '未知报告',
        })
        warnings.push(
          `${report?.id ?? '未知报告'}：「${mark.char}」只有单字语境，不生成单字条目（needs-family-rule）`,
        )
        continue
      }
      if (chars.length > 4) {
        warnings.push(
          `${report?.id ?? '未知报告'}：词组「${group.word}」超过 4 字，已跳过`,
        )
        continue
      }
      const relative = charIndex - group.start
      let offset = 0
      let charOffset = -1
      for (let index = 0; index < chars.length; index += 1) {
        if (offset === relative) {
          charOffset = index
          break
        }
        offset += chars[index].length
      }
      if (charOffset < 0 || chars[charOffset] !== mark.char) {
        warnings.push(
          `${report?.id ?? '未知报告'}：无法在「${group.word}」中定位「${mark.char}」`,
        )
        continue
      }

      const info = words.get(group.word) ?? {
        word: group.word,
        chars,
        positions: new Map(),
        reports: new Set(),
        voices: new Map(),
        samples: [],
      }
      const position = info.positions.get(charOffset) ?? {
        char: mark.char,
        options: new Map(),
      }
      if (position.char !== mark.char) {
        warnings.push(
          `${report?.id ?? '未知报告'}：词组「${group.word}」第 ${charOffset + 1} 字与标记不一致`,
        )
        continue
      }
      position.options.set(phone, (position.options.get(phone) ?? 0) + 1)
      info.positions.set(charOffset, position)
      if (info.samples.length < 2) {
        info.samples.push({
          text: paragraph.text,
          char: mark.char,
          charIndex,
          phone,
        })
      }

      if (!reportWords.has(group.word)) {
        reportWords.add(group.word)
        info.reports.add(report.id ?? '未知报告')
        const voice = report.voice
        if (voice?.voiceLabel) {
          const label = `${voice.voiceLabel}${voice.packVersion ? ` ${voice.packVersion}` : ''}`
          info.voices.set(label, (info.voices.get(label) ?? 0) + 1)
        }
      }
      words.set(group.word, info)
      markCount += 1
    }
  }

  for (const info of words.values()) {
    const conflicts = []
    for (const [charOffset, position] of info.positions) {
      if (position.options.size > 1) {
        conflicts.push(
          `${info.chars[charOffset]}→${[...position.options.keys()].join('/')}`,
        )
      }
    }
    if (conflicts.length) {
      warnings.push(
        `词组「${info.word}」读音冲突（${conflicts.join('，')}），已跳过`,
      )
      continue
    }

    // Start from the word's *effective* reading when it exists; only the marked
    // character is replaced. Using pinyin-pro for the untouched characters
    // invented false conflicts (占便宜 became zhan4 pian2 yi, not ... yi2).
    const currentPhones = phoneticPhones(effective.get(info.word) ?? '')
    const phones = currentPhones.length === info.chars.length
      ? [...currentPhones]
      : pinyinPhones(info.word)
    if (phones.length !== info.chars.length) {
      warnings.push(`词组「${info.word}」读音与字数不一致，已跳过`)
      continue
    }
    for (const [charOffset, position] of info.positions) {
      phones[charOffset] = [...position.options.keys()][0]
    }

    const key = `${info.word} ${phones.join(' ')}`
    candidates.set(key, {
      word: info.word,
      phones: phones.join(' '),
      reports: info.reports,
      voices: info.voices,
      samples: info.samples,
    })
  }

  return { candidates, warnings, markCount, singleCharMarks }
}

/** Index a risk inventory by word and by character for impact reporting. */
async function loadRiskIndex(path) {
  if (!path) return null
  const byWord = new Map()
  const byChar = new Map()
  try {
    const text = await readFile(resolve(ROOT, path), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (typeof record.word === 'string') {
        byWord.set(record.word, (byWord.get(record.word) ?? 0) + (record.count ?? 1))
      }
      if (typeof record.family === 'string') {
        byChar.set(record.family, (byChar.get(record.family) ?? 0) + (record.count ?? 1))
      }
    }
  } catch (error) {
    console.warn(`  无法读取风险清单 ${path}: ${error.message}`)
    return null
  }
  return { byWord, byChar }
}

function impactOf(word, char, riskIndex) {
  if (!riskIndex) return null
  return {
    wordMatches: riskIndex.byWord.get(word) ?? 0,
    familyMatches: riskIndex.byChar.get(char) ?? 0,
  }
}

async function main() {
  const { files, out, golden, risks, triage } = parseArgs(process.argv.slice(2))
  if (!files.length) {
    printHelp()
    process.exitCode = 1
    return
  }

  const overlayText = await readFile(OVERLAY_PATH, 'utf8')
  const existing = parseOverlay(overlayText)
  const assets = await loadMatchaAssets()
  const effective = assets.effective
  const riskIndex = await loadRiskIndex(risks)
  const reports = (
    await Promise.all(files.map((file) => loadReports(file)))
  ).flat()
  const { candidates, warnings, markCount, singleCharMarks } = collectCandidates(reports, effective)
  const triageRows = []

  const byWord = new Map()
  for (const entry of candidates.values()) {
    const list = byWord.get(entry.word) ?? []
    list.push(entry)
    byWord.set(entry.word, list)
  }

  const add = []
  const already = []
  const conflicts = []

  for (const [word, list] of byWord) {
    if (list.length > 1) {
      conflicts.push({
        word,
        kind: 'feedback',
        options: list.map((item) => ({
          phones: item.phones,
          reports: item.reports.size,
        })),
      })
      triageRows.push({ word, class: 'conflict-feedback', options: list.length })
      continue
    }
    const entry = list[0]
    const curated = existing.get(word)
    const current = phoneticPhones(effective.get(word) ?? '').join(' ')
    const targetChar = entry.samples?.[0]?.char ?? Array.from(word)[0]
    const impact = impactOf(word, targetChar, riskIndex)
    // Compare against the *effective* dictionary (base + overlay), not just the
    // curated table: this is what closes the "word already exists in the base
    // lexicon with the wrong reading" blind spot.
    const class_ = current === entry.phones
      ? 'acoustic'
      : curated !== undefined
        ? 'conflict-curated'
        : assets.lexicon.has(word)
          ? 'override-lexicon'
          : 'new'
    triageRows.push({
      word,
      phones: entry.phones,
      class: class_,
      current: current || null,
      inBaseLexicon: assets.lexicon.has(word),
      inCuratedOverlay: curated !== undefined,
      impact,
      reports: entry.reports.size,
      samples: entry.samples,
    })

    if (class_ === 'acoustic') {
      already.push(entry)
      continue
    }
    if (class_ === 'conflict-curated') {
      conflicts.push({
        word,
        kind: 'curated',
        curated,
        options: [{ phones: entry.phones, reports: entry.reports.size }],
      })
      continue
    }
    add.push(entry)
  }

  for (const mark of singleCharMarks) {
    triageRows.push({
      word: mark.char,
      phones: mark.phone,
      class: 'needs-family-rule',
      current: phoneticPhones(effective.get(mark.char) ?? '').join(' ') || null,
      impact: impactOf(mark.char, mark.char, riskIndex),
      reports: 1,
      samples: [{ text: mark.text, char: mark.char, phone: mark.phone }],
      note: '单字语境不生成覆盖行；按词族规则或风险清单同类位置处理',
    })
  }

  add.sort(
    (a, b) => b.reports.size - a.reports.size || a.word.localeCompare(b.word),
  )

  console.log(`读取 ${reports.length} 条反馈，${markCount} 处标记`)
  console.log(`候选词组 ${byWord.size} 个：新增 ${add.length}，已存在 ${already.length}，冲突 ${conflicts.length}`)
  const classCounts = new Map()
  for (const row of triageRows) {
    classCounts.set(row.class, (classCounts.get(row.class) ?? 0) + 1)
  }
  console.log(`分类：${[...classCounts.entries()].map(([name, count]) => `${name} ${count}`).join(' · ') || '无'}`)
  if (riskIndex) {
    for (const row of triageRows) {
      if (row.impact?.wordMatches || row.impact?.familyMatches) {
        console.log(`  影响面  ${row.word}: 同词 ${row.impact.wordMatches} 处 / 同字 ${row.impact.familyMatches} 处`)
      }
    }
  }

  if (triage) {
    const target = resolve(ROOT, triage)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      target,
      `# 由读音反馈生成，请人工复核。生成时间 ${new Date().toISOString()}\n` +
        `${triageRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    )
    console.log(`\n分类结果已写入 ${target}（${triageRows.length} 条）`)
  }

  for (const entry of already) {
    console.log(`  已存在  ${entry.word} ${entry.phones}`)
  }
  for (const conflict of conflicts) {
    if (conflict.kind === 'curated') {
      console.log(
        `  冲突    ${conflict.word}: 词典已有「${conflict.curated}」，反馈为「${conflict.options[0].phones}」`,
      )
    } else {
      console.log(
        `  冲突    ${conflict.word}: ${conflict.options
          .map((item) => `${item.phones}（${item.reports} 条）`)
          .join(' / ')}`,
      )
    }
  }
  for (const warning of [...new Set(warnings)]) {
    console.log(`  跳过    ${warning}`)
  }

  if (!add.length) {
    console.log('没有可新增的候选行。')
    return
  }

  const header = [
    '# 由读音反馈生成，请人工复核后再合并到 polyphones.v1.txt。',
    `# 生成时间 ${new Date().toISOString()} · ${reports.length} 条反馈`,
  ]
  const body = add.map((entry) => `${entry.word} ${entry.phones}`)
  const text = `${header.join('\n')}\n${body.join('\n')}\n`
  const annotated = add.map(
    (entry) =>
      `${entry.word} ${entry.phones}  · ${entry.reports.size} 条反馈${
        entry.voices.size
          ? ` · ${[...entry.voices.keys()].slice(0, 2).join(' / ')}`
          : ''
      }`,
  )

  console.log('\n可新增：')
  console.log(annotated.join('\n'))

  if (out) {
    const target = resolve(ROOT, out)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
    console.log(`\n候选文件已写入 ${target}（只有可合并的词行与文件头注释）`)
  }

  if (golden) {
    // Each accepted word gets one regression case built from the reported
    // paragraph. Review the sentence and the expected phone before appending
    // it to tests/fixtures/pronunciation-golden.jsonl.
    const lines = []
    for (const entry of add) {
      const sample = entry.samples?.[0]
      if (!sample) continue
      const before = Array.from(sample.text.slice(0, sample.charIndex))
      const occurrence =
        before.filter((char) => char === sample.char).length + 1
      lines.push(
        JSON.stringify({
          id: `feedback-${entry.word}`,
          word: entry.word,
          text: sample.text,
          readings: [[sample.char, occurrence, sample.phone]],
        }),
      )
    }
    if (lines.length) {
      const target = resolve(ROOT, golden)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(
        target,
        `# 由读音反馈生成，人工复核后追加到 tests/fixtures/pronunciation-golden.jsonl。\n` +
          `# 生成时间 ${new Date().toISOString()} · ${reports.length} 条反馈\n` +
          `${lines.join('\n')}\n`,
        'utf8',
      )
      console.log(`\n黄金集候选已写入 ${target}（${lines.length} 条）`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
