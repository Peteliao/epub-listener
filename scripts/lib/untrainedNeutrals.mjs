// Pure helpers for the base-lexicon untrained-neutral audit. No overlay or book
// lexicon code is imported: this deliberately examines only the bundled model
// dictionary and the acoustic model's trained-neutral whitelist.
export const UNTRAINED_NEUTRALS_SCHEMA = 1
const HAN = /^\p{Script=Han}$/u
const NEUTRAL_PHONE = /^[a-zv]+$/

export function parseNeutralWhitelist(text) {
  return new Set(
    String(text).split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
}

/**
 * Matcha uses last-line-wins for duplicate lexicon entries. Keep that semantic
 * and the winning source line so every risk row can be traced to the base file.
 */
export function findUntrainedNeutrals(lexiconText, whitelistText) {
  const whitelist = parseNeutralWhitelist(whitelistText)
  const entries = new Map()
  const lines = String(lexiconText).split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    entries.set(word, { word, reading: phones.join(' '), line: index + 1 })
  }
  const risks = []
  for (const entry of entries.values()) {
    if (Array.from(entry.word).length !== 1 || !HAN.test(entry.word)) continue
    const phones = entry.reading.split(/\s+/).filter(Boolean)
    if (phones.length !== 1 || !NEUTRAL_PHONE.test(phones[0])) continue
    if (whitelist.has(phones[0])) continue
    risks.push({ char: entry.word, phone: phones[0], lexiconLine: entry.line })
  }
  return risks.sort((a, b) =>
    a.char < b.char ? -1 : a.char > b.char ? 1 : a.phone.localeCompare(b.phone))
}

/** Count literal character hits and retain the first short context for review. */
export function selectCorpusHits(risks, text, radius = 14) {
  const chars = Array.from(String(text))
  return risks.flatMap((risk) => {
    const positions = []
    for (let index = 0; index < chars.length; index += 1) {
      if (chars[index] === risk.char) positions.push(index)
    }
    if (!positions.length) return []
    const first = positions[0]
    const from = Math.max(0, first - radius)
    const to = Math.min(chars.length, first + 1 + radius)
    return [{
      ...risk,
      count: positions.length,
      firstContext: `${from > 0 ? '…' : ''}${chars.slice(from, to).join('')}${to < chars.length ? '…' : ''}`,
    }]
  })
}

export function serializeNeutralReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function renderNeutralSummary(report) {
  const lines = [
    '# 基础词典未训练轻声风险字表',
    '',
    `- 模式：${report.corpus ? '仅列语料/书籍实际命中' : '全量基础词典风险字'}`,
    `- 风险字 ${report.rows.length} · 命中 ${report.totals.hits}${report.corpus ? ` · 语料字符 ${report.corpus.chars}` : ''}`,
    '- 口径：基础词典单汉字行、唯一无数字调音素，且不在 trainedNeutrals.v1.txt；人工/本书覆盖表不参与。',
    '- 这是待复听风险清单，不代表必须改音；无声或共振峰异常另由声学审计确认。',
    '',
    '| 字 | 无调音素 | 基础词典行 | 命中次数 | 首次语境 |',
    '| --- | --- | ---: | ---: | --- |',
  ]
  for (const row of report.rows) {
    const context = String(row.firstContext ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
    lines.push(`| ${row.char} | ${row.phone} | ${row.lexiconLine} | ${row.count ?? '—'} | ${context} |`)
  }
  return `${lines.join('\n')}\n`
}
