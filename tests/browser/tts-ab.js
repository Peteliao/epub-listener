/* Dev-only A/B harness for the 山岚 (matcha) voice.
 * Served by `vite dev` at /tests/browser/tts-ab.html; never bundled. */
const statusEl = document.getElementById('status')
const outEl = document.getElementById('out')
const CACHE_NAME = 'ab-harness-models'
const THRESHOLD = 0.0018
const NOISE_SCALES = [0.5, 0.667, 0.8]
const SILENCE_SCALES = [0.8, 1, 1.2]
const GROUP_CHARS = [60, 90, 120]
const REPEATS = 12

// Randomise the grid order on every run. A fixed [0.5, 0.667, 0.8] order made
// the first worker pay for WASM/JIT cold start and confounded the comparison.
const SEED = Math.floor(Math.random() * 2 ** 31)
function makeRng(seed) {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffled(values) {
  const rng = makeRng(SEED)
  const list = [...values]
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

const SENTENCES = [
  '山岚把信纸铺开，窗外的雨声慢慢轻了。',
  '他说：“走吧。”然后推开了那扇旧木门。',
  '纸页上写着一九九八年的日期，还有一个模糊的邮戳。',
  '她忽然停下脚步，回头看了看那条空荡荡的巷子。',
  '铜弹子发出艰涩的响声，钥匙插进大半就卡住了。',
  '炉子上的水开了，白汽沿着窗缝往外冒。',
  '孩子们跑过晒谷场，惊起一群灰扑扑的麻雀。',
  '他知道这件事，却始终没有开口。',
  '月亮从山后升起来，把院子照得一片清白。',
  '那封信在路上走了整整十载，纸边都磨毛了。',
  '她把头发挽起来，低头继续缝那件旧衣裳。',
  '你能不能，再等我一会儿？',
  '风卷起地上的落叶，一路追着车轮跑。',
  '老人慢慢地说，声音低得几乎听不见。',
  '他猛地站起身，椅子在青石板上刮出一声长响。',
  '书架最上一层放着一排没有封面的旧书。',
  '雨停了，屋檐还在滴答，远处传来几声犬吠。',
  '这不是第一次，也不会是最后一次。',
  '她把那张照片夹进书里，合上了灯。',
  '山路很长，长到看不见尽头。',
]

function log(text) {
  statusEl.textContent = text
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function p95(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

function metrics(result) {
  const samples = new Float32Array(result.samples)
  const rate = result.sampleRate
  const audioMs = (samples.length / rate) * 1000
  let active = 0
  let sumSq = 0
  let peak = 0
  let quiet = 0
  let pauses = 0
  const minPause = Math.round(rate * 0.1)
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    if (magnitude < THRESHOLD) {
      quiet += 1
    } else {
      if (quiet >= minPause) pauses += 1
      quiet = 0
      active += 1
      sumSq += value * value
    }
  }
  return {
    audioMs: Math.round(audioMs),
    synthMs: result.synthMs,
    rtf: Number((result.synthMs / audioMs).toFixed(3)),
    silenceRatio: Number((1 - active / samples.length).toFixed(4)),
    pauses,
    rms: active ? Number(Math.sqrt(sumSq / active).toFixed(4)) : 0,
    peak: Number(peak.toFixed(4)),
    samples,
  }
}

function wavUrl(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

async function prepareCache(files) {
  const cache = await caches.open(CACHE_NAME)
  for (const [index, file] of files.entries()) {
    log(`缓存模型文件 ${index + 1}/${files.length}：${file.name}`)
    const response = await fetch(file.url)
    if (!response.ok) throw new Error(`无法下载 ${file.name}（${response.status}）`)
    await cache.put(file.url, response)
  }
}

function once(worker, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error(`等待 ${type} 超时`))
    }, timeoutMs)
    const onMessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === 'error') {
        clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        reject(new Error(data.message || 'worker error'))
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

async function initWorker(payload) {
  const worker = new Worker('/workers/sherpa-tts.worker.js')
  worker.addEventListener('error', (event) => {
    window.__abError = event.message || 'worker crashed'
  })
  const ready = once(worker, 'ready', 180_000)
  worker.postMessage(payload)
  const info = await ready
  const probe = once(worker, 'probe-result', 10_000)
  worker.postMessage({ type: 'probe', lang: 'zh' })
  const probeInfo = await probe
  return { worker, info, probeInfo }
}

async function synth(worker, text, silenceScale) {
  const jobId = `job-${Math.random().toString(36).slice(2)}`
  const result = once(worker, 'result', 90_000)
  worker.postMessage({
    type: 'synth',
    lang: 'zh',
    epoch: 1,
    jobId,
    text,
    speed: 1,
    silenceScale,
    speakerId: 0,
    volume: 1,
  })
  const message = await result
  if (message.jobId !== jobId) throw new Error('jobId 不匹配')
  return metrics(message)
}

function summarise(rows) {
  return {
    n: rows.length,
    synthMsMean: Math.round(mean(rows.map((r) => r.synthMs))),
    synthMsP95: Math.round(p95(rows.map((r) => r.synthMs))),
    rtfMean: Number(mean(rows.map((r) => r.rtf)).toFixed(3)),
    audioMsMean: Math.round(mean(rows.map((r) => r.audioMs))),
    silenceRatio: Number(mean(rows.map((r) => r.silenceRatio)).toFixed(4)),
    pauses: Number(mean(rows.map((r) => r.pauses)).toFixed(2)),
    rms: Number(mean(rows.map((r) => r.rms)).toFixed(4)),
    peak: Number(mean(rows.map((r) => r.peak)).toFixed(4)),
  }
}

function groupText(maxChars) {
  let text = ''
  for (const sentence of SENTENCES) {
    if (Array.from(text + sentence).length > maxChars) break
    text += sentence
  }
  return text
}

async function main() {
  const manifest = await (await fetch('/models/manifest.json')).json()
  const pack = manifest.packs.find((item) => item.id === 'matcha-icefall-zh-baker')
  if (!pack) throw new Error('manifest 中找不到山岚音色包')

  const origin = location.origin
  const files = pack.files.map((file) => ({
    ...file,
    url: new URL(file.url, `${origin}/`).href,
  }))
  let lexiconOverlay = ''
  try {
    lexiconOverlay = await (await fetch('/src/core/tts/polyphones.v1.txt')).text()
  } catch {
    lexiconOverlay = ''
  }

  await prepareCache(files)
  const basePayload = {
    type: 'init',
    engine: 'sherpa',
    lang: 'zh',
    cacheName: CACHE_NAME,
    speakerId: 0,
    sampleRate: 22050,
    lexiconOverlay,
    files,
    model: {
      type: 'matcha',
      config: pack.model.config,
      ruleFsts: pack.model.ruleFsts,
      warmupText: pack.model.warmupText,
    },
    packId: pack.id,
    packVersion: pack.version,
    variantId: '',
    glueUrl: new URL('/sherpa/runtime/sherpa-onnx-wasm-tts.js', origin).href,
    apiUrl: new URL('/sherpa/runtime/sherpa-onnx-tts.js', origin).href,
    wasmUrl: new URL('/sherpa/runtime/sherpa-onnx-wasm-tts.wasm', origin).href,
  }

  const results = { samples: {} }
  const clips = {}
  const noiseOrder = shuffled(NOISE_SCALES)
  const silenceOrder = shuffled(SILENCE_SCALES)
  const groupOrder = shuffled(GROUP_CHARS)
  let sequence = 0

  for (const noiseScale of noiseOrder) {
    log(`初始化 noiseScale=${noiseScale} …`)
    const { worker, info, probeInfo } = await initWorker({
      ...basePayload,
      model: {
        ...basePayload.model,
        config: { ...pack.model.config, noiseScale },
      },
    })
    // Discard one synthesis so WASM/JIT warm-up never lands in the measured
    // group, whichever position this parameter was randomised into.
    await synth(worker, SENTENCES[0], 1)

    results[`noise-${noiseScale}`] = {
      initMs: info.initMs,
      warmupMs: info.warmupMs,
      heapBytes: info.heapBytes,
      releasedModelBytes: info.releasedModelBytes,
      memfs: probeInfo.files,
    }

    const rows = []
    const durations = []
    for (const sentence of SENTENCES.slice(0, 12)) {
      const first = await synth(worker, sentence, 1)
      const second = await synth(worker, sentence, 1)
      rows.push(first, second)
      durations.push(
        Math.abs(first.audioMs - second.audioMs) / first.audioMs,
      )
    }
    results[`noise-${noiseScale}`].sentences = summarise(rows)
    results[`noise-${noiseScale}`].durationDrift = Number(
      mean(durations).toFixed(4),
    )

    // Repeated runs of one fixed sentence give a distribution, not a single
    // point, so the runner can test whether the groups actually differ.
    const repeats = []
    for (let i = 0; i < REPEATS; i += 1) {
      const row = await synth(worker, SENTENCES[0], 1)
      repeats.push(row.rtf)
    }
    results.samples[`noise-${noiseScale}`] = repeats

    if (Math.abs(noiseScale - 0.667) < 1e-6) {
      for (const silenceScale of silenceOrder) {
        log(`评测 silenceScale=${silenceScale} …`)
        const silenceRows = []
        for (const sentence of SENTENCES.slice(0, 6)) {
          silenceRows.push(await synth(worker, sentence, silenceScale))
        }
        results[`silence-${silenceScale}`] = summarise(silenceRows)
        const silenceSamples = []
        for (let i = 0; i < 6; i += 1) {
          const row = await synth(worker, SENTENCES[1], silenceScale)
          silenceSamples.push(row.silenceRatio)
        }
        results.samples[`silence-${silenceScale}`] = silenceSamples
        // Keep one dialogue line for the listening desk.
        const clip = await synth(worker, SENTENCES[1], silenceScale)
        const key = `${noiseScale}|${silenceScale}`
        clips[key] = {
          url: wavUrl(clip.samples, info.sampleRate),
          audioMs: clip.audioMs,
        }
      }
      for (const maxChars of groupOrder) {
        log(`评测句组长度 ${maxChars} 字 …`)
        const text = groupText(maxChars)
        const rowsForGroup = []
        for (let i = 0; i < 3; i += 1) {
          rowsForGroup.push(await synth(worker, text, 1))
        }
        results[`group-${maxChars}`] = {
          chars: Array.from(text).length,
          ...summarise(rowsForGroup),
        }
        results.samples[`group-${maxChars}`] = rowsForGroup.map(
          (row) => row.synthMs,
        )
      }
    }

    worker.terminate()
    sequence += 1
  }

  // A short warm-up clip after every init also proves synthesis still works
  // with the ONNX copies removed from MEMFS.
  results.synthesisAfterRelease = sequence === NOISE_SCALES.length
  results.grid = {
    seed: SEED,
    noiseOrder,
    silenceOrder,
    groupOrder,
    repeats: REPEATS,
    sentences: SENTENCES.length,
  }

  window.__abResults = results
  window.__abDone = true
  outEl.textContent = JSON.stringify(results, null, 2)
  log('评测完成')

  const a = document.getElementById('a')
  const b = document.getElementById('b')
  for (const [index, key] of Object.keys(clips).entries()) {
    for (const select of [a, b]) {
      const option = document.createElement('option')
      option.value = key
      option.textContent = `方案 ${index + 1}`
      select.appendChild(option)
    }
  }
  if (Object.keys(clips).length > 1) b.selectedIndex = 1
  document.getElementById('listen').hidden = false
  document.getElementById('players').hidden = false
  const audioA = document.getElementById('audioA')
  const audioB = document.getElementById('audioB')
  const loadClips = () => {
    audioA.src = clips[a.value].url
    audioB.src = clips[b.value].url
  }
  a.addEventListener('change', loadClips)
  b.addEventListener('change', loadClips)
  loadClips()

  const scores = JSON.parse(localStorage.getItem('ab-scores') || '[]')
  const render = () => {
    document.getElementById('scores').textContent = scores.length
      ? `已记录 ${scores.length} 次评分\n${JSON.stringify(scores.slice(-5), null, 2)}`
      : '尚未打分'
  }
  const score = (value) => {
    scores.push({ a: a.value, b: b.value, winner: value, at: Date.now() })
    localStorage.setItem('ab-scores', JSON.stringify(scores))
    render()
  }
  document.getElementById('scoreA').addEventListener('click', () => score('A'))
  document.getElementById('scoreTie').addEventListener('click', () => score('tie'))
  document.getElementById('scoreB').addEventListener('click', () => score('B'))
  document.getElementById('export').addEventListener('click', () => {
    outEl.textContent = JSON.stringify(scores, null, 2)
  })
  render()
}

main().catch((error) => {
  window.__abError = error instanceof Error ? error.message : String(error)
  log(`失败：${window.__abError}`)
  console.error(error)
})
