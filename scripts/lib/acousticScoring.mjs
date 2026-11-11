// Dev-only, dependency-free scoring rules for the acoustic audit. Kept separate
// from the WASM layer so they can be unit-tested without loading a 130MB model.
//
// Thresholds come from real WASM A/B runs on the 2026-11-09 listener report:
//   应立即 li4 105ms -> 139ms with a word-final boundary
//   占便宜 pian2 162ms -> 59ms when a boundary is wrongly appended
//     (2026-11-09 truncated token stream; the full-sentence P4 gate now lives
//      in scripts/audit-omission.mjs and uses the complete feedback sentence)
//   最先 zui4 383ms absorbed xian1 (186ms)
export const SWALLOW_MS = 100
export const NORMAL_MAX_MS = 350
// An overlong first syllable means the model merged a neighbour into it (最先)
// or doubled the onset (原已 tail variant: yuan2 395ms). Both sound wrong even
// though the total duration grows, so penalise them heavily.
const OVERLONG_WEIGHT = 4

export function classifyContribution(ms) {
  if (ms < SWALLOW_MS) return 'swallowed'
  if (ms > NORMAL_MAX_MS) return 'merged'
  return 'normal'
}

/** Higher is better: reward the weakest syllable, penalise merged onsets. */
export function scoreContributions(values) {
  if (!values.length) return 0
  const min = Math.min(...values)
  const max = Math.max(...values)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const overlong = Math.max(0, max - NORMAL_MAX_MS) * OVERLONG_WEIGHT
  return Math.round((min + mean * 0.3 - overlong) * 10) / 10
}

export function summarizeContributions(values) {
  return {
    values,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    mean: values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0,
    states: values.map(classifyContribution),
    score: scoreContributions(values),
  }
}

/**
 * Picks the boundary variant. Word-internal boundaries are measured but never
 * recommended (they create a low-energy gap that splits the word audibly), and
 * >=3-character words must never get an automatic trailing boundary.
 */
export function chooseVariant(variants, charCount = 2) {
  const eligible = variants.filter((item) => item.mode !== 'mid')
  const scored = eligible.map((item) => {
    const forbidden = item.mode === 'tail' && charCount >= 3
    return {
      ...item,
      forbidden,
      reason: forbidden
        ? '三字及以上词禁用自动词尾边界（占便宜 pian2 162→59ms 反例）'
        : item.mode === 'mid'
          ? '词内边界会把词读断'
          : item.reason ?? '',
    }
  })
  const usable = scored.filter((item) => !item.forbidden)
  const pool = usable.length ? usable : scored
  const best = pool.reduce((winner, item) =>
    item.score > winner.score ? item : winner, pool[0])
  const current = scored.find((item) => item.mode === 'current')
  const keepMargin = 20
  const keep = current && best.score - current.score <= keepMargin
  return {
    recommendation: keep ? 'keep' : best.mode,
    best,
    current,
    keep,
    requiresHuman: true,
  }
}
