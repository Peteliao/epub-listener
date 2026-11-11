export interface PrewarmEnvironment {
  saveData?: boolean
  /** NetworkInformation.type, e.g. "wifi" or "cellular". */
  connectionType?: string
  /** NetworkInformation.effectiveType, e.g. "4g" or "2g". */
  effectiveType?: string
  /** navigator.deviceMemory in GiB; absent on Safari and Firefox. */
  deviceMemory?: number
  hidden?: boolean
}

/**
 * Warming the offline voice spends CPU and battery for a model the reader may
 * not use yet, so skip data-saver, mobile networks, small-memory phones and
 * backgrounded pages. The voice pack itself is already cached locally.
 */
export function canPrewarmAi(env: PrewarmEnvironment): boolean {
  if (env.hidden) return false
  if (env.saveData) return false
  if ((env.connectionType ?? '').toLowerCase() === 'cellular') return false

  const effective = (env.effectiveType ?? '').toLowerCase()
  if (effective === 'slow-2g' || effective === '2g' || effective === '3g') {
    return false
  }

  if (typeof env.deviceMemory === 'number' && env.deviceMemory < 4) return false
  return true
}

export function readPrewarmEnvironment(): PrewarmEnvironment {
  if (typeof navigator === 'undefined') return { hidden: true }
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: {
      saveData?: boolean
      type?: string
      effectiveType?: string
    }
  }
  return {
    saveData: nav.connection?.saveData,
    connectionType: nav.connection?.type,
    effectiveType: nav.connection?.effectiveType,
    deviceMemory: nav.deviceMemory,
    hidden:
      typeof document !== 'undefined' && document.visibilityState === 'hidden',
  }
}
