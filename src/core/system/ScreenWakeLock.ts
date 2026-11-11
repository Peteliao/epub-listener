/**
 * Keeps the screen awake while playback is active. This cannot prevent the
 * user from locking the device, nor can it keep the page alive after lock.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null
  private wanted = false
  private requesting = false
  private warned = false
  private readonly onUnavailable?: () => void
  private readonly handleVisibility = () => {
    if (document.visibilityState === 'visible' && this.wanted) void this.acquire()
  }

  constructor(onUnavailable?: () => void) {
    this.onUnavailable = onUnavailable
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility)
    }
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.wanted = enabled
    if (!enabled) {
      await this.release()
      return
    }
    await this.acquire()
  }

  destroy(): void {
    this.wanted = false
    document.removeEventListener('visibilitychange', this.handleVisibility)
    void this.release()
  }

  private async acquire(): Promise<void> {
    if (!this.supported || !this.wanted || this.sentinel || this.requesting) return

    this.requesting = true
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      if (!this.wanted) {
        await sentinel.release()
        return
      }

      this.sentinel = sentinel
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null
      })
    } catch {
      if (!this.warned) {
        this.warned = true
        this.onUnavailable?.()
      }
    } finally {
      this.requesting = false
    }
  }

  private async release(): Promise<void> {
    const sentinel = this.sentinel
    this.sentinel = null
    if (!sentinel) return
    try {
      await sentinel.release()
    } catch {
      // Already released by the browser.
    }
  }
}
