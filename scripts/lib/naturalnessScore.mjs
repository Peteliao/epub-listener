export const NATURALNESS_SCORE_PROTOCOL = 'naturalness-score-v1'
export const NATURALNESS_DIMENSIONS = Object.freeze(['naturalness', 'pause'])

const VARIANT_LABELS = Object.freeze({
  'legacy-text': '旧 text 基线（绕过 C1）',
  'frontend-text': '生产前端 text',
  'runtime-tokens': '直接 token 基线',
  'boundary-token': '标点后插入 ID7 静音',
  'segmented-pcm': '分段 + PCM 停顿',
  'c4-grid': 'C4 全因子',
})

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

function emptyScores() {
  return { naturalness: null, pause: null }
}

function manifestItems(manifest) {
  if (manifest?.protocol !== 'naturalness-v1') throw new Error('不是 naturalness-v1 清单')
  if (typeof manifest.mode !== 'string' || !manifest.mode) throw new Error('清单缺少 mode')
  if (!Array.isArray(manifest.items) || !manifest.items.length) throw new Error('清单没有 items')
  const ids = new Set()
  return manifest.items.map((item) => {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) {
      throw new Error(`清单实验 id 无效或重复：${item.id ?? '?'}`)
    }
    if (typeof item.sampleId !== 'string' || !item.sampleId || typeof item.variant !== 'string' || !item.variant) {
      throw new Error(`${item.id}：缺少 sampleId 或 variant`)
    }
    const actualConfig = item.actualConfig ?? {}
    if (item.variant === 'c4-grid' &&
      (!Number.isFinite(actualConfig.noiseScale) || actualConfig.noiseScale <= 0 ||
        !Number.isFinite(actualConfig.silenceScale) || actualConfig.silenceScale <= 0)) {
      throw new Error(`${item.id}：C4 噪声或静音参数无效`)
    }
    ids.add(item.id)
    return {
      id: item.id,
      sampleId: item.sampleId,
      variant: item.variant,
      ...(item.variant === 'c4-grid'
        ? { noiseScale: actualConfig.noiseScale, silenceScale: actualConfig.silenceScale }
        : {}),
    }
  })
}

export function createNaturalnessScoreSheet({ manifest, manifestSha256, rater }) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? '')) throw new Error('manifest SHA-256 无效')
  if (!String(rater ?? '').trim()) throw new Error('必须指定评分者')
  return {
    version: 1,
    protocol: NATURALNESS_SCORE_PROTOCOL,
    createdAt: new Date().toISOString(),
    manifestSha256,
    mode: manifest.mode,
    rater: String(rater).trim(),
    items: manifestItems(manifest).map((item) => ({
      ...item,
      scores: emptyScores(),
      preferred: false,
      notes: '',
    })),
  }
}

function average(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100
}

export function summarizeNaturalnessScores(items) {
  const variants = new Map()
  const samples = new Map()
  for (const item of items) {
    const variantKey = item.variant === 'c4-grid'
      ? `c4-grid:n${item.noiseScale}:s${item.silenceScale}`
      : item.variant
    const variant = variants.get(variantKey) ?? { count: 0, naturalness: [], pause: [] }
    variant.count += 1
    variant.naturalness.push(item.scores.naturalness)
    variant.pause.push(item.scores.pause)
    variants.set(variantKey, variant)
    const sample = samples.get(item.sampleId) ?? { preferred: [], variants: {} }
    sample.variants[variantKey] = {
      naturalness: item.scores.naturalness,
      pause: item.scores.pause,
      notes: item.notes,
    }
    if (item.preferred) sample.preferred.push(variantKey)
    samples.set(item.sampleId, sample)
  }
  return {
    variants: Object.fromEntries([...variants].map(([key, value]) => [key, {
      count: value.count,
      naturalness: average(value.naturalness),
      pause: average(value.pause),
    }])),
    samples: Object.fromEntries([...samples].map(([key, value]) => [key, {
      preferred: value.preferred,
      variants: value.variants,
    }])),
  }
}

export function validateNaturalnessScoreSheet(sheet, { manifest, manifestSha256 }) {
  const errors = []
  if (sheet?.version !== 1) errors.push('评分表 version 不匹配')
  if (sheet?.protocol !== NATURALNESS_SCORE_PROTOCOL) errors.push('评分表 protocol 不匹配')
  if (sheet?.manifestSha256 !== manifestSha256) errors.push('评分表与自然度清单指纹不一致')
  if (sheet?.mode !== manifest?.mode) errors.push('评分表与清单模式不一致')
  if (!String(sheet?.rater ?? '').trim()) errors.push('缺少评分者')
  if (!Array.isArray(sheet?.items)) return { ok: false, complete: false, errors: [...errors, '没有 items'], summary: null }

  const expected = new Map(manifestItems(manifest).map((item) => [item.id, item]))
  const seen = new Set()
  const preferred = new Map()
  let complete = errors.length === 0
  for (const item of sheet.items) {
    const target = expected.get(item?.id)
    if (!target) {
      errors.push(`未知或多余的实验 id：${item?.id ?? '?'}`)
      complete = false
      continue
    }
    if (seen.has(item.id)) errors.push(`重复实验 id：${item.id}`)
    seen.add(item.id)
    if (item.sampleId !== target.sampleId || item.variant !== target.variant) {
      errors.push(`${item.id}：sampleId 或 variant 与清单不一致`)
    }
    if (item.variant === 'c4-grid' &&
      (item.noiseScale !== target.noiseScale || item.silenceScale !== target.silenceScale)) {
      errors.push(`${item.id}：C4 噪声或静音参数与清单不一致`)
    }
    for (const dimension of NATURALNESS_DIMENSIONS) {
      const value = item.scores?.[dimension]
      if (value == null) {
        complete = false
      } else if (!Number.isInteger(value) || value < 1 || value > 5) {
        errors.push(`${item.id}.${dimension} 必须是 1–5 的整数`)
        complete = false
      }
    }
    if (item.notes != null && typeof item.notes !== 'string') errors.push(`${item.id}.notes 必须是字符串`)
    if (item.preferred != null && typeof item.preferred !== 'boolean') errors.push(`${item.id}.preferred 必须是布尔值`)
    if (item.preferred === true) {
      const count = (preferred.get(item.sampleId) ?? 0) + 1
      preferred.set(item.sampleId, count)
      if (count > 1) errors.push(`${item.sampleId} 只能选择一个偏好方案`)
    }
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) {
      errors.push(`缺少实验 id：${id}`)
      complete = false
    }
  }
  const sampleIds = new Set([...expected.values()].map((item) => item.sampleId))
  for (const sampleId of sampleIds) {
    if ((preferred.get(sampleId) ?? 0) !== 1) complete = false
  }
  if (errors.length) complete = false
  return {
    ok: errors.length === 0,
    complete,
    errors,
    summary: complete ? summarizeNaturalnessScores(sheet.items) : null,
  }
}

function scoreOptions(value) {
  return `<option value="">未评</option>${[1, 2, 3, 4, 5].map((score) =>
    `<option value="${score}"${value === score ? ' selected' : ''}>${score}</option>`).join('')}`
}

export function renderNaturalnessScoreHtml({ manifest, sheet }) {
  const groups = new Map()
  for (const item of sheet.items) {
    const rows = groups.get(item.sampleId) ?? []
    rows.push(item)
    groups.set(item.sampleId, rows)
  }
  const sections = [...groups].map(([sampleId, items]) => {
    const sourceText = manifest.items.find((item) => item.sampleId === sampleId)?.sourceText ?? ''
    const rows = items.map((item) => {
      const actual = manifest.items.find((entry) => entry.id === item.id)?.actualConfig ?? {}
      const file = manifest.items.find((entry) => entry.id === item.id)?.file ?? ''
      return `<tr data-item-row="${htmlEscape(item.id)}">
<td><audio controls preload="none" src="${htmlEscape(file)}"></audio></td>
<td>${htmlEscape(VARIANT_LABELS[item.variant] ?? item.variant)}</td>
<td>noise=${htmlEscape(actual.noiseScale)}<br>silence=${htmlEscape(actual.silenceScale)}</td>
<td><select data-score="naturalness" aria-label="${htmlEscape(item.id)} 自然度">${scoreOptions(item.scores.naturalness)}</select></td>
<td><select data-score="pause" aria-label="${htmlEscape(item.id)} 停顿">${scoreOptions(item.scores.pause)}</select></td>
<td><input type="radio" name="preferred-${htmlEscape(sampleId)}" data-preferred${item.preferred ? ' checked' : ''} aria-label="${htmlEscape(item.id)} 偏好"></td>
<td><input data-notes type="text" value="${htmlEscape(item.notes ?? '')}" placeholder="错读 / 漏读 / 备注"></td>
</tr>`
    }).join('\n')
    return `<section><h2>${htmlEscape(sampleId)}</h2><p class="source">${htmlEscape(sourceText)}</p>
<table><thead><tr><th>试听</th><th>方案</th><th>参数</th><th>自然度</th><th>停顿</th><th>偏好</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></section>`
  }).join('\n')
  const payload = JSON.stringify(sheet).replace(/[<>&\u2028\u2029]/g, (char) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[char])
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>山岚自然度评分（${htmlEscape(manifest.mode)}）</title>
<style>
body{font:15px system-ui;margin:24px;color:#222;background:#fafafa;max-width:1500px}section{background:white;border:1px solid #ddd;border-radius:8px;padding:16px;margin:18px 0}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}th{background:#eee}audio{width:240px}.source{font-size:16px}.toolbar{position:sticky;top:0;background:#fff4d6;padding:12px;border:1px solid #e5cf8a;z-index:2}input,select,button{font:inherit}button{padding:6px 12px}.muted{color:#666}
</style>
<h1>山岚 C2/C4 自然度评分</h1>
<p class="muted">直接使用冻结 WAV，不重渲染。自然度与停顿均按 1–5 分，每个样本选一个偏好方案；草稿仅保存在本机浏览器，不会上传。</p>
<div class="toolbar"><label>评分者 <input id="rater" value="${htmlEscape(sheet.rater)}"></label> <span id="progress"></span> <button id="export" type="button">导出评分 JSON</button> <button id="clear" type="button">清空本机草稿</button></div>
${sections}
<script id="score-data" type="application/json">${payload}</script>
<script>
(() => {
  const initial = JSON.parse(document.getElementById('score-data').textContent)
  const initialIds = new Set(initial.items.map(item => item.id))
  const storageKey = 'naturalness-score:' + initial.manifestSha256 + ':' + encodeURIComponent(initial.rater)
  let state = initial
  try {
    const draft = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (draft && draft.protocol === initial.protocol && draft.manifestSha256 === initial.manifestSha256 &&
      Array.isArray(draft.items) && draft.items.length === initial.items.length &&
      new Set(draft.items.map(item => item?.id)).size === initial.items.length &&
      draft.items.every(item => initialIds.has(item?.id) && item.scores && typeof item.scores === 'object')) state = draft
  } catch {}
  const rater = document.getElementById('rater')
  const progress = document.getElementById('progress')
  rater.value = state.rater || ''
  const itemById = new Map(state.items.map(item => [item.id, item]))
  function updateProgress() {
    const rated = state.items.filter(item => Number.isInteger(item.scores.naturalness) && Number.isInteger(item.scores.pause)).length
    const samples = new Map()
    for (const item of state.items) {
      if (item.preferred) samples.set(item.sampleId, (samples.get(item.sampleId) || 0) + 1)
    }
    const sampleCount = new Set(state.items.map(item => item.sampleId)).size
    const preferred = [...samples.values()].filter(count => count === 1).length
    progress.textContent = '已评分 ' + rated + '/' + state.items.length + '，已选偏好 ' + preferred + '/' + sampleCount
  }
  function save() {
    state.rater = rater.value.trim()
    try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch {}
    updateProgress()
  }
  document.querySelectorAll('[data-item-row]').forEach(row => {
    const item = itemById.get(row.dataset.itemRow)
    row.querySelector('[data-score="naturalness"]').value = item.scores.naturalness ?? ''
    row.querySelector('[data-score="pause"]').value = item.scores.pause ?? ''
    row.querySelector('[data-preferred]').checked = item.preferred === true
    row.querySelector('[data-notes]').value = item.notes || ''
    row.querySelector('[data-score="naturalness"]').addEventListener('change', event => {
      item.scores.naturalness = event.target.value ? Number(event.target.value) : null
      save()
    })
    row.querySelector('[data-score="pause"]').addEventListener('change', event => {
      item.scores.pause = event.target.value ? Number(event.target.value) : null
      save()
    })
    row.querySelector('[data-preferred]').addEventListener('change', event => {
      if (!event.target.checked) return
      for (const candidate of state.items) {
        if (candidate.sampleId === item.sampleId) candidate.preferred = candidate.id === item.id
      }
      save()
    })
    row.querySelector('[data-notes]').addEventListener('input', event => {
      item.notes = event.target.value
      save()
    })
  })
  rater.addEventListener('input', save)
  document.getElementById('clear').addEventListener('click', () => {
    if (!confirm('确定清空本机草稿？')) return
    localStorage.removeItem(storageKey)
    location.reload()
  })
  document.getElementById('export').addEventListener('click', () => {
    if (!rater.value.trim()) {
      alert('请先填写评分者')
      rater.focus()
      return
    }
    save()
    const blob = new Blob([JSON.stringify(state, null, 2) + '\\n'], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'naturalness-score-' + state.rater.replace(/[^\\p{L}\\p{N}_-]/gu, '-') + '.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  })
  updateProgress()
})()
</script>
</html>\n`
}
