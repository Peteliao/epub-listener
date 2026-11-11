import type { TtsEngine } from '@/types'

export interface BookListening {
  title: string
  ms: number
  lastAt: number
}

interface ListeningStatsData {
  version: 1
  totalMs: number
  days: Record<string, number>
  books: Record<string, BookListening>
  firstAt: number | null
  updatedAt: number
}

export interface LastListenedBook {
  id: string
  title: string
  ms: number
}

export interface ListeningSnapshot {
  totalMs: number
  todayMs: number
  streakDays: number
  activeDays: number
  bookCount: number
  firstAt: number | null
  lastBook: LastListenedBook | null
}

export interface ListeningContext {
  bookId: string
  title: string
  playing: boolean
  engine: TtsEngine | null
}

const STORAGE_KEY = 'shusheng.listening.v1'
const HEARTBEAT_MS = 15_000
// Timers can be frozen for hours while the AI voice keeps playing behind the
// lock screen; cap a single frozen span so a stalled session cannot inflate
// the shared total.
const MAX_FROZEN_SPAN_MS = 6 * 60 * 60 * 1000

function emptyStats(): ListeningStatsData {
  return {
    version: 1,
    totalMs: 0,
    days: {},
    books: {},
    firstAt: null,
    updatedAt: 0,
  }
}

function finiteMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function sanitize(raw: unknown): ListeningStatsData {
  if (!raw || typeof raw !== 'object') return emptyStats()
  const source = raw as Record<string, unknown>
  const stats = emptyStats()

  stats.totalMs = finiteMs(source.totalMs)
  stats.firstAt =
    typeof source.firstAt === 'number' && Number.isFinite(source.firstAt)
      ? source.firstAt
      : null
  stats.updatedAt =
    typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt)
      ? source.updatedAt
      : 0

  if (source.days && typeof source.days === 'object') {
    for (const [day, ms] of Object.entries(source.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const value = finiteMs(ms)
      if (value > 0) stats.days[day] = value
    }
  }

  if (source.books && typeof source.books === 'object') {
    for (const [id, entry] of Object.entries(
      source.books as Record<string, unknown>,
    )) {
      if (!entry || typeof entry !== 'object') continue
      const book = entry as Record<string, unknown>
      const ms = finiteMs(book.ms)
      if (!id || ms <= 0) continue
      stats.books[id] = {
        title:
          typeof book.title === 'string' && book.title.trim()
            ? book.title.trim()
            : '未命名书籍',
        ms,
        lastAt:
          typeof book.lastAt === 'number' && Number.isFinite(book.lastAt)
            ? book.lastAt
            : 0,
      }
    }
  }

  if (!stats.totalMs) {
    stats.totalMs = Object.values(stats.days).reduce((sum, ms) => sum + ms, 0)
  }

  return stats
}

function loadStats(): ListeningStatsData {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : emptyStats()
  } catch {
    return emptyStats()
  }
}

function saveStats(stats: ListeningStatsData): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats))
  } catch {
    // Private browsing or a full quota must never break playback.
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function dayKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function nextMidnight(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  ).getTime()
}

function shiftDayKey(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year ?? 2000, (month ?? 1) - 1, (day ?? 1) + delta, 12)
  return dayKey(date.getTime())
}

export function recordListeningSpan(
  bookId: string,
  title: string,
  from: number,
  to: number,
): void {
  if (!bookId || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return
  }

  const stats = loadStats()
  let cursor = from
  while (cursor < to) {
    const boundary = Math.min(to, nextMidnight(cursor))
    const ms = boundary - cursor
    if (ms > 0) {
      const key = dayKey(cursor)
      stats.days[key] = (stats.days[key] ?? 0) + ms
      stats.totalMs += ms
    }
    cursor = boundary
  }

  const previous = stats.books[bookId]
  stats.books[bookId] = {
    title: title.trim() || previous?.title || '未命名书籍',
    ms: (previous?.ms ?? 0) + (to - from),
    lastAt: to,
  }
  stats.firstAt =
    stats.firstAt === null ? from : Math.min(stats.firstAt, from)
  stats.updatedAt = to
  saveStats(stats)
}

function hasListening(stats: ListeningStatsData, key: string): boolean {
  return (stats.days[key] ?? 0) > 0
}

function streakAt(stats: ListeningStatsData, now: number): number {
  let key = dayKey(now)
  if (!hasListening(stats, key)) key = shiftDayKey(key, -1)
  let days = 0
  while (hasListening(stats, key)) {
    days += 1
    key = shiftDayKey(key, -1)
  }
  return days
}

export function getListeningSnapshot(now = Date.now()): ListeningSnapshot {
  const stats = loadStats()
  const todayKey = dayKey(now)

  let lastBook: LastListenedBook | null = null
  let latestAt = -1
  for (const [id, book] of Object.entries(stats.books)) {
    if (book.lastAt <= latestAt) continue
    latestAt = book.lastAt
    lastBook = { id, title: book.title, ms: book.ms }
  }

  return {
    totalMs: stats.totalMs,
    todayMs: stats.days[todayKey] ?? 0,
    streakDays: streakAt(stats, now),
    activeDays: Object.values(stats.days).filter((ms) => ms > 0).length,
    bookCount: Object.keys(stats.books).length,
    firstAt: stats.firstAt,
    lastBook,
  }
}

export function formatListenDuration(ms: number, compact = false): string {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  if (safe < 60_000) return safe > 0 ? '不到 1 分钟' : '0 分钟'
  let hours = Math.floor(safe / 3_600_000)
  let minutes = Math.round((safe % 3_600_000) / 60_000)
  if (minutes === 60) {
    hours += 1
    minutes = 0
  }
  if (hours > 0) {
    if (!minutes) return `${hours} 小时`
    return compact ? `${hours} 小时 ${minutes} 分` : `${hours} 小时 ${minutes} 分钟`
  }
  return `${minutes} 分钟`
}

export function splitListenDuration(ms: number): { value: string; unit: string } {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  if (safe < 3_600_000) {
    const minutes = safe > 0 ? Math.max(1, Math.floor(safe / 60_000)) : 0
    return { value: String(minutes), unit: '分钟' }
  }
  return { value: String(Math.floor(safe / 3_600_000)), unit: '小时' }
}

function countsNow(context: ListeningContext | null): boolean {
  if (!context?.playing || !context.bookId) return false
  if (typeof document === 'undefined') return false
  if (document.visibilityState !== 'hidden') return true
  // System speech stops when the page is backgrounded; the offline AI voice
  // keeps playing through the media element, so only that engine counts.
  return context.engine === 'sherpa'
}

let context: ListeningContext | null = null
let segmentStartedAt: number | null = null
let listening = false
let heartbeat: number | null = null
let listenersAttached = false

function flushSegment(now = Date.now(), stop = false): void {
  if (!listening || segmentStartedAt === null || !context) {
    if (stop) segmentStartedAt = null
    return
  }
  const from = Math.max(segmentStartedAt, now - MAX_FROZEN_SPAN_MS)
  if (now - from >= 1_000) {
    recordListeningSpan(context.bookId, context.title, from, now)
  }
  segmentStartedAt = stop ? null : now
}

function startHeartbeat(): void {
  if (heartbeat !== null) return
  heartbeat = window.setInterval(() => flushSegment(), HEARTBEAT_MS)
}

function stopHeartbeat(): void {
  if (heartbeat === null) return
  window.clearInterval(heartbeat)
  heartbeat = null
}

function reconcile(): void {
  const shouldCount = countsNow(context)
  if (shouldCount) {
    if (!listening) {
      listening = true
      segmentStartedAt = Date.now()
    }
    startHeartbeat()
  } else {
    if (listening) {
      flushSegment(Date.now(), true)
      listening = false
    }
    stopHeartbeat()
  }
}

function handleVisibility(): void {
  // Persist the span up to the moment the page is hidden even when AI keeps
  // playing; a later kill can then only lose time inside the frozen window.
  if (listening) flushSegment()
  reconcile()
}

function handlePageHide(): void {
  if (listening) flushSegment(Date.now(), true)
  listening = false
  stopHeartbeat()
}

function handlePageShow(): void {
  reconcile()
}

function attachListeners(): void {
  if (listenersAttached || typeof document === 'undefined') return
  listenersAttached = true
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('pageshow', handlePageShow)
}

export function updateListeningContext(next: ListeningContext | null): void {
  attachListeners()
  context = next
  reconcile()
}

export function flushListeningTracking(): void {
  if (listening) flushSegment()
}

export function stopListeningTracking(): void {
  if (listening) flushSegment(Date.now(), true)
  listening = false
  context = null
  stopHeartbeat()
}
