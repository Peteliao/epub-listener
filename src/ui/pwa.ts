import { ref } from 'vue'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const updateReady = ref(false)
export const installAvailable = ref(false)
export const isStandalone = ref(false)
/** Build id reported by the worker that currently controls this page. */
export const appBuildId = ref<string | null>(null)

const AUTO_UPDATE_KEY = 'shusheng:auto-update'
const CONTROLLER_RELOAD_KEY = 'shusheng:controller-reload'

let registration: ServiceWorkerRegistration | null = null
let deferredPrompt: InstallPromptEvent | null = null
let refreshing = false
let started = false
let visibilityHooked = false
let hadController = false
let controllerReloadClaimed = false

export function setupPwa(): void {
  if (started || typeof window === 'undefined') return
  started = true

  isStandalone.value =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event as InstallPromptEvent
    if (!isStandalone.value) installAvailable.value = true
  })

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    installAvailable.value = false
  })

  if (import.meta.env.PROD) void registerWorker()
}

function requestBuildId(): void {
  const controller = navigator.serviceWorker.controller
  if (!controller) return
  try {
    const channel = new MessageChannel()
    channel.port1.onmessage = (event: MessageEvent<{ buildId?: unknown }>) => {
      const id = event.data?.buildId
      if (typeof id === 'string' && id) appBuildId.value = id
    }
    controller.postMessage({ type: 'BUILD_ID' }, [channel.port2])
  } catch {
    // Workers from older builds do not answer; the build stays unknown.
  }
}

function claimControllerReload(): boolean {
  if (controllerReloadClaimed) return false
  controllerReloadClaimed = true
  try {
    const raw = sessionStorage.getItem(CONTROLLER_RELOAD_KEY)
    const now = Date.now()
    if (raw && now - Number(raw) < 15_000) return false
    sessionStorage.setItem(CONTROLLER_RELOAD_KEY, String(now))
    return true
  } catch {
    return true
  }
}

function claimAutoUpdate(): boolean {
  try {
    if (sessionStorage.getItem(AUTO_UPDATE_KEY)) return false
    sessionStorage.setItem(AUTO_UPDATE_KEY, '1')
    return true
  } catch {
    return true
  }
}

async function registerWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  hadController = !!navigator.serviceWorker.controller

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) {
      window.location.reload()
      return
    }
    // A page revived from the background can keep running the previous JS
    // even after the new worker takes control, so load the new build now.
    if (hadController && claimControllerReload()) {
      window.location.reload()
      return
    }
    requestBuildId()
  })

  try {
    const swUrl = new URL(`${import.meta.env.BASE_URL}sw.js`, document.baseURI).href
    const reg = await navigator.serviceWorker.register(swUrl, {
      updateViaCache: 'none',
    })
    registration = reg
    requestBuildId()
    window.setTimeout(() => {
      try {
        sessionStorage.removeItem(AUTO_UPDATE_KEY)
      } catch {
        // Storage unavailable; the guard simply stays for this tab.
      }
    }, 10_000)

    if (reg.waiting && navigator.serviceWorker.controller) {
      // A finished update waited for a restart. Apply it while the user is
      // only opening the app, so an old build cannot keep running silently.
      if (claimAutoUpdate()) {
        applyUpdate()
        return
      }
      updateReady.value = true
    }

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (
          installing.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          updateReady.value = true
        }
      })
    })

    if (!visibilityHooked) {
      visibilityHooked = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (!registration) return
        void registration.update().catch(() => undefined)
      })
    }
  } catch {
    // PWA support is an enhancement; the app keeps working without it.
  }
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false
  const event = deferredPrompt
  deferredPrompt = null
  installAvailable.value = false
  try {
    await event.prompt()
    const choice = await event.userChoice
    return choice.outcome === 'accepted'
  } catch {
    return false
  }
}

export function applyUpdate(): void {
  const waiting = registration?.waiting
  if (!waiting) {
    window.location.reload()
    return
  }
  refreshing = true
  waiting.postMessage({ type: 'SKIP_WAITING' })
  window.setTimeout(() => {
    if (refreshing) window.location.reload()
  }, 1500)
}

export function dismissUpdate(): void {
  updateReady.value = false
}
