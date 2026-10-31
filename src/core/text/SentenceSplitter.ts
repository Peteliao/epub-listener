export interface SentenceRange {
  start: number
  end: number
  text: string
  paragraphEnd: boolean
  /** The range is (part of) a quoted dialogue, not narration. */
  dialogue: boolean
}

export interface SplitSentencesOptions {
  /** Maximum characters per sentence before a secondary split. */
  maxLength?: number
  /** Sentences with fewer read characters than this merge with a neighbour. */
  minLength?: number
  /** Disable the short-sentence merge (useful in tests and diagnostics). */
  mergeShort?: boolean
}

interface RawRange {
  start: number
  end: number
  paragraph: number
  dialogue?: boolean
}

interface DialogueSpan {
  /** Index of the opening quote. */
  open: number
  /** Index of the closing quote. */
  close: number
  /** Index just past the closing quote. */
  closeEnd: number
}

const TERMINATORS = new Set(['。', '！', '？', '!', '?', '．', '…'])
const SECONDARY = new Set(['，', '、', '；', '：', ',', ';', ':', '—', '–', '―'])
const CLOSERS = new Set(['”', '’', '」', '』', '）', '】', '》', '〉', '〕', '］', '｝'])
const SPEAKABLE = /[\p{L}\p{N}]/gu
const HAN = /\p{Script=Han}/u

const QUOTE_PAIRS: Record<string, string> = {
  '“': '”',
  '「': '」',
  '『': '』',
}

// Attribution verbs. `道` only counts directly before a quote or before the
// closing punctuation of a short attribution clause; elsewhere it would match
// words like 知道 and split ordinary narration.
const ATTRIBUTION_BEFORE =
  /(?:笑道|哭道|骂道|喝道|说道|问道|答道|应道|说|问|答|喊|叫)[，,：:]?\s*$/
const ATTRIBUTION_HEAD =
  /^[^，。！？；：\s]{0,6}(?:笑道|哭道|骂道|喝道|说道|问道|答道|应道|说|问|答|喊|叫|道)(?:道|着|了)?[，。！？；：…\s]/
// After a dialogue quote, an attribution may start with an action clause:
// “你确定吗？”她停下来，问身后的邮递员。
const ATTRIBUTION_IN_CLAUSE =
  /(?<![知味理街道小难])(?:说|问|答|喊|叫|道|嚷|吼)(?![法明服教谎题路])/
const EDGE_CLAUSE = /[，,、；;：:]/


const DEFAULTS = {
  maxLength: 80,
  minLength: 8,
  mergeShort: true,
}

function countSpeakable(text: string): number {
  return text.match(SPEAKABLE)?.length ?? 0
}

function trimRawRange(text: string, start: number, end: number): RawRange | null {
  while (start < end && /\s/.test(text[start]!)) start += 1
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1
  return end > start ? { start, end, paragraph: 0 } : null
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Collects boundary ranges without normalising the source text, so every
 * returned offset still addresses the original document string.
 */
function collectRawRanges(text: string): RawRange[] {
  const ranges: RawRange[] = []
  let paragraph = 0
  let segmentStart = 0
  let i = 0

  const push = (start: number, end: number) => {
    const trimmed = trimRawRange(text, start, end)
    if (!trimmed) return
    trimmed.paragraph = paragraph
    ranges.push(trimmed)
  }

  while (i < text.length) {
    const char = text[i]!

    if (char === '\n' || char === '\r') {
      push(segmentStart, i)
      paragraph += 1
      i += 1
      segmentStart = i
      continue
    }

    let isBoundary = false
    let next = i + 1

    if (TERMINATORS.has(char) || char === '…') {
      isBoundary = true
      while (next < text.length && (TERMINATORS.has(text[next]!) || text[next] === '…')) {
        next += 1
      }
    } else if (char === '.') {
      const before = text[i - 1] ?? ''
      const after = text[i + 1] ?? ''
      const isDotRun = after === '.' && text[i + 2] === '.'
      const insideToken = /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after)

      if (isDotRun) {
        isBoundary = true
        while (next < text.length && text[next] === '.') next += 1
      } else if (!insideToken && (after === '' || /[\s”’」』）】》〉]/.test(after))) {
        isBoundary = true
      }
    }

    if (!isBoundary) {
      i += 1
      continue
    }

    while (next < text.length && CLOSERS.has(text[next]!)) {
      next += 1
    }

    push(segmentStart, next)
    segmentStart = next
    i = next
  }

  push(segmentStart, text.length)
  return ranges
}

function findDialogueSpans(text: string): DialogueSpan[] {
  const spans: DialogueSpan[] = []
  let i = 0

  while (i < text.length) {
    const closeQuote = QUOTE_PAIRS[text[i]!]
    if (!closeQuote) {
      i += 1
      continue
    }
    const close = text.indexOf(closeQuote, i + 1)
    if (close === -1) break

    const span: DialogueSpan = { open: i, close, closeEnd: close + 1 }
    if (looksLikeDialogue(text, span)) spans.push(span)
    i = close + 1
  }

  return spans
}

/**
 * Distinguishes spoken dialogue from quotes used for emphasis. Attribution
 * before (他说：), an attribution clause after (“好。”她低声说) or a
 * quote-only paragraph all count; `所谓“理性”` does not.
 */
function looksLikeDialogue(text: string, span: DialogueSpan): boolean {
  const before = text.slice(Math.max(0, span.open - 16), span.open).trimEnd()
  const after = text.slice(span.closeEnd, span.closeEnd + 24).trimStart()

  if (/[：:]$/.test(before)) return true
  if (ATTRIBUTION_BEFORE.test(before)) return true
  if (ATTRIBUTION_HEAD.test(after)) return true

  // Speech verbs can follow an action clause, but only trust them when the
  // quote itself opens a line or a clause; a quote glued to `所谓` is emphasis.
  if (startsClause(text, span.open)) {
    const clause = after.split(/[。！？!?…]/, 1)[0] ?? ''
    if (ATTRIBUTION_IN_CLAUSE.test(clause)) return true
  }

  const lineStart = text.slice(0, span.open)
  const afterSpan = text.slice(span.closeEnd)
  const startsLine = /(?:^|[\r\n])\s*$/.test(lineStart)
  const endsLine = /^\s*(?:[\r\n]|$)/.test(afterSpan)
  return startsLine && endsLine
}

function startsClause(text: string, open: number): boolean {
  let index = open - 1
  while (index >= 0 && /[ \t\u3000]/.test(text[index]!)) index -= 1
  if (index < 0) return true
  const previous = text[index]!
  return (
    previous === '\n' ||
    previous === '\r' ||
    /[，,、；;：:—–―]/.test(previous)
  )
}

/**
 * Cuts narration ranges so a quoted dialogue stands alone. Attribution such as
 * `他低声说：` keeps its colon, and a comma trailing the closing quote stays
 * with the dialogue so the next range does not start with stray punctuation.
 */
function splitByDialogue(
  ranges: RawRange[],
  spans: DialogueSpan[],
  text: string,
): RawRange[] {
  if (!spans.length) return ranges
  const result: RawRange[] = []

  for (const range of ranges) {
    const cuts: number[] = []

    for (const span of spans) {
      if (span.closeEnd <= range.start || span.open >= range.end) continue
      if (span.open > range.start && span.open < range.end) cuts.push(span.open)

      if (span.closeEnd > range.start && span.closeEnd < range.end) {
        let cut = span.closeEnd
        if (EDGE_CLAUSE.test(text[cut] ?? '')) cut += 1
        if (cut < range.end) cuts.push(cut)
      }
    }

    if (!cuts.length) {
      const copy = { ...range }
      copy.dialogue = spans.some(
        (span) => copy.start >= span.open && copy.start < span.closeEnd,
      )
      result.push(copy)
      continue
    }

    cuts.sort((a, b) => a - b)
    let pieceStart = range.start
    for (const cut of [...cuts, range.end]) {
      if (cut <= pieceStart) continue

      let start = pieceStart
      while (start < cut && EDGE_CLAUSE.test(text[start]!)) start += 1

      const piece = trimRawRange(text, start, cut)
      if (piece) {
        piece.paragraph = range.paragraph
        piece.dialogue = spans.some(
          (span) => piece.start >= span.open && piece.start < span.closeEnd,
        )
        result.push(piece)
      }

      pieceStart = cut
    }
  }

  return result
}

function mergeShortRanges(ranges: RawRange[], text: string, options: Required<SplitSentencesOptions>): RawRange[] {
  if (!options.mergeShort) return ranges

  const result: RawRange[] = []

  for (const range of ranges) {
    const previous = result[result.length - 1]
    const isShort = countSpeakable(text.slice(range.start, range.end)) < options.minLength
    const sameVoice = Boolean(previous?.dialogue) === Boolean(range.dialogue)

    if (
      isShort &&
      previous &&
      sameVoice &&
      previous.paragraph === range.paragraph &&
      range.end - previous.start <= options.maxLength
    ) {
      previous.end = range.end
      continue
    }

    result.push({ ...range })
  }

  // A short opening sentence has no previous neighbour to absorb it, so merge
  // it forward once it has a paragraph-local successor.
  for (let i = 0; i < result.length; i += 1) {
    const range = result[i]!
    if (countSpeakable(text.slice(range.start, range.end)) >= options.minLength) continue

    const next = result[i + 1]
    if (
      next &&
      Boolean(next.dialogue) === Boolean(range.dialogue) &&
      next.paragraph === range.paragraph &&
      next.end - range.start <= options.maxLength
    ) {
      next.start = range.start
      result.splice(i, 1)
      i -= 1
    }
  }

  return result
}

function splitsNumberFromHan(text: string, cut: number): boolean {
  let previous = cut - 1
  while (previous >= 0 && /\s/.test(text[previous]!)) previous -= 1
  let following = cut
  while (following < text.length && /\s/.test(text[following]!)) following += 1
  const before = text[previous] ?? ''
  const after = text[following] ?? ''
  return (/\d/.test(before) && HAN.test(after)) || (HAN.test(before) && /\d/.test(after))
}

function splitLongRange(range: RawRange, text: string, maxLength: number): RawRange[] {
  let start = range.start
  const end = range.end
  const pieces: RawRange[] = []

  while (end - start > maxLength) {
    const limit = start + maxLength
    const earliestCut = start + Math.floor(maxLength * 0.45)
    // Secondary punctuation may sit a little earlier; a comma boundary still
    // sounds better than slicing through a clause.
    const secondaryFloor = start + Math.floor(maxLength * 0.35)
    let cut = -1

    for (let i = limit; i > secondaryFloor; i -= 1) {
      if (SECONDARY.has(text[i - 1]!)) {
        cut = i
        break
      }
    }

    if (cut === -1) {
      for (let i = limit; i > limit - 24 && i > earliestCut; i -= 1) {
        if (!/\s/.test(text[i - 1]!)) continue
        // "200 年" must stay together so the number keeps its measure word.
        if (splitsNumberFromHan(text, i)) continue
        cut = i
        break
      }
    }

    if (cut === -1) cut = limit

    // Never bisect a surrogate pair.
    if (
      cut < end &&
      isLowSurrogate(text.charCodeAt(cut)) &&
      isHighSurrogate(text.charCodeAt(cut - 1))
    ) {
      cut -= 1
    }

    // Prefer not to chop through a Latin word or a long number.
    let wordSafeCut = cut
    while (
      wordSafeCut > earliestCut &&
      /[A-Za-z0-9]/.test(text[wordSafeCut - 1] ?? '') &&
      /[A-Za-z0-9]/.test(text[wordSafeCut] ?? '')
    ) {
      wordSafeCut -= 1
    }
    if (wordSafeCut > earliestCut && wordSafeCut < cut) cut = wordSafeCut

    // A hard cut can also land between "200" and "年"; keep the number in
    // the following piece rather than voicing a dangling digit.
    if (cut < end) {
      let previous = cut - 1
      while (previous >= start && /\s/.test(text[previous]!)) previous -= 1
      let following = cut
      while (following < end && /\s/.test(text[following]!)) following += 1
      if (/\d/.test(text[previous] ?? '') && HAN.test(text[following] ?? '')) {
        while (previous >= start && /[\d.,]/.test(text[previous]!)) previous -= 1
        if (previous + 1 > start) cut = previous + 1
      }
    }

    if (cut <= start) cut = start + maxLength

    const piece = trimRawRange(text, start, cut)
    if (piece) {
      piece.paragraph = range.paragraph
      piece.dialogue = range.dialogue
      pieces.push(piece)
    }

    start = cut
    while (start < end && /\s/.test(text[start]!)) start += 1
  }

  const tail = trimRawRange(text, start, end)
  if (tail) {
    tail.paragraph = range.paragraph
    tail.dialogue = range.dialogue
    pieces.push(tail)
  }

  return pieces
}

/**
 * Splits display text into sentence-sized ranges for speech and highlighting.
 * Offsets always refer to the exact input string; text is never rewritten.
 */
export function splitSentences(text: string, options: SplitSentencesOptions = {}): SentenceRange[] {
  const resolved: Required<SplitSentencesOptions> = {
    maxLength: options.maxLength ?? DEFAULTS.maxLength,
    minLength: options.minLength ?? DEFAULTS.minLength,
    mergeShort: options.mergeShort ?? DEFAULTS.mergeShort,
  }

  if (!text.trim()) return []

  const spans = findDialogueSpans(text)
  const split = splitByDialogue(collectRawRanges(text), spans, text)
  const merged = mergeShortRanges(split, text, resolved)
  const ranges = merged.flatMap((range) =>
    range.end - range.start > resolved.maxLength
      ? splitLongRange(range, text, resolved.maxLength)
      : [range],
  )

  return ranges
    .filter((range) => countSpeakable(text.slice(range.start, range.end)) > 0)
    .map((range, index, list) => ({
      start: range.start,
      end: range.end,
      text: text.slice(range.start, range.end),
      paragraphEnd:
        index === list.length - 1 || list[index + 1]!.paragraph !== range.paragraph,
      dialogue: range.dialogue === true,
    }))
}
