import { ref } from 'vue'

export type ToastTone = 'info' | 'error'

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

export const toasts = ref<ToastItem[]>([])

let nextId = 1
const timers = new Map<number, number>()

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
  toasts.value = toasts.value.filter((item) => item.id !== id)
}

export function showToast(message: string, tone: ToastTone = 'info'): void {
  const id = nextId++
  toasts.value.push({ id, message, tone })

  while (toasts.value.length > 3) {
    const oldest = toasts.value[0]
    if (!oldest) break
    dismissToast(oldest.id)
  }

  const duration = tone === 'error' ? 5000 : 2800
  const timer = window.setTimeout(() => dismissToast(id), duration)
  timers.set(id, timer)
}
