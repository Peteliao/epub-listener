// Phoneme-level diagnosis for 便宜: is `pian2` itself broken, or does the
// `pian2 + yi2` sequence collapse into one syllable?
//
// Method: real Matcha WASM. For every variant we measure the *duration
// contribution* of each syllable (duration of the full sequence minus the
// duration with that phone removed -- the same ablation the omission gate
// uses), plus the number of voicing islands in the waveform. A swallowed
// syllable contributes <100ms; a merged one >350ms.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import { classifyContribution } from '../lib/acousticScoring.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(ROOT, 'scripts/out/audio/pian2')
fs.mkdirSync(outDir, { recursive: true })
const synth = await createMatchaSynth({ quiet: true })
const SR = synth.sampleRate

function voicingIslands(samples) {
  const win = Math.floor(0.02 * SR)
  const env = []
  for (let i = 0; i + win < samples.length; i += win) {
    let energy = 0
    for (let j = i; j < i + win; j += 1) energy += samples[j] * samples[j]
    env.push(Math.sqrt(energy / win))
  }
  const peak = Math.max(...env)
  const threshold = peak * 0.25
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
  return { islands: count, peak: Number(peak.toFixed(4)) }
}

// The flat 24-phone stream the app really sends for the feedback sentence
// (正因如此，一些会占便宜的有钱人长期地用盐不给钱。).
const SENTENCE = [
  'zheng4', 'yin1', 'ru2', 'ci3', ',', 'yi4', 'xie1', 'hui4',
  'zhan4', 'pian2', 'yi2', 'de', 'you3', 'qian2', 'ren2',
  'chang2', 'qi1', 'de', 'yong4', 'yan2', 'bu4', 'gei3', 'qian2', '.',
]
function sentenceWith(phones, lead = false) {
  const at = SENTENCE.indexOf('zhan4')
  return [
    ...SENTENCE.slice(0, at),
    ...(lead ? ['"'] : []),
    ...phones,
    ...SENTENCE.slice(at + 3),
  ]
}

const cases = [
  { key: 'pian-alone', group: 'isolated', label: '单独念「便」pian2', tokens: ['pian2', '.'], focus: [0], syllables: 1 },
  { key: 'yi2-alone', group: 'isolated', label: '单独念「宜」yi2', tokens: ['yi2', '.'], focus: [0], syllables: 1 },
  { key: 'yi-alone', group: 'isolated', label: '单独念「宜」yi（轻声）', tokens: ['yi', '.'], focus: [0], syllables: 1 },
  { key: 'pianyi-full', group: 'word', label: '便宜 pian2 yi2（宜全调）', tokens: ['pian2', 'yi2', '.'], focus: [0, 1], syllables: 2 },
  { key: 'pianyi-neutral', group: 'word', label: '便宜 pian2 yi（宜轻声，词库原读）', tokens: ['pian2', 'yi', '.'], focus: [0, 1], syllables: 2 },
  { key: 'zhany-deployed', group: 'word', label: '占便宜 " zhan4 pian2 yi2（当前部署）', tokens: ['"', 'zhan4', 'pian2', 'yi2', '.'], focus: [2, 3], syllables: 3 },
  { key: 'zhany-neutral', group: 'word', label: '占便宜 zhan4 pian2 yi（候选）', tokens: ['zhan4', 'pian2', 'yi', '.'], focus: [1, 2], syllables: 3 },
  { key: 'zhany-neutral-lead', group: 'word', label: '占便宜 " zhan4 pian2 yi（候选＋词首边界）', tokens: ['"', 'zhan4', 'pian2', 'yi', '.'], focus: [2, 3], syllables: 3 },
  { key: 'pian-boundary-yi2', group: 'word', label: '便｜宜 词内边界（已否决）', tokens: ['pian2', '"', 'yi2', '.'], focus: [0, 2], syllables: 2 },
  { key: 'sentence-deployed', group: 'sentence', label: '完整反馈原句 · 当前部署', tokens: sentenceWith(['zhan4', 'pian2', 'yi2'], true), focus: [10], syllables: 24 },
  { key: 'sentence-neutral', group: 'sentence', label: '完整反馈原句 · 宜改轻声 yi', tokens: sentenceWith(['zhan4', 'pian2', 'yi']), focus: [9], syllables: 24 },
  { key: 'sentence-neutral-lead', group: 'sentence', label: '完整反馈原句 · 轻声＋词首边界', tokens: sentenceWith(['zhan4', 'pian2', 'yi'], true), focus: [10], syllables: 24 },
]

const report = []
for (const item of cases) {
  const result = synth.generate(item.tokens)
  const wav = path.join(outDir, `${item.key}.wav`)
  synth.save(wav, result)
  const voice = voicingIslands(result.samples)
  const contributions = synth.contributions(item.tokens, item.focus)
  const measured = item.focus.map((index, position) => ({
    phone: item.tokens[index],
    index,
    ms: contributions[position],
    state: classifyContribution(contributions[position]),
  }))
  const entry = {
    key: item.key,
    group: item.group,
    label: item.label,
    tokens: item.tokens,
    ms: Math.round(result.samples.length / SR * 1000),
    ...voice,
    expectedSyllables: item.group === 'sentence' ? null : item.syllables,
    measured,
  }
  report.push(entry)
  console.log(
    `[${item.key}] ${item.ms ?? entry.ms}ms · 浊音岛 ${voice.islands}` +
    ` · ${measured.map((m) => `${m.phone} ${m.ms}ms/${m.state}`).join(', ')}`,
  )
}

const jsonPath = path.join(ROOT, 'scripts/out/pian2-diagnosis.json')
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const groups = [
  { kind: 'isolated', title: '第一步 · 单独念，音素本身坏没坏', note: '听「便」pian2 单独是否清楚。如果它单独就是坏的，改「宜」也没用。' },
  { kind: 'word', title: '第二步 · 一词之内，pian2 会不会被「宜」吞掉', note: '对比「宜」全调 yi2 与轻声 yi；轻声是标准读音 pián·yi，也是词库原读。' },
  { kind: 'sentence', title: '第三步 · 完整反馈原句', note: '「正因如此，一些会占便宜的有钱人长期地用盐不给钱。」听「便」在不在、准不准。' },
]
let sections = ''
for (const group of groups) {
  let rows = ''
  for (const item of report.filter((entry) => entry.group === group.kind)) {
    const b64 = fs.readFileSync(path.join(outDir, `${item.key}.wav`)).toString('base64')
    const metrics = item.measured.map((m) => `${m.phone} ${m.ms}ms ${m.state}`).join(' · ')
    rows += `<div class="card"><div class="label">${esc(item.label)}</div>` +
      `<audio controls preload="none" src="data:audio/wav;base64,${b64}"></audio>` +
      `<div class="meta">${item.ms}ms · 浊音岛 ${item.islands} · ${esc(metrics)}</div></div>`
  }
  sections += `<section class="group"><h2>${esc(group.title)}</h2><p class="note">${esc(group.note)}</p><div class="grid">${rows}</div></section>`
}
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>便宜 · 音素级诊断</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#1c2430;line-height:1.6}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 6px}.lead{color:#5a6675;font-size:14px;margin:0 0 24px}
.group{background:#fff;border:1px solid #e3e7ec;border-radius:14px;padding:20px;margin-bottom:22px}h2{font-size:17px;margin:0 0 8px}.note{font-size:13px;color:#6a7686;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.card{border:1px solid #e3e7ec;border-radius:10px;padding:12px;background:#fcfdfe}
.label{font-size:13px;font-weight:600;margin-bottom:10px}audio{width:100%;height:36px}.meta{font-size:11px;color:#8a94a3;margin-top:8px}</style></head><body><div class="wrap">
<h1>「便宜」音素级诊断</h1><p class="lead">时长来自真实 WASM 逐音节消融：&lt;100ms 判被吞、&gt;350ms 判与邻音合并。「浊音岛」是波形能量段的计数，用来交叉验证到底响了几个音节。</p>
${sections}</div></body></html>`
fs.writeFileSync(path.join(outDir, 'listen.html'), html)
synth.free()
console.log(`\n报告 ${jsonPath}\n试听 ${path.join(outDir, 'listen.html')}`)
