import { OutputFormat, convert, pinyin, segment } from 'pinyin-pro'
import { normalizePinyinReading } from '@/core/tts/pinyinTones'

export interface ReadingCandidate {
  value: string
  label: string
  contextual: boolean
}

export interface ReadingContext {
  char: string
  word: string
  wordStart: number
  wordEnd: number
  candidates: ReadingCandidate[]
}

const HAN = /\p{Script=Han}/u
// Keep auto-expanded contexts short: they become overlay words, and the
// bundled tokenizer only matches lexicon words up to four characters.
const MAX_CONTEXT_CHARS = 4

interface TextUnit {
  char: string
  start: number
  end: number
}

export function textUnits(text: string): TextUnit[] {
  const units: TextUnit[] = []
  let start = 0
  for (const char of text) {
    units.push({ char, start, end: start + char.length })
    start += char.length
  }
  return units
}

interface SegmenterPart {
  segment: string
  index: number
  isWordLike?: boolean
}

type SegmenterConstructor = new (
  locale: string,
  options: { granularity: 'word' },
) => { segment: (input: string) => Iterable<SegmenterPart> }

function wordSpans(text: string): Array<{ word: string; start: number; end: number }> {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor })
    .Segmenter
  if (Segmenter) {
    const segmenter = new Segmenter('zh', { granularity: 'word' })
    return Array.from(segmenter.segment(text), (part) => ({
      word: part.segment,
      start: part.index,
      end: part.index + part.segment.length,
    }))
  }

  let start = 0
  return segment(text, { format: OutputFormat.ZhArray }).map((chars) => {
    const word = chars.join('')
    const span = { word, start, end: start + word.length }
    start += word.length
    return span
  })
}

function wordAround(
  text: string,
  charIndex: number,
): { word: string; start: number; end: number } | null {
  return (
    wordSpans(text).find(
      (span) => charIndex >= span.start && charIndex < span.end,
    ) ?? null
  )
}

function isHanText(text: string): boolean {
  const chars = Array.from(text)
  return chars.length > 0 && chars.every((char) => HAN.test(char))
}

/**
 * Literary text often segments into single characters. A single-character
 * overlay word would override that character everywhere, so expand the
 * context to a nearby phrase that the overlay can match safely.
 */
function phraseAround(
  text: string,
  charIndex: number,
): { word: string; start: number; end: number } | null {
  const units = textUnits(text)
  const unitIndex = units.findIndex((item) => item.start === charIndex)
  if (unitIndex < 0) return null

  let start = unitIndex
  let end = unitIndex + 1
  while (start > 0 && HAN.test(units[start - 1].char)) start -= 1
  while (end < units.length && HAN.test(units[end].char)) end += 1
  if (end - start < 2) return null

  const windowStart =
    end - start <= MAX_CONTEXT_CHARS
      ? start
      : Math.min(
          Math.max(unitIndex - 2, start),
          end - MAX_CONTEXT_CHARS,
        )
  const windowEnd = Math.min(windowStart + MAX_CONTEXT_CHARS, end)
  return {
    word: units
      .slice(windowStart, windowEnd)
      .map((item) => item.char)
      .join(''),
    start: units[windowStart].start,
    end: units[windowEnd - 1].end,
  }
}

function readingAt(
  word: string,
  relativeIndex: number,
): { value: string; label: string } | null {
  const values = pinyin(word, { toneType: 'num', type: 'array' }) as string[]
  const labels = pinyin(word, { type: 'array' }) as string[]
  const value = values[relativeIndex]
  if (!value) return null
  return {
    value: normalizePinyinReading(value),
    label: labels[relativeIndex] ?? value,
  }
}

export async function getReadingContext(
  text: string,
  charIndex: number,
): Promise<ReadingContext | null> {
  const unit = textUnits(text).find(
    (item) => item.start === charIndex && HAN.test(item.char),
  )
  if (!unit) return null

  const detected = wordAround(text, charIndex)
  const context =
    detected && Array.from(detected.word).length > 1 && isHanText(detected.word)
      ? detected
      : (phraseAround(text, charIndex) ?? {
          word: unit.char,
          start: unit.start,
          end: unit.end,
        })
  const relativeIndex = textUnits(context.word).findIndex(
    (item) => context.start + item.start === charIndex,
  )
  const candidates: ReadingCandidate[] = []
  const seen = new Set<string>()

  const add = (value: string, label: string, contextual: boolean) => {
    const normalized = normalizePinyinReading(value)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    candidates.push({ value: normalized, label, contextual })
  }

  if (relativeIndex >= 0) {
    const contextual = readingAt(context.word, relativeIndex)
    if (contextual) add(contextual.value, contextual.label, true)
  }

  const numeric = pinyin(unit.char, {
    multiple: true,
    toneType: 'num',
    type: 'array',
  }) as string[]
  const labels = pinyin(unit.char, {
    multiple: true,
    type: 'array',
  }) as string[]
  numeric.forEach((value, index) => {
    add(value, labels[index] ?? value, false)
  })

  return {
    char: unit.char,
    word: context.word,
    wordStart: context.start,
    wordEnd: context.end,
    candidates: candidates.slice(0, 8),
  }
}

export async function normalizeCustomReading(
  raw: string,
): Promise<{ value: string; label: string } | null> {
  const cleaned = raw.trim().toLowerCase().replace(/ü/g, 'v')
  if (!cleaned || /\s/.test(cleaned)) return null
  const value = normalizePinyinReading(cleaned)
  if (!/^[a-z]+[1-4]?$/.test(value)) return null
  const label = convert(value).replace(/v/g, 'ü')
  return { value, label: label || value }
}
