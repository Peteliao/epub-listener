/**
 * Fixed-weight blind-listening score sheet.
 *
 * The weights are a product decision from the 2.0 review, not an acoustic
 * measurement. Scores are 1–5 per dimension; null means "not listened yet".
 */
export const BLIND_WEIGHTS = Object.freeze({
  pronunciation: 0.3,
  clarity: 0.25,
  naturalness: 0.2,
  prosody: 0.15,
  emotion: 0.1,
})

export const BLIND_DIMENSIONS = Object.freeze(Object.keys(BLIND_WEIGHTS))

function emptyScores() {
  return Object.fromEntries(BLIND_DIMENSIONS.map((key) => [key, null]))
}

export function createScoreSheet({ before, after, items }) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    before,
    after,
    weights: { ...BLIND_WEIGHTS },
    items: items.map((item) => ({
      id: item.id,
      category: item.category,
      before: emptyScores(),
      after: emptyScores(),
    })),
  }
}

export function weightedTotal(scores) {
  let total = 0
  for (const key of BLIND_DIMENSIONS) {
    total += Number(scores?.[key] ?? 0) * BLIND_WEIGHTS[key]
  }
  return Math.round(total * 100) / 100
}

export function validateScoreSheet(sheet) {
  const errors = []
  if (!sheet || !Array.isArray(sheet.items) || !sheet.items.length) {
    return { ok: false, complete: false, errors: ['没有 items'], items: [] }
  }
  const ids = new Set()
  const items = []
  for (const item of sheet.items) {
    if (!item?.id) {
      errors.push('存在缺少 id 的条目')
      continue
    }
    if (ids.has(item.id)) errors.push(`重复 id：${item.id}`)
    ids.add(item.id)
    for (const side of ['before', 'after']) {
      for (const key of BLIND_DIMENSIONS) {
        const value = item[side]?.[key]
        if (value == null) continue
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          errors.push(`${item.id}.${side}.${key} 必须是 1–5 的整数`)
        }
      }
    }
    const beforeComplete = BLIND_DIMENSIONS.every((key) => item.before?.[key] != null)
    const afterComplete = BLIND_DIMENSIONS.every((key) => item.after?.[key] != null)
    items.push({
      id: item.id,
      category: item.category,
      beforeComplete,
      afterComplete,
      beforeTotal: beforeComplete ? weightedTotal(item.before) : null,
      afterTotal: afterComplete ? weightedTotal(item.after) : null,
    })
  }
  const complete = items.every((item) => item.beforeComplete && item.afterComplete)
  return {
    ok: errors.length === 0,
    complete,
    errors,
    items,
    overall: complete && items.length
      ? {
        before: Math.round(
          (items.reduce((sum, item) => sum + item.beforeTotal, 0) / items.length) * 100,
        ) / 100,
        after: Math.round(
          (items.reduce((sum, item) => sum + item.afterTotal, 0) / items.length) * 100,
        ) / 100,
      }
      : null,
  }
}

/** Score sheet for a double-blind bundle: only random codes, no version names. */
export function createBlindScoreSheet({ bundle, rater = 'rater-1' }) {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    rater,
    experimentId: bundle.experimentId ?? null,
    weights: { ...BLIND_WEIGHTS },
    items: (bundle.items ?? []).map((item) => ({
      id: item.id,
      category: item.category,
      codes: item.codes,
      scores: Object.fromEntries(item.codes.map((code) => [code, emptyScores()])),
    })),
  }
}

export function validateBlindScoreSheet(sheet) {
  const errors = []
  if (!sheet || !Array.isArray(sheet.items) || !sheet.items.length) {
    return { ok: false, complete: false, errors: ['没有 items'], items: [] }
  }
  const ids = new Set()
  const items = []
  for (const item of sheet.items) {
    if (!item?.id || !Array.isArray(item.codes) || item.codes.length !== 2) {
      errors.push(`条目 ${item?.id ?? '?'} 缺少一对随机代号`)
      continue
    }
    if (ids.has(item.id)) errors.push(`重复 id：${item.id}`)
    ids.add(item.id)
    let complete = true
    for (const code of item.codes) {
      for (const key of BLIND_DIMENSIONS) {
        const value = item.scores?.[code]?.[key]
        if (value == null) {
          complete = false
          continue
        }
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          errors.push(`${item.id}.${code}.${key} 必须是 1–5 的整数`)
        }
      }
    }
    const totals = Object.fromEntries(item.codes.map((code) => [
      code,
      complete ? weightedTotal(item.scores[code]) : null,
    ]))
    items.push({ id: item.id, category: item.category, codes: item.codes, complete, totals })
  }
  return {
    ok: errors.length === 0,
    complete: items.every((item) => item.complete),
    errors,
    items,
  }
}
