import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateBlindScoreSheet, weightedTotal } from './blindScore.mjs'
import { currentProvenance } from './provenance.mjs'
import { normalizeLoudness, readWav, writeWav } from './wav.mjs'

const CODE_ALPHABET = 'CDEFGHJKLMNPQRSTUVWXYZ23456789'

function hashSeed(seed) {
  let hash = 0x811c9dc5
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function rngFromSeed(seed) {
  let state = hashSeed(seed)
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, rng) {
  const result = [...list]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

function randomCode(rng, used) {
  for (;;) {
    let code = ''
    for (let index = 0; index < 4; index += 1) {
      code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]
    }
    if (!used.has(code)) {
      used.add(code)
      return code
    }
  }
}

function newExperimentId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `ab-${day}-${randomBytes(3).toString('hex')}`
}

/**
 * Double-blind plan. Every round gets a fresh crypto seed unless one is passed
 * explicitly (tests / reproducing an incident). The seed and the before/after
 * mapping stay in the private key file; the public manifest contains neither.
 */
export function buildBlindPlan(ids, { seed, experimentId } = {}) {
  const resolvedSeed = seed ?? randomBytes(16).toString('hex')
  const rng = rngFromSeed(resolvedSeed)
  const used = new Set()
  return {
    experimentId: experimentId ?? newExperimentId(),
    seed: resolvedSeed,
    items: ids.map((id) => {
      const before = randomCode(rng, used)
      const after = randomCode(rng, used)
      return { id, order: shuffle([before, after], rng), key: { before, after } }
    }),
  }
}

/** Public bundle data: experiment id, random codes and playback order only. */
export function publicManifest(plan) {
  return {
    experimentId: plan.experimentId,
    items: plan.items.map(({ id, order }) => ({ id, codes: order })),
  }
}

export function createBlindBundle({ beforeDir, afterDir, plan, outDir, normalize = true }) {
  const before = JSON.parse(readFileSync(join(beforeDir, 'manifest.json'), 'utf8'))
  const after = JSON.parse(readFileSync(join(afterDir, 'manifest.json'), 'utf8'))
  const beforeById = new Map(before.items.map((item) => [item.id, item]))
  const afterById = new Map(after.items.map((item) => [item.id, item]))
  const audioDir = join(outDir, 'audio')
  mkdirSync(audioDir, { recursive: true })

  const manifest = { ...publicManifest(plan), createdAt: new Date().toISOString(), items: [] }
  const key = {
    experimentId: plan.experimentId,
    seed: plan.seed,
    provenance: currentProvenance({ experimentId: plan.experimentId }),
    sources: { before: before.provenance ?? null, after: after.provenance ?? null },
    normalization: normalize ? 'active-rms' : 'none',
    items: [],
  }
  for (const item of plan.items) {
    const sourceBefore = beforeById.get(item.id)
    const sourceAfter = afterById.get(item.id)
    if (!sourceBefore || !sourceAfter) {
      throw new Error(`盲测配对缺少 ${item.id}`)
    }
    const sources = {
      [item.key.before]: sourceBefore.file,
      [item.key.after]: sourceAfter.file,
    }
    for (const code of item.order) {
      const wav = readWav(sources[code])
      const samples = normalize
        ? normalizeLoudness(wav.samples, wav.sampleRate)
        : wav.samples
      writeWav(join(audioDir, `${code}.wav`), samples, wav.sampleRate)
    }
    manifest.items.push({ id: item.id, category: sourceBefore.category, codes: item.order })
    key.items.push({ id: item.id, ...item.key })
  }

  const manifestPath = join(outDir, 'manifest.json')
  const keyPath = `${outDir}.key.json`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`, 'utf8')
  return { manifestPath, keyPath, audioDir }
}

function codeSet(codes) {
  return [...(codes ?? [])].sort().join(',')
}

/**
 * Unmasking is irreversible: refuse unless every sheet is complete, belongs to
 * this experiment, and uses exactly the public random codes.
 */
export function validateRevealInputs(sheets, key, manifest) {
  const errors = []
  if (!Array.isArray(sheets) || !sheets.length) errors.push('没有评分表')
  const keyById = new Map((key.items ?? []).map((item) => [item.id, item]))
  const manifestById = new Map((manifest.items ?? []).map((item) => [item.id, item]))
  const seenRaters = new Set()

  for (const mapping of key.items ?? []) {
    const publicItem = manifestById.get(mapping.id)
    if (!publicItem) {
      errors.push(`密钥条目 ${mapping.id} 不在公开清单中`)
      continue
    }
    if (codeSet([mapping.before, mapping.after]) !== codeSet(publicItem.codes)) {
      errors.push(`${mapping.id} 的解盲密钥与公开清单代号不一致`)
    }
  }

  for (const [index, sheet] of (sheets ?? []).entries()) {
    const name = sheet?.rater || `评分表 ${index + 1}`
    if (!sheet?.rater) errors.push(`${name} 缺少评分者身份`)
    else if (seenRaters.has(sheet.rater)) errors.push(`重复评分者：${sheet.rater}`)
    else seenRaters.add(sheet.rater)
    if (key.experimentId && sheet?.experimentId !== key.experimentId) {
      errors.push(`${name} 属于另一个实验（${sheet?.experimentId ?? '无 ID'}）`)
    }

    const validation = validateBlindScoreSheet(sheet)
    for (const error of validation.errors) errors.push(`${name}: ${error}`)
    if (!validation.complete) errors.push(`${name}: 评分未完成`)

    const scoredIds = new Set()
    for (const item of sheet?.items ?? []) {
      if (scoredIds.has(item.id)) errors.push(`${name}: 重复条目 ${item.id}`)
      scoredIds.add(item.id)
      const mapping = keyById.get(item.id)
      const publicItem = manifestById.get(item.id)
      if (!mapping) {
        errors.push(`${name}: ${item.id} 不在解盲密钥中`)
        continue
      }
      if (!publicItem) errors.push(`${name}: ${item.id} 不在公开清单中`)
      else if (codeSet(item.codes) !== codeSet(publicItem.codes)) {
        errors.push(`${name}: ${item.id} 代号与公开清单不一致`)
      }
      if (codeSet(item.codes) !== codeSet([mapping.before, mapping.after])) {
        errors.push(`${name}: ${item.id} 代号与解盲密钥不一致`)
      }
    }
    for (const id of manifestById.keys()) {
      if (!scoredIds.has(id)) errors.push(`${name}: 缺少条目 ${id}`)
    }
  }
  return errors
}

export function revealScores(sheets, key, manifest) {
  const errors = validateRevealInputs(sheets, key, manifest)
  if (errors.length) {
    throw new Error(`解盲前校验失败：\n${errors.join('\n')}`)
  }
  const codes = new Map(key.items.map((item) => [item.id, item]))
  const perRater = sheets.map((sheet) => {
    const rater = sheet.rater
    const items = (sheet.items ?? []).map((item) => {
      const mapping = codes.get(item.id)
      if (!mapping) return { id: item.id, error: '缺少解盲映射' }
      const before = weightedTotal(item.scores?.[mapping.before])
      const after = weightedTotal(item.scores?.[mapping.after])
      return {
        id: item.id,
        before,
        after,
        delta: Math.round((after - before) * 100) / 100,
        preferred: before === after ? null : after > before ? mapping.after : mapping.before,
      }
    })
    return { rater, items }
  })

  const averages = new Map()
  for (const rater of perRater) {
    for (const item of rater.items) {
      if (!averages.has(item.id)) averages.set(item.id, { before: [], after: [] })
      averages.get(item.id).before.push(item.before)
      averages.get(item.id).after.push(item.after)
    }
  }
  const overall = [...averages.entries()].map(([id, values]) => ({
    id,
    before: values.before.reduce((sum, value) => sum + value, 0) / values.before.length,
    after: values.after.reduce((sum, value) => sum + value, 0) / values.after.length,
  }))
  for (const item of overall) {
    item.delta = Math.round((item.after - item.before) * 100) / 100
  }

  let agreement = null
  if (perRater.length >= 2) {
    let agree = 0
    let compared = 0
    for (let left = 0; left < perRater.length; left += 1) {
      for (let right = left + 1; right < perRater.length; right += 1) {
        const a = new Map(perRater[left].items.map((item) => [item.id, item.preferred]))
        for (const item of perRater[right].items) {
          if (!item.preferred || !a.has(item.id)) continue
          compared += 1
          if (a.get(item.id) === item.preferred) agree += 1
        }
      }
    }
    agreement = compared ? agree / compared : null
  }
  return {
    experimentId: key.experimentId ?? null,
    revealedAt: new Date().toISOString(),
    provenance: key.provenance ?? null,
    sources: key.sources ?? null,
    raters: perRater,
    overall,
    agreement,
    items: manifest.items,
  }
}
