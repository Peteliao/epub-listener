#!/usr/bin/env node
// Dev-only: turn exported pronunciation feedback JSONL into overlay candidates.
// Never imported by the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OutputFormat, convert, pinyin, segment } from 'pinyin-pro'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OVERLAY_PATH = resolve(ROOT, 'src/core/tts/polyphones.v1.txt')
const HAN = /^\p{Script=Han}+$/u
const TONE_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]/u

function parseArgs(argv) {
  const files = []
  let out = null
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('--')) files.push(arg)
  }
  return { files, out }
}

function printHelp() {
  console.log(`用法: node scripts/reports-to-overlay.mjs <reports.jsonl> [--out=path]

从「读音反馈记录」导出的 JSONL 生成 polyphones.v1.txt 候选行。
只输出 2–4 字、没有冲突、且词典里尚不存在的候选；单字语境会跳过，
避免一条反馈覆盖该字在所有词里的读音。请人工复核后再合并。

示例:
  node scripts/reports-to-overlay.mjs ~/Downloads/pronunciation-reports-20261102.jsonl
  node scripts/reports-to-overlay.mjs reports.jsonl --out=scripts/out/overlay-candidates.txt`)
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

function collectCandidates(reports) {
  const candidates = new Map()
  const words = new Map()
  const warnings = []
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
        warnings.push(
          `${report?.id ?? '未知报告'}：「${mark.char}」只有单字语境，已跳过（避免全局覆盖）`,
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

    const phones = pinyinPhones(info.word)
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
    })
  }

  return { candidates, warnings, markCount }
}

async function main() {
  const { files, out } = parseArgs(process.argv.slice(2))
  if (!files.length) {
    printHelp()
    process.exitCode = 1
    return
  }

  const overlayText = await readFile(OVERLAY_PATH, 'utf8')
  const existing = parseOverlay(overlayText)
  const reports = (
    await Promise.all(files.map((file) => loadReports(file)))
  ).flat()
  const { candidates, warnings, markCount } = collectCandidates(reports)

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
      continue
    }
    const entry = list[0]
    const curated = existing.get(word)
    if (curated === entry.phones) {
      already.push(entry)
      continue
    }
    if (curated !== undefined) {
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

  add.sort(
    (a, b) => b.reports.size - a.reports.size || a.word.localeCompare(b.word),
  )

  console.log(`读取 ${reports.length} 条反馈，${markCount} 处标记`)
  console.log(`候选词组 ${byWord.size} 个：新增 ${add.length}，已存在 ${already.length}，冲突 ${conflicts.length}`)

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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
