export type UpdateCheckResult =
  | 'updated'
  | 'current'
  | 'pending'
  | 'unavailable'
  | 'failed'

export interface UpdateWorkerLike {
  readonly state: ServiceWorkerState
  addEventListener(type: 'statechange', listener: () => void): void
  removeEventListener(type: 'statechange', listener: () => void): void
}

export interface UpdateRegistrationLike {
  readonly installing: UpdateWorkerLike | null
  readonly waiting: UpdateWorkerLike | null
  update(): Promise<unknown>
}

const FINAL_STATES = new Set<ServiceWorkerState>([
  'installed',
  'activated',
  'redundant',
])

function waitForFinalState(
  worker: UpdateWorkerLike,
  timeoutMs: number,
): Promise<ServiceWorkerState | 'timeout'> {
  if (FINAL_STATES.has(worker.state)) return Promise.resolve(worker.state)

  return new Promise((resolve) => {
    let settled = false
    const finish = (state: ServiceWorkerState | 'timeout'): void => {
      if (settled) return
      settled = true
      worker.removeEventListener('statechange', onChange)
      clearTimeout(timer)
      resolve(state)
    }
    const onChange = (): void => {
      if (FINAL_STATES.has(worker.state)) finish(worker.state)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    worker.addEventListener('statechange', onChange)
    onChange()
  })
}

/** Fetch a fresh worker script and apply it if a new build is waiting. */
export async function checkForAppUpdate(
  registration: UpdateRegistrationLike | null,
  apply: () => void,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<UpdateCheckResult> {
  if (!registration) return 'unavailable'
  if (registration.waiting) {
    apply()
    return 'updated'
  }

  try {
    await registration.update()
  } catch {
    return 'failed'
  }

  if (registration.waiting) {
    apply()
    return 'updated'
  }

  const installing = registration.installing
  if (!installing) return 'current'

  const state = await waitForFinalState(installing, timeoutMs)
  if (state === 'installed' || state === 'activated') {
    apply()
    return 'updated'
  }
  if (state === 'redundant') return 'failed'
  return 'pending'
}