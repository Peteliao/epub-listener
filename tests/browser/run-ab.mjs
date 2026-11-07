#!/usr/bin/env node
// Self-contained runner for the 山岚 A/B harness: starts Vite, drives a real
// Chrome over CDP, waits for the WASM grid to finish, and writes the metrics.
// No third-party browser driver needed (Node 22+ has a built-in WebSocket).
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 5199
const ORIGIN = `http://127.0.0.1:${PORT}`
const HARNESS = `${ORIGIN}/tests/browser/tts-ab.html`
const OUT_DIR = join(ROOT, 'scripts', 'out')
const OUT_FILE = join(OUT_DIR, 'ab-results.json')
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000

function chromePath() {
  for (const candidate of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('找不到 Chrome 或 Edge，无法运行真实 WASM 评测')
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(500)
  }
  throw new Error(`等待超时：${label}${lastError ? ` · ${lastError}` : ''}`)
}

async function startVite() {
  const vite = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  vite.stdout.on('data', (chunk) => { log += chunk.toString() })
  vite.stderr.on('data', (chunk) => { log += chunk.toString() })
  try {
    await waitFor(
      async () => (await fetch(HARNESS)).ok,
      'Vite dev server',
      60_000,
    )
  } catch (error) {
    vite.kill()
    throw new Error(`${error.message}\n${log.slice(-2000)}`)
  }
  return vite
}

async function startChrome(profile) {
  const chrome = spawn(
    chromePath(),
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const portFile = join(profile, 'DevToolsActivePort')
  await waitFor(() => existsSync(portFile), 'Chrome DevTools 端口文件', 30_000)
  const port = Number((await readFile(portFile, 'utf8')).split(/\r?\n/)[0])
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
    'Chrome CDP',
    30_000,
  )
  return { chrome, port }
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) {
        this.events.push(message)
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', fail, { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolvePending, reject) => {
      this.pending.set(id, { resolve: resolvePending, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed')
    }
    return result.result.value
  }

  close() {
    try { this.socket.close() } catch { /* already closed */ }
  }
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return
  await new Promise((done) => {
    const killer = spawn(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore' },
    )
    killer.on('exit', () => done())
    killer.on('error', () => {
      child.kill()
      done()
    })
  })
}

async function waitForExpression(cdp, expression, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression).catch(() => false)
    if (value) return value
    await sleep(1000)
  }
  throw new Error(`等待超时：${label}`)
}

/** End-to-end app smoke: open the sample book with 山岚 and start playback. */
async function smoke(cdp) {
  await cdp.send('Log.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      `try { localStorage.setItem('shusheng.settings.v1', JSON.stringify({` +
      `engine:'sherpa', aiVoiceId:'shanlan', groupSentences:true,` +
      `labSilenceScale:1, pausePreset:'standard', rate:1})) } catch (e) {}`,
  })
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?lab=1` })

  await waitForExpression(
    cdp,
    `Boolean(Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('试听样书')))`,
    '书架页',
    60_000,
  )
  await cdp.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('试听样书')).click()`,
  )
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.play-btn:not([disabled])'))`,
    '阅读器可播放',
    180_000,
  )

  // Download the real 山岚 pack through the app UI so playback uses the WASM
  // engine rather than the system-voice fallback.
  await cdp.evaluate(
    `document.querySelector('[aria-label="阅读设置"]')?.click()`,
  )
  await waitForExpression(
    cdp,
    `Boolean(Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('下载 山岚')))`,
    '音色库下载按钮',
    30_000,
  )
  await cdp.evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('下载 山岚')).click()`,
  )
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.pack-state[data-phase="ready"]'))`,
    '山岚音色包下载完成',
    300_000,
  )
  await cdp.evaluate(`document.querySelector('.play-btn').click()`)
  await sleep(15_000)
  const state = await cdp.evaluate(`(() => {
    const play = document.querySelector('.play-btn')
    const iframes = Array.from(document.querySelectorAll('iframe'))
    let highlighted = 0
    for (const frame of iframes) {
      try { highlighted += frame.contentDocument.querySelectorAll('.tts-active').length } catch {}
    }
    return {
      label: play ? play.getAttribute('aria-label') : null,
      ready: play ? !play.disabled : false,
      highlighted,
      units: document.querySelectorAll('[data-sid]').length,
      bodyText: document.body.innerText.slice(0, 900),
    }
  })()`)
  const errors = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params?.exceptionDetails?.text ?? 'unknown')
  console.log(JSON.stringify({ smoke: state, pageErrors: errors }, null, 2))
  if (errors.length) throw new Error(`页面出现 ${errors.length} 个未捕获异常`)
  if (state.label !== '暂停朗读') {
    throw new Error(`播放状态异常：${state.label}`)
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const profile = join(tmpdir(), `shusheng-ab-${Date.now()}`)
  const vite = await startVite()
  let chrome
  let cdp
  try {
    const started = await startChrome(profile)
    chrome = started.chrome
    const targets = await (
      await fetch(`http://127.0.0.1:${started.port}/json/list`)
    ).json()
    const page = targets.find((item) => item.type === 'page')
    if (!page) throw new Error('Chrome 没有可用的页面 target')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    if (process.argv.includes('--smoke')) {
      await smoke(cdp)
      return
    }
    await cdp.send('Page.navigate', { url: HARNESS })

    const deadline = Date.now() + TOTAL_TIMEOUT_MS
    let done = false
    while (Date.now() < deadline) {
      const state = await cdp.evaluate(
        'Boolean(window.__abDone || window.__abError)',
      ).catch(() => false)
      if (state) { done = true; break }
      await sleep(2000)
    }
    if (!done) throw new Error('A/B 评测超时（10 分钟）')

    const error = await cdp.evaluate('window.__abError || null')
    const results = await cdp.evaluate('window.__abResults || null')
    if (error) throw new Error(`浏览器内评测失败：${error}`)
    if (!results) throw new Error('浏览器没有产出评测结果')

    await writeFile(OUT_FILE, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
    console.log(`结果已写入 ${OUT_FILE}`)
    const stats = spawn(process.execPath, ['scripts/ab-stats.mjs'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    await new Promise((done) => stats.on('exit', done))
    if (stats.exitCode !== 0) throw new Error('A/B 统计分析失败')
    for (const [key, value] of Object.entries(results)) {
      if (key === 'grid' || key === 'samples' || key === 'synthesisAfterRelease') {
        continue
      }
      console.log(`${key}: ${JSON.stringify(value)}`)
    }
    console.log(`synthesisAfterRelease: ${results.synthesisAfterRelease}`)
  } finally {
    cdp?.close()
    await killTree(chrome)
    vite.kill()
    // Chrome can hold a lock on its profile for a moment after taskkill.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(500)
      try {
        await rm(profile, { recursive: true, force: true })
        break
      } catch {
        // Retry until the lock is released.
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
