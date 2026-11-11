import { encodeWavBlob } from '@/core/tts/wav'

export const PROBE_CLIP_SECONDS = 12
const SAMPLE_RATE = 22_050
const PROBE_INTERVAL_MS = 250
const WORK_REQUEST_DELAY_MS = 6_000
const LATE_MARKER_MS = 30_000
const AUTO_FINISH_MS = 46_000
const VISIBLE_DRAIN_MS = 1_200
const AUTO_FINALIZE_MS = 8_000
const MIN_SESSION_MS = 15_000
const RESUME_GRACE_MS = 1_500

export type ProbeClip = 'A' | 'B'
export type ProbePhase = 'idle' | 'running' | 'finished'
export type ProbeJobState = 'idle' | 'running' | 'done' | 'failed'

export interface ProbeEventLog {
  elapsed: number
  wall: number
  name: string
  detail?: string
}

export interface ProbeSession {
  startWall: number
  endWall: number
  durationMs: number
  clipAtHide: ProbeClip | null
  timeAtHide: number
  clipAtShow: ProbeClip | null
  timeAtShow: number
  timerTicks: number
  timerMaxGapMs: number | null
  workerTicks: number
  workerMaxGapMs: number | null
  workerJobDoneWall: number | null
}

export type ProbeVerdictCode =
  | 'ok'
  | 'media-stopped'
  | 'js-frozen'
  | 'chain-blocked'
  | 'worker-frozen'
  | 'incomplete'
  | 'unsupported'

export interface ProbeVerdict {
  code: ProbeVerdictCode
  title: string
  detail: string
}

export interface ProbeEvidence {
  audioSupported: boolean
  workerSupported: boolean
  aStartedWall: number
  aEndedWall: number | null
  bRequestWall: number | null
  bRequestHidden: boolean | null
  bPlayRejectedWall: number | null
  bEndedWall: number | null
  jobRequestedWall: number | null
  jobDoneWall: number | null
  sessions: ProbeSession[]
}

export interface ProbeResult {
  verdict: ProbeVerdict
  evidence: ProbeEvidence
  session: ProbeSession | null
  events: ProbeEventLog[]
  report: string
}

export interface ProbeSnapshot {
  phase: ProbePhase
  elapsedMs: number
  clip: ProbeClip | null
  audioTime: number
  audioDuration: number
  hidden: boolean
  hiddenMs: number
  timerTicks: number
  workerTicks: number
  workerJob: ProbeJobState
  events: ProbeEventLog[]
  result: ProbeResult | null
  error: string | null
}

interface OpenSession {
  startWall: number
  clipAtHide: ProbeClip | null
  timeAtHide: number
}

const PROBE_WORKER_SOURCE = `
'use strict'
let interval = null
let tick = 0

self.onmessage = (event) => {
  const data = event.data || {}
  if (data.type === 'start') {
    if (interval !== null) return
    interval = setInterval(() => {
      tick += 1
      self.postMessage({ type: 'tick', at: Date.now() })
    }, 250)
    self.postMessage({ type: 'ready', at: Date.now() })
    return
  }
  if (data.type === 'work') {
    const id = data.id
    // One synchronous block mirrors a real TTS generate() call. Chunking with
    // setTimeout would be throttled to ~1s in the background and look frozen.
    const startedAt = performance.now()
    let acc = 0
    while (performance.now() - startedAt < 1000) {
      for (let i = 0; i < 4000; i += 1) acc += Math.sin(i)
    }
    self.postMessage({ type: 'work-done', id, at: Date.now(), value: acc > 0 })
    return
  }
  if (data.type === 'stop') {
    if (interval !== null) clearInterval(interval)
    self.close()
  }
}
`

function inWindow(value: number | null, session: ProbeSession): boolean {
  if (value === null) return false
  return (
    value >= session.startWall && value <= session.endWall + RESUME_GRACE_MS
  )
}

function maxGap(times: number[]): number | null {
  if (times.length < 2) return null
  let max = 0
  for (let i = 1; i < times.length; i += 1) {
    max = Math.max(max, times[i] - times[i - 1])
  }
  return max
}

export function pickProbeSession(
  sessions: ProbeSession[],
  aEndedWall: number | null,
): ProbeSession | null {
  if (!sessions.length) return null
  if (aEndedWall !== null) {
    const chain = sessions.find(
      (session) =>
        aEndedWall >= session.startWall &&
        aEndedWall <= session.endWall + RESUME_GRACE_MS,
    )
    if (chain) return chain
  }
  return sessions.reduce((best, session) =>
    session.durationMs > best.durationMs ? session : best,
  )
}

/**
 * Turns the recorded runs into a verdict. The audio element, the main thread
 * and the worker are judged separately: the media pipeline can keep playing
 * while the page is frozen, and the worker can stop while both still run.
 */
export function analyzeProbeEvidence(evidence: ProbeEvidence): ProbeVerdict {
  if (!evidence.audioSupported) {
    return {
      code: 'unsupported',
      title: '无法测试',
      detail: '当前浏览器不支持音频元素，无法进行锁屏自检。',
    }
  }

  const session = pickProbeSession(evidence.sessions, evidence.aEndedWall)
  if (!session) {
    return {
      code: 'incomplete',
      title: '没有记录到锁屏',
      detail: '请重新开始，看到提示后立刻按电源键锁屏，约 30 秒后再解锁。',
    }
  }
  if (session.durationMs < MIN_SESSION_MS) {
    return {
      code: 'incomplete',
      title: '锁屏时间太短',
      detail: `这次只锁屏了 ${(session.durationMs / 1000).toFixed(1)} 秒，至少需要 15 秒。请重新测试。`,
    }
  }

  const aEndedDuring = inWindow(evidence.aEndedWall, session)
  const audioAlive =
    (session.clipAtHide === 'A' &&
      (aEndedDuring ||
        session.clipAtShow === 'B' ||
        (session.clipAtShow === 'A' &&
          session.timeAtShow > session.timeAtHide + 0.3))) ||
    (session.clipAtHide === 'B' &&
      (inWindow(evidence.bEndedWall, session) ||
        (session.clipAtShow === 'B' &&
          session.timeAtShow > session.timeAtHide + 0.3)))

  if (!audioAlive) {
    return {
      code: 'media-stopped',
      title: '媒体元素也被停止',
      detail:
        '锁屏后音频本身没有继续推进。两条纯前端路线都需要媒体元素存活，请再确认一次是否是主屏幕 PWA；若结果相同，需要原生外壳才能稳定锁屏朗读。',
    }
  }

  if (!aEndedDuring) {
    const aReachedEnd =
      session.clipAtShow === 'A' &&
      session.timeAtShow >= PROBE_CLIP_SECONDS - 0.4
    if (aReachedEnd) {
      return {
        code: 'js-frozen',
        title: '页面被冻结，媒体仍在播放',
        detail:
          'A 段已经播到结尾，但锁屏期间没有执行结束事件。主线程停住了，纯前端链式播放不可行，需要预合成更长的音频块或原生外壳。',
      }
    }
    return {
      code: 'incomplete',
      title: 'A 段还没播完',
      detail:
        '解锁太早，A 段没有在锁屏期间结束，无法验证续播。请重新测试，锁屏后等待约 30 秒。',
    }
  }

  const aEndDelay = evidence.aEndedWall! - evidence.aStartedWall
  if (aEndDelay > PROBE_CLIP_SECONDS * 1000 + 3_000) {
    return {
      code: 'js-frozen',
      title: '页面被冻结，媒体仍在播放',
      detail:
        'A 段其实播完了，但主线程直到解锁后才处理结束事件。锁屏期间没有 JS 能接上下一段，纯前端链式播放不可行，需要预合成更长的音频块或原生外壳。',
    }
  }

  if (evidence.bRequestWall === null) {
    return {
      code: 'js-frozen',
      title: '页面被冻结，媒体仍在播放',
      detail:
        'A 段结束后，锁屏期间没有发起 B 段。主线程在后台停住了，需要预合成更长的音频块或原生外壳。',
    }
  }
  if (!inWindow(evidence.bRequestWall, session)) {
    if (evidence.bRequestWall > session.endWall + RESUME_GRACE_MS) {
      return {
        code: 'incomplete',
        title: '未测到后台续播',
        detail:
          'B 段是在解锁之后才开始的，这次没有覆盖到锁屏中的切换。请重新测试，锁屏后等待约 30 秒。',
      }
    }
    return {
      code: 'incomplete',
      title: '未测到后台续播',
      detail:
        'B 段在锁屏前就已经开始，无法判断锁屏后能否续播。请重新测试，并在开始后 3 秒内锁屏。',
    }
  }
  if (evidence.bRequestHidden !== true) {
    return {
      code: 'js-frozen',
      title: '页面被冻结，媒体仍在播放',
      detail:
        '主线程直到解锁后才处理 A 段的结束事件，锁屏期间的链式播放没有发生。需要长音频块或原生外壳。',
    }
  }
  if (evidence.bPlayRejectedWall !== null) {
    return {
      code: 'chain-blocked',
      title: '后台起播被拒绝',
      detail:
        '锁屏后调用 play() 被系统拒绝。媒体元素还活着，但不允许在后台换源起播；可以尝试预建多个媒体元素或改为长音频块。',
    }
  }

  const bProgressed =
    inWindow(evidence.bEndedWall, session) ||
    (session.clipAtShow === 'B' && session.timeAtShow >= 0.5)
  if (!bProgressed) {
    return {
      code: 'chain-blocked',
      title: '后台起播没有出声',
      detail:
        '锁屏后已经调用 play()，但 B 段没有真正推进。iOS 接受了调用却没有输出音频，需要预建媒体元素或改用长音频块。',
    }
  }

  if (!evidence.workerSupported) {
    return {
      code: 'incomplete',
      title: 'Worker 不可用',
      detail:
        '主线程和媒体都通过了，但当前浏览器无法创建 Worker，无法判断离线合成的后台表现。',
    }
  }

  const workerOk =
    session.workerTicks >= 2 &&
    (session.workerMaxGapMs === null || session.workerMaxGapMs <= 5_000)
  if (!workerOk) {
    return {
      code: 'worker-frozen',
      title: '主线程续播正常，Worker 被冻结',
      detail:
        '媒体和主线程都撑过了锁屏，但 Worker 在后台停止响应。离线合成无法在锁屏期间产出下一段，需要提前预合成更长的音频块。',
    }
  }

  if (
    inWindow(evidence.jobRequestedWall, session) &&
    session.workerJobDoneWall === null
  ) {
    return {
      code: 'worker-frozen',
      title: 'Worker 无法完成后台任务',
      detail:
        'Worker 的心跳还在，但锁屏期间发起的合成模拟没有完成。真实合成更容易被系统打断，需要提前预合成。',
    }
  }

  return {
    code: 'ok',
    title: '全链路通过',
    detail:
      '锁屏后媒体继续播放，主线程接上了下一段，Worker 也在后台保持响应。可以按事件驱动重写播放链，不需要长音频块。',
  }
}

function formatDateTime(wall: number): string {
  const date = new Date(wall)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function formatGap(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`
}

function detectMode(): string {
  try {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    return standalone ? '主屏幕 PWA' : '浏览器标签页'
  } catch {
    return '浏览器'
  }
}

function buildProbeReport(
  verdict: ProbeVerdict,
  evidence: ProbeEvidence,
  session: ProbeSession | null,
  events: ProbeEventLog[],
  context: { startedWall: number; buildId: string },
): string {
  const lines: string[] = [
    '书声 · 锁屏自检',
    `时间: ${formatDateTime(context.startedWall)}`,
    `模式: ${detectMode()}`,
  ]
  if (context.buildId) lines.push(`构建: ${context.buildId}`)
  lines.push(`设备: ${navigator.userAgent}`)
  lines.push(`结论: ${verdict.title}`)
  lines.push(`说明: ${verdict.detail}`)

  if (session) {
    const aEndedDuring = inWindow(evidence.aEndedWall, session)
    const aState = aEndedDuring
      ? '已播完'
      : session.clipAtShow === 'A'
        ? `${session.timeAtShow.toFixed(1)} s`
        : '已切到 B'
    lines.push(`锁屏时长: ${formatSeconds(session.durationMs)}`)
    lines.push(
      `A 段: 锁屏时 ${session.timeAtHide.toFixed(1)} s → 解锁时 ${aState}`,
    )

    if (evidence.bRequestWall !== null) {
      const delay = (evidence.bRequestWall - session.startWall) / 1000
      const bState = inWindow(evidence.bEndedWall, session)
        ? '已播完'
        : session.clipAtShow === 'B'
          ? `${session.timeAtShow.toFixed(1)} s`
          : '未出声'
      const resolved =
        evidence.bPlayRejectedWall !== null
          ? 'play() 被拒绝'
          : 'play() 已调用'
      lines.push(
        `B 段: 锁屏后 ${delay.toFixed(1)} s 起播 · ${resolved} · 解锁时 ${bState}`,
      )
    } else {
      lines.push('B 段: 锁屏期间没有起播')
    }

    lines.push(
      `主线程计时器: 后台执行 ${session.timerTicks} 次 · 最大间隔 ${formatGap(
        session.timerMaxGapMs,
      )}`,
    )
    lines.push(
      `Worker: 后台 tick ${session.workerTicks} 次 · 最大间隔 ${formatGap(
        session.workerMaxGapMs,
      )}`,
    )
    lines.push(
      `合成模拟: ${
        session.workerJobDoneWall !== null
          ? '锁屏期间完成'
          : evidence.jobRequestedWall !== null
            ? '未在锁屏期间完成'
            : '未在锁屏期间发起'
      }`,
    )
  }

  lines.push('', '事件:')
  for (const event of events) {
    const detail = event.detail ? ` · ${event.detail}` : ''
    lines.push(`+${(event.elapsed / 1000).toFixed(1)}s ${event.name}${detail}`)
  }
  return lines.join('\n')
}

function clipTone(label: ProbeClip): Float32Array {
  const tickHz = label === 'A' ? 880 : 1_320
  const padHz = label === 'A' ? 196 : 220
  const total = Math.round(PROBE_CLIP_SECONDS * SAMPLE_RATE)
  const samples = new Float32Array(total)
  const fade = Math.round(SAMPLE_RATE * 0.04)

  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE
    const pad =
      0.04 * Math.sin(2 * Math.PI * padHz * t) +
      0.022 * Math.sin(2 * Math.PI * padHz * 1.5 * t + 0.6)
    const beat = t % 1
    let tick = 0
    if (beat < 0.07) {
      const envelope = Math.sin((Math.PI * beat) / 0.07)
      tick = 0.18 * envelope * Math.sin(2 * Math.PI * tickHz * t)
    }
    let value = pad + tick
    if (i < fade) value *= i / fade
    const tail = total - 1 - i
    if (tail < fade) value *= tail / fade
    samples[i] = value
  }
  return samples
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function describeMediaError(element: HTMLAudioElement): string {
  const error = element.error
  if (!error) return '未知错误'
  const labels: Record<number, string> = {
    1: '中止',
    2: '网络',
    3: '解码',
    4: '不支持',
  }
  const label = labels[error.code] ?? '错误'
  return `${label} (${error.code})${error.message ? ` · ${error.message}` : ''}`
}

function emptyEvidence(): ProbeEvidence {
  return {
    audioSupported: false,
    workerSupported: false,
    aStartedWall: 0,
    aEndedWall: null,
    bRequestWall: null,
    bRequestHidden: null,
    bPlayRejectedWall: null,
    bEndedWall: null,
    jobRequestedWall: null,
    jobDoneWall: null,
    sessions: [],
  }
}

export class LockScreenProbe {
  private phase: ProbePhase = 'idle'
  private element: HTMLAudioElement | null = null
  private readonly audioSupported =
    typeof Audio !== 'undefined' && typeof Blob !== 'undefined'
  private workerSupported = typeof Worker !== 'undefined'
  private urlA: string | null = null
  private urlB: string | null = null
  private worker: Worker | null = null
  private workerUrl: string | null = null
  private intervalTimer: number | null = null
  private workTimer: number | null = null
  private lateTimer: number | null = null
  private autoFinishTimer: number | null = null
  private drainTimer: number | null = null

  private readonly listeners = new Set<() => void>()
  private events: ProbeEventLog[] = []
  private sessions: ProbeSession[] = []
  private openSession: OpenSession | null = null

  private startedWall = 0
  private clip: ProbeClip | null = null
  private audioTime = 0
  private audioDuration = 0
  private hidden = false
  private hiddenStartWall = 0

  private aStartedWall = 0
  private aEndedWall: number | null = null
  private bRequestWall: number | null = null
  private bRequestHidden: boolean | null = null
  private bPlayRejectedWall: number | null = null
  private bEndedWall: number | null = null
  private jobRequestedWall: number | null = null
  private jobDoneWall: number | null = null
  private workerJob: ProbeJobState = 'idle'

  private timerTickCount = 0
  private workerTickCount = 0
  private timerTicks: Array<{ wall: number; hidden: boolean }> = []
  private workerTickTimes: number[] = []

  private result: ProbeResult | null = null
  private error: string | null = null
  private buildId = ''

  private mediaSessionSaved = false
  private savedMetadata: MediaMetadata | null = null
  private savedPlaybackState: 'none' | 'paused' | 'playing' = 'none'

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility)
      window.addEventListener('pagehide', this.handlePageHide)
      window.addEventListener('pageshow', this.handlePageShow)
    }
  }

  getSnapshot(): ProbeSnapshot {
    return {
      phase: this.phase,
      elapsedMs: this.startedWall
        ? Math.max(0, Date.now() - this.startedWall)
        : 0,
      clip: this.clip,
      audioTime: this.audioTime,
      audioDuration: this.audioDuration,
      hidden: this.hidden,
      hiddenMs: this.hidden
        ? Math.max(0, Date.now() - this.hiddenStartWall)
        : 0,
      timerTicks: this.timerTickCount,
      workerTicks: this.workerTickCount,
      workerJob: this.workerJob,
      events: this.events.slice(-12),
      result: this.result,
      error: this.error,
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setBuildId(buildId: string): void {
    this.buildId = buildId
  }

  buildReport(): string {
    return this.result?.report ?? ''
  }

  start(): void {
    if (this.phase === 'running') return

    this.teardown()
    this.resetState()

    if (!this.audioSupported) {
      this.phase = 'finished'
      const verdict: ProbeVerdict = {
        code: 'unsupported',
        title: '无法测试',
        detail: '当前浏览器不支持音频元素，无法进行锁屏自检。',
      }
      this.result = {
        verdict,
        evidence: emptyEvidence(),
        session: null,
        events: [],
        report: `书声 · 锁屏自检\n结论: ${verdict.title}\n说明: ${verdict.detail}`,
      }
      this.notify()
      return
    }

    const element = this.ensureElement()
    if (!element) {
      this.phase = 'finished'
      this.error = '无法创建测试音频元素。'
      this.notify()
      return
    }

    this.phase = 'running'
    this.startedWall = Date.now()
    this.audioDuration = PROBE_CLIP_SECONDS
    this.saveMediaSession()
    this.log('probe:start', `A ${PROBE_CLIP_SECONDS}s → B ${PROBE_CLIP_SECONDS}s`)

    try {
      this.urlA = URL.createObjectURL(
        encodeWavBlob(clipTone('A'), SAMPLE_RATE),
      )
      this.urlB = URL.createObjectURL(
        encodeWavBlob(clipTone('B'), SAMPLE_RATE),
      )
    } catch (error) {
      this.error = '测试音频生成失败。'
      this.log('probe:error', errorMessage(error))
      this.finalize('error')
      return
    }

    this.startWorker()
    this.startTimers()
    this.setMediaSession('A')
    this.playClip('A', this.urlA)
    this.notify()
  }

  finishNow(): void {
    if (this.phase === 'running') this.finalize('manual')
  }

  private handlePageHide = (): void => {
    if (this.phase !== 'running') return
    this.log('page:hide', `visibility=${document.visibilityState}`)
  }

  private handlePageShow = (): void => {
    if (this.phase !== 'running') return
    this.log('page:show', `visibility=${document.visibilityState}`)
  }

  private handleVisibility = (): void => {
    if (this.phase !== 'running') return

    if (document.visibilityState === 'hidden') {
      this.clearDrainTimer()
      if (this.hidden) return
      this.hidden = true
      this.hiddenStartWall = Date.now()
      this.refreshAudioTime()
      this.openSession = {
        startWall: this.hiddenStartWall,
        clipAtHide: this.clip,
        timeAtHide: this.audioTime,
      }
      this.log(
        'visibility:hidden',
        `${this.clip ?? '—'} @ ${this.audioTime.toFixed(1)}s`,
      )
      return
    }

    if (!this.hidden || !this.openSession) return
    this.hidden = false
    this.refreshAudioTime()
    const session = this.closeSession(Date.now())
    this.log(
      'visibility:visible',
      session
        ? `${formatSeconds(session.durationMs)} · ${session.clipAtShow ?? '—'} @ ${session.timeAtShow.toFixed(1)}s`
        : '没有完整时段',
    )
    this.notify()

    if (session && session.durationMs >= AUTO_FINALIZE_MS) {
      // Queued worker messages and media events arrive right after resume.
      this.clearDrainTimer()
      this.drainTimer = window.setTimeout(() => {
        this.drainTimer = null
        if (this.phase !== 'running' || this.hidden) return
        this.finalize('visible')
      }, VISIBLE_DRAIN_MS)
    }
  }

  private refreshAudioTime(): void {
    const element = this.element
    if (!element) return
    if (Number.isFinite(element.currentTime)) {
      this.audioTime = element.currentTime
    }
    if (Number.isFinite(element.duration) && element.duration > 0) {
      this.audioDuration = element.duration
    }
  }

  private closeSession(endWall: number): ProbeSession | null {
    const open = this.openSession
    this.openSession = null
    if (!open) return null

    const workerTicks = this.workerTickTimes.filter(
      (at) => at >= open.startWall && at <= endWall,
    )
    const timerTicks = this.timerTicks.filter(
      (tick) => tick.hidden && tick.wall >= open.startWall && tick.wall <= endWall,
    )
    const jobDoneWall =
      this.jobDoneWall !== null &&
      this.jobDoneWall >= open.startWall &&
      this.jobDoneWall <= endWall - 1_000
        ? this.jobDoneWall
        : null

    const session: ProbeSession = {
      startWall: open.startWall,
      endWall,
      durationMs: endWall - open.startWall,
      clipAtHide: open.clipAtHide,
      timeAtHide: open.timeAtHide,
      clipAtShow: this.clip,
      timeAtShow: this.audioTime,
      timerTicks: timerTicks.length,
      timerMaxGapMs: maxGap(timerTicks.map((tick) => tick.wall)),
      workerTicks: workerTicks.length,
      workerMaxGapMs: maxGap(workerTicks),
      workerJobDoneWall: jobDoneWall,
    }
    this.sessions.push(session)
    return session
  }

  private playClip(label: ProbeClip, url: string | null): void {
    const element = this.element
    if (!element || !url) return

    this.clip = label
    this.audioTime = 0
    element.src = url

    if (label === 'A') {
      this.aStartedWall = Date.now()
    } else {
      this.bRequestWall = Date.now()
      this.bRequestHidden = document.visibilityState === 'hidden'
    }

    this.log(
      `audio:${label}:request`,
      `visibility=${document.visibilityState}`,
    )
    this.setMediaSession(label)

    try {
      const started = element.play() as Promise<void> | undefined
      if (started && typeof started.then === 'function') {
        started
          .then(() => {
            this.log(`audio:${label}:play-resolved`, 'play() 已兑现')
            this.notify()
          })
          .catch((error: unknown) => {
            const wall = Date.now()
            this.log(`audio:${label}:blocked`, errorMessage(error))
            if (label === 'B') {
              this.bPlayRejectedWall = wall
            } else if (this.phase === 'running') {
              this.error = '测试音频无法播放，请确认媒体音量后重试。'
              this.finalize('audio-error')
            }
            this.notify()
          })
      }
    } catch (error) {
      this.log(`audio:${label}:blocked`, errorMessage(error))
      if (label === 'B') {
        this.bPlayRejectedWall = Date.now()
      } else if (this.phase === 'running') {
        this.error = '测试音频无法播放，请确认媒体音量后重试。'
        this.finalize('audio-error')
      }
    }
  }

  private handleAudioEnded = (): void => {
    if (this.phase !== 'running' || !this.clip) return
    const label = this.clip
    this.refreshAudioTime()
    const wall = Date.now()

    if (label === 'A') {
      this.aEndedWall = wall
      this.log('audio:A:ended', `visibility=${document.visibilityState}`)
      this.playClip('B', this.urlB)
      this.notify()
      return
    }

    this.bEndedWall = wall
    this.log('audio:B:ended', `visibility=${document.visibilityState}`)
    this.notify()
  }

  private handleAudioEvent = (name: string): void => {
    if (this.phase !== 'running' || !this.clip) return
    this.refreshAudioTime()
    this.log(`audio:${this.clip}:${name}`, `${this.audioTime.toFixed(1)}s`)
  }

  private handleAudioError = (): void => {
    if (this.phase !== 'running' || !this.element) return
    const message = describeMediaError(this.element)
    this.log('audio:error', message)
    this.error = `测试音频出错：${message}`
    this.finalize('audio-error')
  }

  private ensureElement(): HTMLAudioElement | null {
    if (this.element) return this.element
    if (!this.audioSupported || typeof document === 'undefined') return null

    const element = document.createElement('audio')
    element.preload = 'auto'
    element.setAttribute('playsinline', '')
    element.setAttribute('webkit-playsinline', '')
    element.setAttribute('aria-hidden', 'true')
    element.tabIndex = -1
    element.volume = 1
    element.muted = false
    element.style.cssText =
      'position:fixed;left:-2px;bottom:-2px;width:1px;height:1px;pointer-events:none;'
    element.addEventListener('timeupdate', () => {
      this.refreshAudioTime()
    })
    element.addEventListener('durationchange', () => {
      this.refreshAudioTime()
    })
    element.addEventListener('ended', this.handleAudioEnded)
    element.addEventListener('playing', () => this.handleAudioEvent('playing'))
    element.addEventListener('pause', () => this.handleAudioEvent('pause'))
    element.addEventListener('waiting', () => this.handleAudioEvent('waiting'))
    element.addEventListener('stalled', () => this.handleAudioEvent('stalled'))
    element.addEventListener('error', this.handleAudioError)

    try {
      document.body.appendChild(element)
    } catch {
      // A detached element still plays in current browsers.
    }
    this.element = element
    return element
  }

  private startWorker(): void {
    if (!this.workerSupported) return
    try {
      const blob = new Blob([PROBE_WORKER_SOURCE], {
        type: 'text/javascript',
      })
      this.workerUrl = URL.createObjectURL(blob)
      const worker = new Worker(this.workerUrl)
      worker.onmessage = (event: MessageEvent<unknown>) => {
        this.handleWorkerMessage(event.data)
      }
      worker.onerror = () => {
        this.workerJob = 'failed'
        this.log('worker:error', 'Worker 运行时出错')
      }
      this.worker = worker
      worker.postMessage({ type: 'start' })
    } catch (error) {
      this.workerSupported = false
      this.log('worker:unavailable', errorMessage(error))
    }
  }

  private handleWorkerMessage(raw: unknown): void {
    if (this.phase !== 'running') return
    if (!raw || typeof raw !== 'object') return
    const data = raw as {
      type?: unknown
      at?: unknown
    }

    if (data.type === 'ready') {
      this.log('worker:ready')
      return
    }
    if (data.type === 'tick') {
      const at =
        typeof data.at === 'number' && Number.isFinite(data.at)
          ? data.at
          : Date.now()
      this.workerTickCount += 1
      this.workerTickTimes.push(at)
      if (this.workerTickTimes.length > 600) {
        this.workerTickTimes.splice(0, this.workerTickTimes.length - 600)
      }
      return
    }
    if (data.type === 'work-done') {
      const at =
        typeof data.at === 'number' && Number.isFinite(data.at)
          ? data.at
          : Date.now()
      this.jobDoneWall = at
      this.workerJob = 'done'
      this.log(
        'worker:job-done',
        `visibility=${document.visibilityState}`,
        at,
      )
      this.notify()
    }
  }

  private requestWorkerJob(): void {
    if (!this.worker || this.phase !== 'running') return
    this.jobRequestedWall = Date.now()
    this.workerJob = 'running'
    this.log('worker:job-start', `visibility=${document.visibilityState}`)
    this.worker.postMessage({ type: 'work', id: 1 })
  }

  private startTimers(): void {
    this.intervalTimer = window.setInterval(
      () => this.handleTimerTick(),
      PROBE_INTERVAL_MS,
    )
    this.workTimer = window.setTimeout(
      () => this.requestWorkerJob(),
      WORK_REQUEST_DELAY_MS,
    )
    this.lateTimer = window.setTimeout(() => {
      this.refreshAudioTime()
      this.log(
        'timer:late-marker',
        `${this.clip ?? '—'} @ ${this.audioTime.toFixed(1)}s`,
      )
    }, LATE_MARKER_MS)
    this.autoFinishTimer = window.setTimeout(() => {
      if (this.phase === 'running') this.finalize('auto')
    }, AUTO_FINISH_MS)
  }

  private handleTimerTick(): void {
    if (this.phase !== 'running') return
    const wall = Date.now()
    this.timerTickCount += 1
    this.timerTicks.push({
      wall,
      hidden: document.visibilityState === 'hidden',
    })
    if (this.timerTicks.length > 800) {
      this.timerTicks.splice(0, this.timerTicks.length - 800)
    }
    this.refreshAudioTime()
    this.notify()
  }

  private finalize(reason: string): void {
    if (this.phase !== 'running') return
    this.phase = 'finished'
    this.refreshAudioTime()
    this.clearTimers()
    this.stopAudio()
    this.stopWorker()
    this.restoreMediaSession()

    const evidence = this.buildEvidence()
    const verdict = analyzeProbeEvidence(evidence)
    const session = pickProbeSession(evidence.sessions, evidence.aEndedWall)
    this.log('probe:finish', `${reason} · ${verdict.title}`)
    this.result = {
      verdict,
      evidence,
      session,
      events: this.events.slice(),
      report: buildProbeReport(verdict, evidence, session, this.events, {
        startedWall: this.startedWall,
        buildId: this.buildId,
      }),
    }
    this.notify()
  }

  private buildEvidence(): ProbeEvidence {
    return {
      audioSupported: this.audioSupported,
      workerSupported: this.workerSupported,
      aStartedWall: this.aStartedWall,
      aEndedWall: this.aEndedWall,
      bRequestWall: this.bRequestWall,
      bRequestHidden: this.bRequestHidden,
      bPlayRejectedWall: this.bPlayRejectedWall,
      bEndedWall: this.bEndedWall,
      jobRequestedWall: this.jobRequestedWall,
      jobDoneWall: this.jobDoneWall,
      sessions: this.sessions.slice(),
    }
  }

  private log(name: string, detail?: string, wallOverride?: number): void {
    const wall = wallOverride ?? Date.now()
    this.events.push({
      elapsed: Math.max(0, wall - this.startedWall),
      wall,
      name,
      detail,
    })
    if (this.events.length > 200) {
      this.events.splice(0, this.events.length - 200)
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the probe.
      }
    }
  }

  private saveMediaSession(): void {
    if (
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator)
    ) {
      return
    }
    try {
      this.savedMetadata = navigator.mediaSession.metadata
      this.savedPlaybackState = navigator.mediaSession.playbackState
      this.mediaSessionSaved = true
    } catch {
      this.mediaSessionSaved = false
    }
  }

  private setMediaSession(label: ProbeClip): void {
    if (
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator)
    ) {
      return
    }
    try {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: `锁屏自检 · ${label} 段`,
          artist: label === 'A' ? '书声 · 低音滴答' : '书声 · 高音滴答',
          album: '书声 · 锁屏自检',
        })
      }
      navigator.mediaSession.playbackState = 'playing'
    } catch {
      // Media Session is advisory; playback still works without it.
    }
  }

  private restoreMediaSession(): void {
    if (!this.mediaSessionSaved) return
    this.mediaSessionSaved = false
    try {
      navigator.mediaSession.metadata = this.savedMetadata
      navigator.mediaSession.playbackState = this.savedPlaybackState
    } catch {
      // Ignore a browser that no longer exposes the session.
    }
    this.savedMetadata = null
  }

  private stopAudio(): void {
    const element = this.element
    if (!element) return
    try {
      element.pause()
    } catch {
      // The element may already be torn down.
    }
  }

  private stopWorker(): void {
    const worker = this.worker
    this.worker = null
    if (worker) {
      try {
        worker.postMessage({ type: 'stop' })
      } catch {
        // Terminate below regardless.
      }
      worker.terminate()
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl)
      this.workerUrl = null
    }
  }

  private clearTimers(): void {
    if (this.intervalTimer !== null) {
      window.clearInterval(this.intervalTimer)
    }
    for (const timer of [
      this.workTimer,
      this.lateTimer,
      this.autoFinishTimer,
      this.drainTimer,
    ]) {
      if (timer !== null) window.clearTimeout(timer)
    }
    this.intervalTimer = null
    this.workTimer = null
    this.lateTimer = null
    this.autoFinishTimer = null
    this.drainTimer = null
  }

  private clearDrainTimer(): void {
    if (this.drainTimer === null) return
    window.clearTimeout(this.drainTimer)
    this.drainTimer = null
  }

  private revokeClips(): void {
    if (this.urlA) {
      URL.revokeObjectURL(this.urlA)
      this.urlA = null
    }
    if (this.urlB) {
      URL.revokeObjectURL(this.urlB)
      this.urlB = null
    }
  }

  private teardown(): void {
    this.clearTimers()
    this.stopAudio()
    this.stopWorker()
    this.revokeClips()
    this.restoreMediaSession()
  }

  private resetState(): void {
    this.phase = 'idle'
    this.events = []
    this.sessions = []
    this.openSession = null
    this.startedWall = 0
    this.clip = null
    this.audioTime = 0
    this.audioDuration = 0
    this.hidden = false
    this.hiddenStartWall = 0
    this.aStartedWall = 0
    this.aEndedWall = null
    this.bRequestWall = null
    this.bRequestHidden = null
    this.bPlayRejectedWall = null
    this.bEndedWall = null
    this.jobRequestedWall = null
    this.jobDoneWall = null
    this.workerJob = 'idle'
    this.timerTickCount = 0
    this.workerTickCount = 0
    this.timerTicks = []
    this.workerTickTimes = []
    this.result = null
    this.error = null
  }
}

export const lockScreenProbe = new LockScreenProbe()
