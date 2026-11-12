import { normalizePinyinReading } from '@/core/tts/pinyinTones'
import trainedNeutralsRaw from '@/core/tts/trainedNeutrals.v1.txt?raw'

const TRAINED_NEUTRALS = new Set(
  trainedNeutralsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
)

/**
 * Reads `<ruby>` annotations from an already-loaded chapter document.
 *
 * This is a PARALLEL, read-only channel: it never feeds the displayed/plain
 * text, so sentence splitting, highlight character offsets and the existing
 * `SKIP_TAGS` (RT/RP) behaviour in plainText.ts / Highlighter.ts stay intact.
 *
 * Only Latin pinyin annotations are supported (tone marks hàn, numeric han4,
 * neutral tones). Bopomofo and kana are intentionally rejected: the listener
 * wants Chinese readings, and those scripts cannot be mapped to the Matcha
 * phone set without a separate table.
 */
export interface RubyAnnotation {
  word: string
  reading: string
}

export interface RubyExtraction {
  /** Ready-to-use "word phones" overlay lines, sorted and deduplicated. */
  overlay: string
  count: number
  /** Number of ruby elements skipped, by reason, for diagnostics. */
  skipped: {
    notHan: number
    badLength: number
    singleChar: number
    untrainedNeutral: number
    noReading: number
    splitMismatch: number
    invalidPhone: number
    nonPinyin: number
    duplicate: number
  }
}

const HAN = /\p{Script=Han}/u
const PINYIN_TOKEN = /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿv]+[0-5]?$/i
const PHONE = /^[a-z]+[1-4]?$/

interface RubyGroup {
  base: string
  readings: string[]
}

/**
 * Collects `<ruby>` groups. Handles both a single `<rt>` for a multi-character
 * base and multiple `<rt>` (one per character), which is how EPUB3 often marks
 * per-character readings.
 */
function groupsOf(doc: Document): RubyGroup[] {
  const groups: RubyGroup[] = []
  const nodes = doc.querySelectorAll('ruby')
  for (const node of nodes) {
    // The base text is everything in the ruby that is not rt/rp.
    let base = ''
    const rts: string[] = []
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        base += child.nodeValue ?? ''
        continue
      }
      if (child.nodeType !== 1) continue
      const element = child as Element
      const tag = element.tagName.toUpperCase()
      if (tag === 'RT') rts.push((element.textContent ?? '').trim())
      else if (tag === 'RP') continue
      else base += element.textContent ?? ''
    }
    groups.push({
      base: base.replace(/\s+/g, ''),
      readings: rts.map((rt) => rt.trim()).filter(Boolean),
    })
  }
  return groups
}

/** Splits a single rt value into syllables when the base has several chars. */
function splitReading(
  raw: string,
  length: number,
): string[] | null {
  const cleaned = raw.replace(/[·・'’\-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  // Reject non-Latin scripts up front (bopomofo, kana, Hangul, CJK).
  if (/[^\x00-\x7F\u00C0-\u024F\u0300-\u036F]/u.test(cleaned)) return null
  const parts = cleaned.split(' ')
  if (parts.length === length) return parts
  if (parts.length === 1 && length === 1) return parts
  // Some EPUBs concatenate syllables without spaces; only accept when the
  // character count is 1 (no reliable segmentation otherwise).
  return null
}

export function extractRubyAnnotations(doc: Document | null | undefined): RubyExtraction {
  const skipped: RubyExtraction['skipped'] = {
    notHan: 0, badLength: 0, singleChar: 0, untrainedNeutral: 0, noReading: 0,
    splitMismatch: 0, invalidPhone: 0, nonPinyin: 0, duplicate: 0,
  }
  if (!doc) return { overlay: '', count: 0, skipped }

  const rows = new Map<string, string>()
  for (const group of groupsOf(doc)) {
    const chars = Array.from(group.base)
    if (!chars.length || !chars.every((char) => HAN.test(char))) {
      skipped.notHan += 1
      continue
    }
    // A single-character overlay row would change EVERY occurrence of that
    // character in the book. The project's rule compiler deliberately refuses
    // single-character contexts for the same reason, so follow it here.
    if (chars.length < 2) { skipped.singleChar += 1; continue }
    if (chars.length > 6) {
      skipped.badLength += 1
      continue
    }
    if (!group.readings.length) { skipped.noReading += 1; continue }

    // Multiple <rt> nodes: one reading per character.
    let syllables: string[] | null
    if (group.readings.length > 1) {
      if (group.readings.length !== chars.length) {
        skipped.splitMismatch += 1
        continue
      }
      syllables = group.readings
    } else {
      syllables = splitReading(group.readings[0], chars.length)
      if (!syllables) { skipped.splitMismatch += 1; continue }
    }
    if (syllables.some((part) => !PINYIN_TOKEN.test(part))) {
      skipped.nonPinyin += 1
      continue
    }
    const phones = normalizePinyinReading(syllables.join(' '))
      .split(/\s+/)
      .filter(Boolean)
    if (phones.length !== chars.length) { skipped.splitMismatch += 1; continue }
    if (phones.some((phone) => !PHONE.test(phone))) {
      skipped.invalidPhone += 1
      continue
    }
    if (phones.some((phone) => !/[1-4]$/.test(phone) && !TRAINED_NEUTRALS.has(phone))) {
      skipped.untrainedNeutral += 1
      continue
    }
    if (rows.has(group.base)) { skipped.duplicate += 1; continue }
    rows.set(group.base, phones.join(' '))
  }

  const overlay = [...rows.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((word) => `${word} ${rows.get(word)}`)
    .join('\n')
  return { overlay, count: rows.size, skipped }
}

/** Merges per-chapter overlay lines into one deterministic book-side overlay. */
export function mergeRubyOverlays(perChapter: readonly string[]): string {
  const rows = new Map<string, string>()
  for (const text of perChapter) {
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const [word, ...phones] = trimmed.split(/\s+/)
      if (!word || !phones.length) continue
      rows.set(word, trimmed)
    }
  }
  return [...rows.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((word) => rows.get(word)!)
    .join('\n')
}
