/* Dev-only 音素级诊断台（山岚 / matcha）。
 *
 * 目的：把「便宜」和「地盘」拆到音素层，用真实 WASM 分别合成，让用户逐条点听，
 * 判断问题到底出在 pian2 这个音素、pian2+yi 的连读、还是词边界/韵律。
 *
 * 与线上播放的一致性：同一个 worker（public/workers/sherpa-tts.worker.js）、
 * 同一份模型、同一套覆盖表打补丁逻辑；页面只额外做两件事——把「实际送进声学
 * 模型的音素串」按 worker 的词典最长匹配算出来显示，以及提供诊断用的覆盖表。
 *
 * 本文件只在 `vite dev` 下被 /tests/browser/tts-diagnose.html 加载，不进构建。 */

const CACHE_NAME = 'shusheng-diagnose-models'
const PACK_ID = 'matcha-icefall-zh-baker'
const WORKER_URL = '/workers/sherpa-tts.worker.js'

const statusEl = document.getElementById('status')
const groupsEl = document.getElementById('groups')
const prepareBtn = document.getElementById('prepare')
const copyBtn = document.getElementById('copy')
const reportEl = document.getElementById('report')

/** 覆盖表：prod = 线上原样；probe = 诊断用（单字钉音，去掉一切边界）。 */
const OVERLAYS = {
  prod: {
    label: '生产配置',
    url: '/src/core/tts/polyphones.v1.txt',
    note: '与 App 完全一致：直接使用 src/core/tts/polyphones.v1.txt。',
  },
  probe: {
    label: '音素隔离',
    text: [
      '# 诊断用覆盖表：不写进仓库的任何线上资产。',
      '便 pian2',
      '宜 yi2',
      '地 di4',
      '# 保护状语「地」不被上面的单字条目波及。',
      '长期地 chang2 qi1 de',
      '便宜 pian2 yi2',
      '地盘 di4 pan2',
      '占便宜 zhan4 pian2 yi2',
      '会计 kuai4 ji4',
      '学会计 xue2 kuai4 ji4',
    ].join('\n'),
    note: '单字条目只在本页生效（线上禁止单字覆盖，避免整本书回归）；边界全部去掉，只留音素。',
  },
}

const VARIANTS = [
  { id: 'P1', set: 'prod', title: '单念「便宜」', text: '便宜',
    expect: '词库默认：pian2 + 轻声 yi' },
  { id: 'P2', set: 'prod', title: '单念「占便宜」', text: '占便宜',
    expect: '覆盖表：词首边界 + zhan4 pian2 yi（宜轻声，2026-11-11 第五次复听）' },
  { id: 'P3', set: 'prod', title: '单念「地盘」', text: '地盘',
    expect: '覆盖表：词首边界 + di4 pan2' },
  { id: 'P4', set: 'prod', title: '反馈原句（便宜，短）',
    text: '正因如此，一些会占便宜的有钱人长期地用盐不给钱。' },
  { id: 'P5', set: 'prod', title: 'App 实际整块（便宜，长）',
    text: '正因如此，一些会占便宜的有钱人家长期地用盐不给钱，全“记在账上”。',
    expect: 'om-0001 contexts 里记录的真实送模型文本' },
  { id: 'P6', set: 'prod', title: '反馈原句（地盘）',
    text: '朱元璋对张士诚极为头疼，自己只是占了点地盘；' },
  { id: 'P7', set: 'prod', title: '单念「会计」', text: '会计',
    expect: '词库整词：kuai4 ji4' },
  { id: 'P8', set: 'prod', title: '反馈原句（会计，修复前）',
    text: '朱文正可能是学会计出身的，',
    expect: '「学会」抢词：xue2 hui4 + ji4，会读 huì' },
  { id: 'P9', set: 'prod', title: '反馈原句（会计，零宽边界）',
    text: '朱文正可能是学\u200b会计出身的，',
    expect: '强制整词命中：xue2 + kuai4 ji4，会读 kuài' },
  { id: 'P10', set: 'prod', title: '反馈原句（便宜，零宽边界）',
    text: '正因如此，一些会\u200b占便宜的有钱人长期地用盐不给钱；',
    expect: '与 P4 同音素串，用于确认零宽边界不引入额外音节' },
  { id: 'P11', set: 'prod', title: '反馈原句（地盘，零宽边界）',
    text: '朱元璋对张士诚极为头疼，自己只是占了点\u200b地盘；',
    expect: '与 P6 同音素串，「地」保持 di4' },

  // 2026-11-11 第六轮：用户列出的 8 个词组，逐条在生产配置下复听。
  // 与 scripts/lib/wordFamily.mjs 的短句语境保持一致；逐词数值见
  // scripts/out/word-family-report.json，修复前后 WAV 见 scripts/out/audio/word-family/。
  { id: 'F1', set: 'prod', title: '词族 1/8 小便宜', text: '他这个人最爱占小便宜。',
    expect: '便=pián、宜=轻声 yi，两个音节分开，不是一段拖长的怪音' },
  { id: 'F2', set: 'prod', title: '词族 2/8 捡便宜', text: '他只想捡便宜。',
    expect: '修复前「便」只有 93ms 被吞；现在应清楚听到 pián' },
  { id: 'F3', set: 'prod', title: '词族 3/8 讨便宜', text: '不要总想着讨便宜。',
    expect: '便=pián、宜=轻声 yi' },
  { id: 'F4', set: 'prod', title: '词族 4/8 贪便宜', text: '他不肯吃亏，只想贪便宜。',
    expect: '便=pián、宜=轻声 yi' },
  { id: 'F5', set: 'prod', title: '词族 5/8 便宜货', text: '这全是便宜货。',
    expect: '实测例外：「宜」保留 yi2（改轻声反被吞），「便」仍是 pián' },
  { id: 'F6', set: 'prod', title: '词族 6/8 抢地盘', text: '他们又去抢地盘。',
    expect: '地=dì（不是含混的 de）；整词带词尾完成边界' },
  { id: 'F7', set: 'prod', title: '词族 7/8 占地盘', text: '陈友谅只想占地盘。',
    expect: '地=dì；整词带词尾完成边界' },
  { id: 'F8', set: 'prod', title: '词族 8/8 地盘', text: '自己只是占了点地盘；',
    expect: '既有修复不回退：地=dì，且「长期地」的助词仍读 de' },

  { id: 'B1', set: 'probe', title: '单念「便」', text: '便',
    expect: '整句只有一个音素：pian2' },
  { id: 'B2', set: 'probe', title: '单念「宜」', text: '宜',
    expect: '对照组：yi2' },
  { id: 'B3', set: 'probe', title: '单念「地」', text: '地',
    expect: 'di4（第 4 声，不是 de）' },
  { id: 'B4', set: 'probe', title: '「便宜」全调', text: '便宜',
    expect: 'pian2 + yi2（没有轻声化）' },
  { id: 'B5', set: 'probe', title: '「占便宜」无边界', text: '占便宜',
    expect: 'zhan4 pian2 yi2（对比 P2 的词首边界）' },
  { id: 'B6', set: 'probe', title: '「地盘」无边界', text: '地盘',
    expect: 'di4 pan2（对比 P3 的词首边界）' },
  { id: 'B7', set: 'probe', title: 'App 整块（无边界）',
    text: '正因如此，一些会占便宜的有钱人家长期地用盐不给钱，全“记在账上”。',
    expect: '同一句换成无边界，对比 P5' },
  { id: 'B8', set: 'probe', title: 'App 整块 0.85×',
    text: '正因如此，一些会占便宜的有钱人家长期地用盐不给钱，全“记在账上”。',
    speed: 0.85,
    expect: '音素不变，只把速度放慢，看时长是不是病根' },
  { id: 'B9', set: 'probe', title: '地盘原句（无边界）',
    text: '朱元璋对张士诚极为头疼，自己只是占了点地盘；',
    expect: '同一句换成无边界，对比 P6' },
  { id: 'B10', set: 'probe', title: '「学会计」整词钉音', text: '学会计',
    expect: 'xue2 kuai4 ji4（组合词覆盖，对照 P8）' },
  { id: 'B11', set: 'probe', title: '「学会计」零宽边界', text: '学\u200b会计',
    expect: 'xue2 + kuai4 ji4（运行时保护，对照 P9）' },
]

// 无头自检用：卡片数必须和变体数一致，避免页面渲染漏掉条目。
window.__diagCount = VARIANTS.length

const GROUPS = [
  {
    set: 'prod',
    title: '第 1 组 · 生产配置（App 现在发出的声音）',
    note: '这一组就是 App 里的真实链路（含 F1–F8 八个词组的逐条复听）。如果这里听着就不对，说明问题在覆盖表或声学模型，不在播放器。',
  },
  {
    set: 'probe',
    title: '第 2 组 · 音素隔离（只留音素，去掉所有边界）',
    note: '这一组回答「pian2 本身对不对」：B1 只有 pian2 一个音素，B4 是 pian2+yi2，B5/B7 是整词/整句。',
  },
]

const VERDICT_TEXT = { right: '对', wrong: '错', unclear: '含糊' }

let context = null
let source = null
let engine = null // { setId, worker, sampleRate }
let filesReady = false
let initFailure = ''

const clips = new Map() // variantId -> { samples, sampleRate, audioMs, peak, islands, error }
const verdicts = new Map() // variantId -> 'right' | 'wrong' | 'unclear'
const busy = new Set()

const lexiconBase = new Map()
let lexiconMaxLength = 1
const effectiveCache = new Map() // setId -> Map(word -> reading)

function setStatus(text) {
  statusEl.textContent = text
}

async function loadOverlayText(setId) {
  const overlay = OVERLAYS[setId]
  if (overlay.text) return overlay.text
  const response = await fetch(overlay.url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`无法读取覆盖表 ${overlay.url}（${response.status}）`)
  return response.text()
}

function parseEntries(text) {
  const entries = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (!word || !phones.length) continue
    // Matcha 把词典塞进 map，后写的行覆盖先写的行。
    entries.set(word, phones.join(' '))
  }
  return entries
}

/** 与 worker 里 patchLexicon 完全一致：先删同词原行，再把覆盖行追加到末尾。 */
function effectiveLexicon(setId, overlayText) {
  const cached = effectiveCache.get(setId)
  if (cached) return cached
  const overlay = parseEntries(overlayText)
  const words = new Set(overlay.keys())
  const merged = new Map(lexiconBase)
  for (const word of words) merged.delete(word)
  for (const [word, reading] of overlay) merged.set(word, reading)
  effectiveCache.set(setId, merged)
  return merged
}

/** 词典最长匹配，和声学模型实际收到的 token 序列一致。 */
function tokenize(text, entries) {
  const chars = Array.from(text)
  const tokens = []
  let index = 0
  while (index < chars.length) {
    let matched = ''
    const limit = Math.min(lexiconMaxLength, chars.length - index)
    for (let length = limit; length >= 1; length -= 1) {
      const candidate = chars.slice(index, index + length).join('')
      if (entries.has(candidate)) {
        matched = candidate
        break
      }
    }
    if (matched) {
      tokens.push(...entries.get(matched).split(/\s+/).filter(Boolean))
      index += Array.from(matched).length
      continue
    }
    const char = chars[index]
    // 零宽边界是 OOV 字符，WASM 直接跳过且不加 token（真实日志：OOV word skipped）。
    if (char === '\u200b') {
      index += 1
      continue
    }
    // 标点不在词典里，也不产生 token：sherpa 前端按标点把文本切成独立 utterance，
    // 这里用一个断句符号表示，避免把它误读成「丢字」。
    if (/[\p{P}\p{S}\s]/u.test(char)) {
      if (tokens[tokens.length - 1] !== '｜') tokens.push('｜')
    } else {
      tokens.push(`?${char}`)
    }
    index += 1
  }
  return tokens
}

async function loadLexicon() {
  const response = await fetch(`/models/${PACK_ID}/lexicon.v3.txt`)
  if (!response.ok) throw new Error(`无法读取词典（${response.status}）`)
  const text = await response.text()
  for (const [word, reading] of parseEntries(text)) {
    lexiconBase.set(word, reading)
    const length = Array.from(word).length
    if (length > lexiconMaxLength) lexiconMaxLength = length
  }
}

async function loadFiles() {
  const manifest = await (await fetch('/models/manifest.json')).json()
  const pack = (manifest.packs ?? []).find((item) => item.id === PACK_ID)
  if (!pack) throw new Error('manifest 里找不到山岚音色包')
  const origin = `${location.origin}/`
  return {
    pack,
    files: pack.files.map((file) => ({
      ...file,
      url: new URL(file.url, origin).href,
    })),
  }
}

async function prepareCache(files) {
  const cache = await caches.open(CACHE_NAME)
  for (const [index, file] of files.entries()) {
    const hit = await cache.match(file.url)
    if (hit) continue
    setStatus(`正在缓存模型文件 ${index + 1}/${files.length}：${file.name}`)
    const response = await fetch(file.url)
    if (!response.ok) throw new Error(`无法下载 ${file.name}（${response.status}）`)
    await cache.put(file.url, response.clone())
  }
}

function waitFor(worker, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error(`等待 ${type} 超时`))
    }, timeoutMs)
    const onMessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === 'error' && !data.jobId) {
        clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        reject(new Error(data.message || 'worker 初始化失败'))
        return
      }
      if (data.type !== type) return
      clearTimeout(timer)
      worker.removeEventListener('message', onMessage)
      resolve(data)
    }
    worker.addEventListener('message', onMessage)
  })
}

async function ensureEngine(setId) {
  if (engine?.setId === setId) return engine
  if (engine) {
    engine.worker.terminate()
    engine = null
  }
  await cachePromise
  if (!filesReady) throw new Error('模型文件尚未缓存完成')
  const overlayText = await loadOverlayText(setId)
  const { pack, files } = await loadFiles()
  setStatus(`正在加载音色（${OVERLAYS[setId].label}）…首次约 15 秒`)
  const worker = new Worker(WORKER_URL)
  const ready = waitFor(worker, 'ready', 180_000)
  worker.postMessage({
    type: 'init',
    engine: 'sherpa',
    lang: 'zh',
    cacheName: CACHE_NAME,
    speakerId: 0,
    sampleRate: 22050,
    lexiconOverlay: overlayText,
    files,
    model: {
      type: pack.model.type,
      config: pack.model.config,
      ruleFsts: pack.model.ruleFsts,
      warmupText: pack.model.warmupText,
    },
    packId: pack.id,
    packVersion: pack.version,
    variantId: '',
    glueUrl: new URL('/sherpa/runtime/sherpa-onnx-wasm-tts.js', location.origin).href,
    apiUrl: new URL('/sherpa/runtime/sherpa-onnx-tts.js', location.origin).href,
    wasmUrl: new URL('/sherpa/runtime/sherpa-onnx-wasm-tts.wasm', location.origin).href,
  })
  const info = await ready
  engine = { setId, worker, sampleRate: info.sampleRate || 22050 }
  return engine
}

function synth(worker, text, speed) {
  const jobId = `diag-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error('合成超时'))
    }, 90_000)
    const onMessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.jobId !== jobId) return
      clearTimeout(timer)
      worker.removeEventListener('message', onMessage)
      if (data.type === 'error') {
        reject(new Error(data.message || '合成失败'))
        return
      }
      if (data.type !== 'result') return
      resolve({
        samples: new Float32Array(data.samples),
        sampleRate: data.sampleRate,
      })
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({
      type: 'synth',
      lang: 'zh',
      epoch: 1,
      jobId,
      text,
      speed,
      speakerId: 0,
      silenceScale: 1,
      volume: 1,
    })
  })
}

function metrics(samples, sampleRate) {
  const audioMs = Math.round((samples.length / sampleRate) * 1000)
  let peak = 0
  let sumSquares = 0
  let active = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    if (magnitude > 0.008) {
      active += 1
      sumSquares += value * value
    }
  }

  // 浊音岛按 20ms 帧的 RMS 包络统计：单个波形过零点不能算断音。单念一个音节
  // 正常只有 1 个岛，超过 2 个说明中间被切断了。
  const frame = Math.max(1, Math.round(sampleRate * 0.02))
  const floor = 0.01
  const minFrames = 3
  let islands = 0
  let run = 0
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame)
    let energy = 0
    for (let i = start; i < end; i += 1) energy += samples[i] * samples[i]
    const level = Math.sqrt(energy / (end - start))
    if (level > floor) {
      run += 1
    } else {
      if (run >= minFrames) islands += 1
      run = 0
    }
  }
  if (run >= minFrames) islands += 1

  return {
    audioMs,
    peak: Number(peak.toFixed(3)),
    rms: active ? Number(Math.sqrt(sumSquares / active).toFixed(3)) : 0,
    islands,
  }
}

function ensureContext() {
  if (context) return context
  const Ctor = window.AudioContext ?? window.webkitAudioContext
  context = new Ctor()
  return context
}

function stopPlayback() {
  if (!source) return
  try {
    source.stop()
  } catch {
    // 已经结束
  }
  source.disconnect()
  source = null
}

function play(clip) {
  const audio = ensureContext()
  if (audio.state === 'suspended') void audio.resume()
  stopPlayback()
  const buffer = audio.createBuffer(1, clip.samples.length, clip.sampleRate)
  buffer.copyToChannel(clip.samples, 0)
  const node = audio.createBufferSource()
  node.buffer = buffer
  node.connect(audio.destination)
  node.onended = () => {
    if (source === node) source = null
  }
  source = node
  node.start()
}

async function clipFor(variant, { playNow = false } = {}) {
  if (clips.has(variant.id)) {
    const clip = clips.get(variant.id)
    if (clip.error) throw new Error(clip.error)
    if (playNow) play(clip)
    return clip
  }
  const { worker, sampleRate } = await ensureEngine(variant.set)
  const result = await synth(worker, variant.text, variant.speed ?? 1)
  const clip = {
    samples: result.samples,
    sampleRate: result.sampleRate || sampleRate,
    ...metrics(result.samples, result.sampleRate || sampleRate),
  }
  clips.set(variant.id, clip)
  if (playNow) play(clip)
  return clip
}

// ---------------------------------------------------------------- 渲染

function variantTokens(variant) {
  const overlay = OVERLAYS[variant.set]
  if (!overlay.entries) return null
  return tokenize(variant.text, overlay.entries)
}

function render() {
  groupsEl.textContent = ''
  for (const group of GROUPS) {
    const heading = document.createElement('h2')
    heading.textContent = group.title
    groupsEl.append(heading)
    const note = document.createElement('p')
    note.className = 'group-note'
    note.textContent = `${group.note}（${OVERLAYS[group.set].note}）`
    groupsEl.append(note)

    for (const variant of VARIANTS.filter((item) => item.set === group.set)) {
      groupsEl.append(renderCard(variant))
    }
  }
  updateButtons()
}

function renderCard(variant) {
  const card = document.createElement('article')
  card.className = 'card'
  card.dataset.id = variant.id

  const head = document.createElement('div')
  head.className = 'card-head'
  const id = document.createElement('span')
  id.className = 'id'
  id.textContent = variant.id
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = variant.title
  head.append(id, title)
  card.append(head)

  const text = document.createElement('p')
  text.className = 'text'
  text.textContent = variant.text
  card.append(text)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const tokens = variantTokens(variant)
  const tokenLine = document.createElement('div')
  tokenLine.innerHTML = '音素串（模型实际收到）：<code></code>'
  tokenLine.querySelector('code').textContent = tokens
    ? tokens.map((token) => (token === '"' ? '⟨词界⟩' : token)).join(' ')
    : '—'
  meta.append(tokenLine)
  if (variant.expect) {
    const expectLine = document.createElement('div')
    expectLine.textContent = `预期：${variant.expect}`
    meta.append(expectLine)
  }
  if (variant.speed) {
    const speedLine = document.createElement('div')
    speedLine.textContent = `速度：${variant.speed}×`
    meta.append(speedLine)
  }
  card.append(meta)

  const actions = document.createElement('div')
  actions.className = 'actions'
  const playBtn = document.createElement('button')
  playBtn.className = 'primary'
  playBtn.textContent = '播放'
  playBtn.addEventListener('click', () => void onPlay(variant, playBtn))
  const dur = document.createElement('span')
  dur.className = 'dur'
  actions.append(playBtn, dur)

  const verdict = document.createElement('div')
  verdict.className = 'verdict'
  for (const value of ['right', 'wrong', 'unclear']) {
    const btn = document.createElement('button')
    btn.dataset.v = value
    btn.textContent = VERDICT_TEXT[value]
    btn.setAttribute('aria-pressed', 'false')
    btn.addEventListener('click', () => {
      if (verdicts.get(variant.id) === value) verdicts.delete(variant.id)
      else verdicts.set(variant.id, value)
      for (const other of verdict.children) {
        other.setAttribute(
          'aria-pressed',
          String(verdicts.get(variant.id) === other.dataset.v),
        )
      }
      updateReport()
    })
    verdict.append(btn)
  }
  actions.append(verdict)
  card.append(actions)

  const error = document.createElement('div')
  error.className = 'err'
  error.hidden = true
  card.append(error)
  return card
}

function cardOf(variantId) {
  return groupsEl.querySelector(`.card[data-id="${variantId}"]`)
}

function showError(variantId, message) {
  const card = cardOf(variantId)
  if (!card) return
  const error = card.querySelector('.err')
  error.hidden = false
  error.textContent = message
}

function showDuration(variantId) {
  const clip = clips.get(variantId)
  const card = cardOf(variantId)
  if (!clip || !card) return
  card.querySelector('.dur').textContent =
    `${clip.audioMs}ms · 浊音岛 ${clip.islands} · 峰值 ${clip.peak}`
}

async function onPlay(variant, button) {
  if (busy.has(variant.id)) return
  if (!filesReady) setStatus('模型文件还在缓存，播放会在缓存完成后自动开始…')
  busy.add(variant.id)
  button.disabled = true
  const card = cardOf(variant.id)
  card?.classList.add('on')
  try {
    await clipFor(variant, { playNow: true })
    showDuration(variant.id)
    if (card) card.querySelector('.err').hidden = true
    setStatus(`播放 ${variant.id} · ${variant.title}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showError(variant.id, message)
    setStatus(`合成失败：${message}`)
  } finally {
    busy.delete(variant.id)
    button.disabled = false
    card?.classList.remove('on')
  }
}

function updateButtons() {
  prepareBtn.disabled = !filesReady
}

function updateReport() {
  const rows = VARIANTS.map((variant) => {
    const clip = clips.get(variant.id)
    const verdict = verdicts.get(variant.id)
    const tokens = variantTokens(variant)
    const parts = [
      variant.id,
      variant.title,
      tokens ? tokens.map((token) => (token === '"' ? '|' : token)).join(' ') : '—',
      clip ? `${clip.audioMs}ms` : '未合成',
      verdict ? VERDICT_TEXT[verdict] : '未判定',
    ]
    return parts.join('\t')
  })
  reportEl.value = [
    `山岚音素诊断 · ${new Date().toLocaleString('zh-CN')}`,
    '编号\t标题\t音素串\t时长\t判定',
    ...rows,
  ].join('\n')
}

// ---------------------------------------------------------------- 批量准备

async function prepareAll() {
  prepareBtn.disabled = true
  copyBtn.disabled = true
  let done = 0
  try {
    for (const variant of VARIANTS) {
      if (clips.has(variant.id)) {
        done += 1
        continue
      }
      setStatus(`准备音频 ${done + 1}/${VARIANTS.length}：${variant.id} ${variant.title}`)
      const card = cardOf(variant.id)
      card?.classList.add('on')
      try {
        await clipFor(variant)
        showDuration(variant.id)
      } catch (error) {
        showError(variant.id, error instanceof Error ? error.message : String(error))
      }
      card?.classList.remove('on')
      done += 1
    }
    setStatus(`全部 ${VARIANTS.length} 条已就绪，点「播放」逐条听。`)
  } finally {
    prepareBtn.disabled = false
    copyBtn.disabled = false
    updateReport()
  }
}

async function copyReport() {
  updateReport()
  try {
    await navigator.clipboard.writeText(reportEl.value)
    setStatus('结论已复制到剪贴板，直接粘贴发回即可。')
  } catch {
    reportEl.select()
    setStatus('复制被浏览器拦截，已选中文本，按 Ctrl+C 复制。')
  }
}

// ---------------------------------------------------------------- 自检（无头）

window.__diagSelfCheck = async () => {
  await bootPromise
  const rows = []
  for (const variant of VARIANTS) {
    const tokens = variantTokens(variant)
    try {
      const clip = await clipFor(variant)
      rows.push({
        id: variant.id,
        tokens: tokens ? tokens.join(' ') : '',
        audioMs: clip.audioMs,
        islands: clip.islands,
        peak: clip.peak,
        rms: clip.rms,
      })
    } catch (error) {
      rows.push({ id: variant.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return rows
}

// ---------------------------------------------------------------- 启动

const bootPromise = (async () => {
  setStatus('正在读取词典…')
  await loadLexicon()
  // 覆盖表先读进来：音素串是判断「词有没有被正确匹配」的第一手证据，
  // 不该等 130MB 模型缓存完才显示。
  for (const setId of Object.keys(OVERLAYS)) {
    const text = await loadOverlayText(setId)
    OVERLAYS[setId].entries = effectiveLexicon(setId, text)
  }
  render()
  updateReport()
})()

const cachePromise = (async () => {
  await bootPromise
  const { files } = await loadFiles()
  await prepareCache(files)
  filesReady = true
  updateButtons()
  setStatus('模型已缓存。点「准备全部音频」或直接点某一条的「播放」。')
  window.__diagReady = true
})().catch((error) => {
  initFailure = error instanceof Error ? error.message : String(error)
  setStatus(`初始化失败：${initFailure}`)
  window.__diagError = initFailure
})

prepareBtn.addEventListener('click', () => void prepareAll())
copyBtn.addEventListener('click', () => void copyReport())
