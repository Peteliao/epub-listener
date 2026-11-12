import { pinyin } from 'pinyin-pro'
import type { PronunciationReport } from './types'
import { normalizeOverlayText, normalizePinyinReading } from '@/core/tts/pinyinTones'
import trainedNeutralsRaw from '@/core/tts/trainedNeutrals.v1.txt?raw'

/**
 * Runtime counterpart of the dev-only `scripts/reports-to-overlay.mjs`.
 *
 * A saved listening report becomes a per-book pronunciation overlay line so
 * the correction takes effect without exporting JSONL and hand-merging it.
 * Deliberately conservative: only 2–4 character all-Han words with an
 * unambiguous, model-safe reading are emitted; a word with two different
 * corrections for the same character, a word containing 一/不 (their sandhi is
 * owned by the lexicon rules), or an invalid phone is skipped. Removing the
 * report removes the row, so the whole feature is reversible.
 */
export interface LiveOverlayResult {
  overlay: string
  /** Stable fingerprint of the exact rows, used by the per-book cache key. */
  hash: string
  rows: number
  skipped: number
}

const HAN = /^\p{Script=Han}+$/u
const PHONE = /^[a-z]+[1-4]?$/
const SANDHI_EXEMPT = new Set(['一', '不'])
const TRAINED_NEUTRALS = new Set(
  trainedNeutralsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
)

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function baseReading(word: string, length: number): string[] | null {
  try {
    const values = pinyin(word, { toneType: 'num', v: true, type: 'array' }) as string[]
    if (values.length !== length) return null
    const phones = values.map((value) => normalizePinyinReading(value))
    if (phones.some((phone) => !PHONE.test(phone))) return null
    if (phones.some((phone) => !/[1-4]$/.test(phone) && !TRAINED_NEUTRALS.has(phone))) {
      return null
    }
    return phones
  } catch {
    return null
  }
}

/**
 * Build the live overlay for one book. `reports` may be the full IndexedDB
 * list; entries for other books are ignored. `pinnedWords` lets callers skip
 * words the curated overlay already defines (curated always wins anyway).
 */
export function reportsToLiveOverlay(
  reports: readonly PronunciationReport[],
  bookId: string,
  pinnedWords: ReadonlySet<string> = new Set(),
): LiveOverlayResult {
  const votes = new Map<string, Map<number, Map<string, number>>>()
  let skipped = 0

  for (const report of reports) {
    if (report?.book?.id !== bookId || !Array.isArray(report.marks)) continue
    const text = report.paragraph?.text
    if (typeof text !== 'string') continue
    for (const mark of report.marks) {
      const word = String(mark?.word ?? '')
      const chars = Array.from(word)
      const start = Number(mark?.wordStart)
      const end = Number(mark?.wordEnd)
      const charIndex = Number(mark?.charIndex)
      const phone = String(mark?.expectedPinyin ?? '').trim().toLowerCase()
      if (
        !chars.length || !HAN.test(word) || chars.length < 2 || chars.length > 4 ||
        !Number.isInteger(start) || !Number.isInteger(end) ||
        !Number.isInteger(charIndex) || start < 0 || end > text.length ||
        text.slice(start, end) !== word ||
        charIndex < start || charIndex >= end ||
        !PHONE.test(phone) ||
        (!/[1-4]$/.test(phone) && !TRAINED_NEUTRALS.has(phone)) ||
        pinnedWords.has(word) || chars.some((char) => SANDHI_EXEMPT.has(char))
      ) {
        skipped += 1
        continue
      }
      let offset = -1
      let cursor = start
      for (let index = 0; index < chars.length; index += 1) {
        if (cursor === charIndex) { offset = index; break }
        cursor += chars[index].length
      }
      if (offset < 0 || chars[offset] !== mark.char) { skipped += 1; continue }

      const positions = votes.get(word) ?? new Map<number, Map<string, number>>()
      const options = positions.get(offset) ?? new Map<string, number>()
      options.set(phone, (options.get(phone) ?? 0) + 1)
      positions.set(offset, options)
      votes.set(word, positions)
    }
  }

  const lines: string[] = []
  for (const word of [...votes.keys()].sort((a, b) => a.localeCompare(b, 'zh'))) {
    const positions = votes.get(word)!
    if ([...positions.values()].some((options) => options.size > 1)) {
      skipped += 1
      continue
    }
    const chars = Array.from(word)
    const phones = baseReading(word, chars.length)
    if (!phones) { skipped += 1; continue }
    let valid = true
    for (const [offset, options] of positions) {
      const phone = [...options.keys()][0]
      phones[offset] = phone
      if (!PHONE.test(phone) || (!/[1-4]$/.test(phone) && !TRAINED_NEUTRALS.has(phone))) {
        valid = false
        break
      }
    }
    if (!valid) { skipped += 1; continue }
    lines.push(`${word} ${phones.join(' ')}`)
  }

  const overlay = lines.length
    ? normalizeOverlayText(
        ['# 本书即时读音纠错（运行时生成，删除反馈即可撤销）', ...lines].join('\n'),
      )
    : ''
  return { overlay, hash: fnv1a(overlay), rows: lines.length, skipped }
}
