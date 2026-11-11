// End-to-end (text -> lexicon -> WASM) listening check for the 2026-11-11 fixes.
// Unlike the token-level diagnosis this exercises the real text front end, so
// the quotes, commas and utterance reset behave exactly as they do in the app.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(ROOT, 'scripts/out/audio/fixes-20261111')
fs.mkdirSync(outDir, { recursive: true })
const baseLexicon = path.join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt')
const original = fs.readFileSync(baseLexicon, 'utf8')
const overlayText = fs.readFileSync(path.join(ROOT, 'src/core/tts/polyphones.v1.txt'), 'utf8')

function makeLexicon(name, reading) {
  const lines = overlayText.split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('占便宜 ')) return `占便宜 ${reading}`
    return trimmed
  }).filter((line) => line && !line.startsWith('#'))
  const words = new Set(lines.map((line) => line.split(/\s+/)[0]))
  const kept = original.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return trimmed && !words.has(trimmed.split(/\s+/)[0])
  })
  const file = path.join(outDir, `lexicon-${name}.txt`)
  fs.writeFileSync(file, `${kept.join('\n')}\n${lines.join('\n')}\n`, 'utf8')
  return file
}

function islands(samples, rate) {
  const win = Math.floor(0.02 * rate)
  const env = []
  for (let i = 0; i + win < samples.length; i += win) {
    let energy = 0
    for (let j = i; j < i + win; j += 1) energy += samples[j] * samples[j]
    env.push(Math.sqrt(energy / win))
  }
  const threshold = Math.max(...env) * 0.25
  let count = 0
  let above = false
  let gaps = 0
  for (const value of env) {
    if (value > threshold) {
      if (!above) count += 1
      above = true
      gaps = 0
    } else if (above) {
      gaps += 1
      if (gaps >= 3) above = false
    }
  }
  return count
}

const FEEDBACK = '正因如此，一些会占便宜的有钱人长期地用盐不给钱。'
const BOOK = '正因如此，一些会占便宜的有钱人家长期地用盐不给钱，全“记在账上”。'
const DIPAN = '朱元璋对张士诚极为头疼，自己只是占了点地盘；'
const RESET = '\u2060'
const WORD_BOUNDARY = '\u200b'

const configs = [
  { name: 'old', label: '修复前 · 宜全调 yi2 + 词首边界', reading: '" zhan4 pian2 yi2' },
  { name: 'neutral', label: '修复后 · 宜轻声 yi + 词首边界', reading: '" zhan4 pian2 yi' },
  { name: 'no-lead', label: '对照 · 宜轻声 yi、无词首边界', reading: 'zhan4 pian2 yi' },
]

const items = []
for (const config of configs) {
  const synth = await createMatchaSynth({ quiet: true, lexiconPath: makeLexicon(config.name, config.reading) })
  for (const [key, label, text] of [
    [`${config.name}-feedback`, `${config.label} · 反馈原句`, FEEDBACK],
    [`${config.name}-book`, `${config.label} · 书中整块`, BOOK],
  ]) {
    const result = synth.generateText(text)
    const file = `${key}.wav`
    synth.save(path.join(outDir, file), result)
    const info = {
      key, group: 'pianyi', label, file,
      ms: Math.round(result.samples.length / synth.sampleRate * 1000),
      islands: islands(result.samples, synth.sampleRate),
    }
    items.push(info)
    console.log(`[${key}] ${info.ms}ms · 浊音岛 ${info.islands}`)
  }
  synth.free()
}

// 地盘：一次合成 vs 运行时语句重置（文本层切分 + 120ms 拼接）。
const synth = await createMatchaSynth({ quiet: true, lexiconPath: makeLexicon('dipan', '" zhan4 pian2 yi') })
function save(key, label, samples, group) {
  const file = `${key}.wav`
  synth.save(path.join(outDir, file), { samples, sampleRate: synth.sampleRate })
  const info = {
    key, group, label, file,
    ms: Math.round(samples.length / synth.sampleRate * 1000),
    islands: islands(samples, synth.sampleRate),
  }
  items.push(info)
  console.log(`[${key}] ${info.ms}ms · 浊音岛 ${info.islands}`)
}
save('dipan-whole', '地盘 · 整句一次合成（修复前听成 de）', synth.generateText(DIPAN).samples, 'dipan')
save('dipan-isolated', '地盘 · 单独念（对照组）', synth.generateText('地盘。').samples, 'dipan')
const marked = DIPAN.replace('地盘', `${RESET}${WORD_BOUNDARY}地盘`)
const parts = marked.split(RESET).map((part) => part.trim()).filter(Boolean)
const rendered = parts.map((part) => synth.generateText(part).samples)
const gap = new Float32Array(Math.round(synth.sampleRate * 0.12))
const joined = new Float32Array(rendered.reduce((n, s) => n + s.length, 0) + gap.length * (rendered.length - 1))
let offset = 0
for (const part of rendered) {
  joined.set(part, offset)
  offset += part.length + gap.length
}
save('dipan-reset', '地盘 · 运行时语句重置（修复后）', joined, 'dipan')
synth.free()

const manifest = path.join(outDir, 'manifest.json')
fs.writeFileSync(manifest, JSON.stringify(items, null, 2))
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const groups = [
  { kind: 'pianyi', title: '便宜：音素层修复前后', note: '重点听「便」在不在、准不准；修复后应能清楚听到 pián·yi 两个音节，而不是一个拖长的阳平。' },
  { kind: 'dipan', title: '地盘：语句重置前后', note: '重点听「地」是不是下降的 dì（第 4 声），而不是含混的 de。' },
]
let sections = ''
for (const group of groups) {
  let rows = ''
  for (const item of items.filter((entry) => entry.group === group.kind)) {
    const b64 = fs.readFileSync(path.join(outDir, item.file)).toString('base64')
    rows += `<div class="card"><div class="label">${esc(item.label)}</div><audio controls preload="none" src="data:audio/wav;base64,${b64}"></audio><div class="meta">${item.ms}ms · 浊音岛 ${item.islands}</div></div>`
  }
  sections += `<section class="group"><h2>${esc(group.title)}</h2><p class="note">${esc(group.note)}</p><div class="grid">${rows}</div></section>`
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2026-11-11 修复复听</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#1c2430;line-height:1.6}
.wrap{max-width:920px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 6px}.lead{color:#5a6675;font-size:14px;margin:0 0 24px}
.group{background:#fff;border:1px solid #e3e7ec;border-radius:14px;padding:20px;margin-bottom:22px}h2{font-size:17px;margin:0 0 8px}.note{font-size:13px;color:#6a7686;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.card{border:1px solid #e3e7ec;border-radius:10px;padding:12px;background:#fcfdfe}
.label{font-size:13px;font-weight:600;margin-bottom:10px}audio{width:100%;height:36px}.meta{font-size:11px;color:#8a94a3;margin-top:8px}</style></head><body><div class="wrap">
<h1>2026-11-11 两处修复 · 复听对照</h1><p class="lead">全部走真实文本前端（覆盖表补丁 + 词典最长匹配）与真实 WASM，和 App 朗读路径一致。浊音岛是波形能量段计数，用来交叉验证响了几个音节。</p>
${sections}</div></body></html>`
fs.writeFileSync(path.join(outDir, 'listen.html'), html)
console.log(`\n试听 ${path.join(outDir, 'listen.html')}`)
