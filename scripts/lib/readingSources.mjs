import { parseEntries } from './reading.mjs'

/**
 * Priority chain used by the app (later wins):
 *   base lexicon < external phrase table < whole-book scan < EPUB ruby <
 *   live feedback < hand-curated table.
 *
 * The worker appends overlay rows and keeps the last line; the audit helpers
 * keep the first. mergeLexiconOverlays()/mergeOverlaySources() guarantee one
 * row per word so both views agree. This module explains that chain for a
 * single word instead of making a developer reverse-engineer the final output.
 */
export const SOURCE_ORDER = Object.freeze([
  { key: 'base', label: '模型基础词典' },
  { key: 'phrase', label: '外部静态词表' },
  { key: 'book', label: '整书自动词典' },
  { key: 'ruby', label: 'EPUB 拼音注音' },
  { key: 'live', label: '用户即时纠错' },
  { key: 'curated', label: '人工覆盖表' },
])

export function explainReading(word, sources) {
  const rows = []
  for (const source of SOURCE_ORDER) {
    const text = sources[source.key] ?? ''
    const reading = parseEntries(text).get(word)
    if (!reading) continue
    rows.push({ ...source, reading })
  }
  if (!rows.length) {
    return {
      word,
      rows: [],
      final: null,
      source: null,
      sourceLabel: null,
      status: '未命中任何来源',
    }
  }
  const final = rows[rows.length - 1]
  const distinct = new Set(rows.map((row) => row.reading))
  return {
    word,
    rows,
    final: final.reading,
    source: final.key,
    sourceLabel: final.label,
    status: distinct.size > 1 ? '多来源冲突，已按优先级解决' : '正常',
  }
}

export function formatExplanation(report) {
  const lines = [`词语：${report.word}`]
  for (const row of report.rows) {
    lines.push(`  ${row.label}：${row.reading}`)
  }
  lines.push(`  最终读音：${report.final ?? '—'}`)
  lines.push(`  生效来源：${report.sourceLabel ?? '—'}`)
  lines.push(`  状态：${report.status}`)
  return lines.join('\n')
}
