import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { weightedTotal } from './blindScore.mjs'
import { normalizePeak, readWav, writeWav } from './wav.mjs'

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

/**
 * Deterministic double-blind plan. The returned `key` is written to a separate
 * file and must never be shipped with the score sheet before reveal.
 */
export function buildBlindPlan(ids, { seed = 'shanlan-blind-v1' } = {}) {
  const rng = rngFromSeed(seed)
  const used = new Set()
  return {
    seed,
    items: ids.map((id) => {
      const before = randomCode(rng, used)
      const after = randomCode(rng, used)
      return { id, order: shuffle([before, after], rng), key: { before, after } }
    }),
  }
}

export function publicManifest(plan) {
  return {
    seed: plan.seed,
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

  const manifest = publicManifest(plan)
  const key = { seed: plan.seed, items: [] }
  manifest.items = []
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
      const samples = normalize ? normalizePeak(wav.samples) : wav.samples
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

export function revealScores(sheets, key, manifest) {
  const codes = new Map(key.items.map((item) => [item.id, item]))
  const perRater = sheets.map((sheet) => {
    const rater = sheet.rater ?? 'rater'
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
  return { seed: key.seed, raters: perRater, overall, agreement, items: manifest.items }
}
