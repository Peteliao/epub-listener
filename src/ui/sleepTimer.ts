import { computed, onBeforeUnmount, ref } from 'vue'

export type SleepTimerMode = 'countdown' | 'clock'

export function nextTimeOccurrence(
  hour: number,
  minute: number,
  now = Date.now(),
): number {
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return target.getTime()
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`
}

export function formatTargetDay(timestamp: number, now = Date.now()): string {
  const target = new Date(timestamp)
  const today = new Date(now)
  const sameDay =
    target.getFullYear() === today.getFullYear() &&
    target.getMonth() === today.getMonth() &&
    target.getDate() === today.getDate()
  return `${sameDay ? '今天' : '明天'} ${formatClock(timestamp)}`
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0 秒'
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

export function formatRemainingShort(ms: number): string {
  if (ms <= 0) return '0 分'
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000))
  if (totalMinutes < 60) return `${totalMinutes} 分`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours} 时 ${minutes} 分` : `${hours} 时`
}

export function useSleepTimer(onExpire: () => void) {
  const endsAt = ref<number | null>(null)
  const mode = ref<SleepTimerMode>('countdown')
  const now = ref(Date.now())
  let fireTimer: number | null = null
  let tickTimer: number | null = null

  const active = computed(() => endsAt.value !== null)
  const remainingMs = computed(() =>
    endsAt.value === null ? 0 : Math.max(0, endsAt.value - now.value),
  )

  function clearTimers(): void {
    if (fireTimer !== null) {
      window.clearTimeout(fireTimer)
      fireTimer = null
    }
    if (tickTimer !== null) {
      window.clearInterval(tickTimer)
      tickTimer = null
    }
  }

  function fire(): void {
    if (endsAt.value === null) return
    endsAt.value = null
    clearTimers()
    onExpire()
  }

  function arm(timestamp: number, nextMode: SleepTimerMode): void {
    clearTimers()
    now.value = Date.now()
    endsAt.value = timestamp
    mode.value = nextMode
    fireTimer = window.setTimeout(fire, Math.max(0, timestamp - now.value))
    tickTimer = window.setInterval(() => {
      now.value = Date.now()
      if (endsAt.value !== null && now.value >= endsAt.value) fire()
    }, 1000)
  }

  function startIn(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    arm(Date.now() + Math.round(minutes * 60_000), 'countdown')
  }

  function startAt(hour: number, minute: number): number {
    const target = nextTimeOccurrence(hour, minute)
    arm(target, 'clock')
    return target
  }

  function cancel(): void {
    endsAt.value = null
    clearTimers()
  }

  function handleVisibility(): void {
    if (document.visibilityState !== 'visible' || endsAt.value === null) return
    now.value = Date.now()
    if (now.value >= endsAt.value) fire()
  }

  document.addEventListener('visibilitychange', handleVisibility)

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', handleVisibility)
    cancel()
  })

  return { endsAt, mode, active, remainingMs, startIn, startAt, cancel }
}
