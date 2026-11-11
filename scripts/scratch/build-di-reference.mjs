// Dev-only: build a same-device reference page with the app-faithful lexicon.
// Every clip is rendered by model-steps-3.onnx with the same noise/length config
// the app worker uses, so the user can compare 第(di4) / 的(de) / the six
// sentences on the same phone speaker or headphones.
import fs from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib/reading.mjs'
import { buildRuntimeLexicon, readAsset } from '../lib/wordFamily.mjs'
import { createMatchaSynth } from '../lib/matchaSynth.mjs'
import {
  mergeLexiconOverlays, normalizeOverlayText,
} from '../../src/core/tts/pinyinTones.ts'

const OUT = join(ROOT, 'public', 'di-test')
mkdirSync(OUT, { recursive: true })

const base = fs.readFileSync(
  join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt'), 'utf8',
).replace(/^\uFEFF/, '')
const curated = readAsset('src/core/tts/polyphones.v1.txt')
const appOverlay = normalizeOverlayText(mergeLexiconOverlays(curated, ''))
const overlayLines = appOverlay.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
const overlayWords = new Set(overlayLines.map((line) => line.split(/\s+/)[0]))
const kept = base.split(/\r?\n/).filter((line) => {
  const trimmed = line.trim()
  return trimmed && !overlayWords.has(trimmed.split(/\s+/)[0])
})
const patched = `${kept.join('\n')}\n${overlayLines.join('\n')}\n`
const lexiconPath = join(OUT, 'lexicon.txt')
writeFileSync(lexiconPath, patched, 'utf8')

const clips = [
  { id: 'di4', label: '第（参考：dì）', hint: '单字「第」= di4，清晰 /i/；如果这个也听成 de，说明是外放/听感问题。', text: '第。' },
  { id: 'de', label: '的（参考：de）', hint: '单字「的」= 轻声 de，用来和 dì 对比。', text: '的。' },
  { id: 'kongdi-word', label: '空地（单词）', hint: '只读「空地」两个字。', text: '空地。' },
  { id: 'huangdi', label: '村里把荒地开垦成了良田。', hint: '荒地：覆盖表 tail 边界，地=di4。', text: '村里把荒地开垦成了良田。' },
  { id: 'kongdi', label: '楼前有一片空地可以停车。', hint: '空地：覆盖表 lead 边界，地=di4。', text: '楼前有一片空地可以停车。' },
  { id: 'lindi', label: '这片林地受到严格保护。', hint: '林地：覆盖表 tail 边界，地=di4。', text: '这片林地受到严格保护。' },
  { id: 'bendi', label: '这家店只卖本地特产。', hint: '本地：覆盖表 tail 边界，地=di4。', text: '这家店只卖本地特产。' },
  { id: 'ditu', label: '他打开地图寻找路线。', hint: '地图：覆盖表 both 边界，地=di4。', text: '他打开地图寻找路线。' },
  { id: 'dixin', label: '科学家在研究地心的结构。', hint: '地心：基础词典整词 di4，无边界。', text: '科学家在研究地心的结构。' },
  { id: 'didong', label: '兔子钻进地洞里躲了起来。', hint: '地洞：基础词典整词 di4，无边界。', text: '兔子钻进地洞里躲了起来。' },
]

const synth = await createMatchaSynth({ quiet: true, lexiconPath })
try {
  const manifest = []
  for (const clip of clips) {
    const result = synth.generateText(clip.text)
    const file = `${clip.id}.wav`
    synth.save(join(OUT, file), { samples: result.samples, sampleRate: synth.sampleRate })
    manifest.push({ ...clip, file, ms: Math.round(result.samples.length / synth.sampleRate * 1000) })
    console.log(`${clip.id.padEnd(12)} ${manifest.at(-1).ms}ms ${file}`)
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const cards = manifest.map((item) => `
    <section class="card">
      <h2>${item.label}</h2>
      <p>${item.hint}</p>
      <audio controls preload="none" src="${item.file}"></audio>
    </section>`).join('\n')

  writeFileSync(join(OUT, 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>山岚「地」读音参考</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px 16px 48px; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .intro { margin: 0 0 20px; opacity: .78; }
  .intro strong { opacity: 1; }
  .card { padding: 14px 0 16px; border-top: 1px solid rgba(127,127,127,.28); }
  .card h2 { font-size: 17px; margin: 0 0 2px; }
  .card p { margin: 0 0 10px; font-size: 13px; opacity: .7; }
  audio { width: 100%; }
  .note { margin-top: 24px; padding: 12px 14px; border-radius: 10px; background: rgba(127,127,127,.12); font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>山岚「地」读音参考</h1>
  <p class="intro">全部音频由 <strong>同一个 model-steps-3.onnx</strong>、同一套 v6 词典和与 App 相同的 noise/length 配置生成。请用<strong>同一台设备、同一音量</strong>：先听「第（dì）」和「的（de）」，再听六句。</p>
  ${cards}
  <p class="note">如果连「第（dì）」都听成 de，说明是外放/耳机或听感把高元音 /i/ 弱化了，不是 App 把地读成了 de；如果「第」是清楚的 dì、而某一句仍然是 de，请告诉我具体哪一条，我按那条的音频继续查。</p>
</main>
</body>
</html>
`, 'utf8')
} finally {
  synth.free()
}
