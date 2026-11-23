/**
 * Rule-based semantic pause planning for long Chinese clauses.
 *
 * The model already reads a comma as a natural pause. This planner inserts one
 * comma before a contrast/consequence conjunction when the preceding clause is
 * long and no punctuation already marks the boundary. It is deliberately
 * conservative: short clauses, sentence-initial connectives, and positions that
 * already have punctuation are never touched, and at most one pause is added.
 *
 * Only `speechText` is changed; the displayed book text stays byte-for-byte the
 * same. The goal is a listener-friendly breath at the semantic seam, not a new
 * sentence or a model-level prosody claim.
 */
const BREAK_WORDS = [
  // Contrast: the highest-value pause and the least ambiguous.
  '但是', '可是', '然而', '而是',
  // Consequence / sequence.
  '因此', '因而', '于是', '那么', '然后', '接着', '随后',
  // Condition / concession.
  '如果', '假如', '要是', '虽然', '尽管', '即使', '无论', '不管',
  '只要', '只有', '除非', '由于',
  // Addition / example.
  '而且', '并且', '况且', '何况', '否则', '不然',
  '例如', '比如', '譬如', '尤其是', '特别是',
  '也就是说', '换句话说',
].sort((left, right) => right.length - left.length)

const CLAUSE_END = /[。！？!?；;…\n]/
const ANY_PAUSE = /[，,、：:]/
const HAN = /\p{Script=Han}/gu
const SEMANTIC_COMMA = '，'

export interface SpeechPhrasingOptions {
  /** Minimum Han characters before the conjunction. */
  minCharsBefore?: number
  /** Minimum Han characters after the conjunction. */
  minCharsAfter?: number
  /** Never insert more than this many commas in one speech unit. */
  maxBreaths?: number
}

const DEFAULTS: Required<SpeechPhrasingOptions> = {
  minCharsBefore: 14,
  minCharsAfter: 8,
  maxBreaths: 1,
}

function countHan(text: string): number {
  return text.match(HAN)?.length ?? 0
}

function isPause(char: string): boolean {
  return CLAUSE_END.test(char) || ANY_PAUSE.test(char)
}

function findWordAt(text: string, index: number): string | null {
  for (const word of BREAK_WORDS) {
    if (text.startsWith(word, index)) return word
  }
  return null
}

/**
 * Returns `text` with at most one semantic comma before a safe conjunction.
 * Idempotent: after a comma is inserted it becomes the new clause boundary, so
 * a second pass sees a short "before" clause and cannot add another.
 */
export function planSpeechPhrasing(
  input: string,
  options: SpeechPhrasingOptions = {},
): string {
  const text = String(input)
  if (!text) return text
  // A clause that already has any pause punctuation is left alone. This keeps
  // the planner from stacking a second pause in an already-phrased sentence and
  // also makes a second pass idempotent: the inserted comma is now a pause.
  if (ANY_PAUSE.test(text)) return text
  const { minCharsBefore, minCharsAfter, maxBreaths } = {
    ...DEFAULTS,
    ...options,
  }
  if (maxBreaths <= 0) return text

  const insertions: number[] = []
  let lastBoundary = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (isPause(char)) {
      lastBoundary = index + 1
      index += 1
      continue
    }

    const word = findWordAt(text, index)
    if (!word) {
      index += 1
      continue
    }

    const before = text.slice(lastBoundary, index)
    if (countHan(before) < minCharsBefore) {
      index += word.length
      continue
    }

    let afterEnd = index + word.length
    while (afterEnd < text.length && !isPause(text[afterEnd]!)) afterEnd += 1
    const after = text.slice(index + word.length, afterEnd)
    if (countHan(after) < minCharsAfter) {
      index += word.length
      continue
    }

    insertions.push(index)
    if (insertions.length >= maxBreaths) break
    index += word.length
  }

  if (!insertions.length) return text
  let result = text
  for (let cursor = insertions.length - 1; cursor >= 0; cursor -= 1) {
    const position = insertions[cursor]!
    result = `${result.slice(0, position)}${SEMANTIC_COMMA}${result.slice(position)}`
  }
  return result
}
