/* Shusheng app-shell service worker. Injected at build time with a build id. */

'use strict'

const BUILD_ID = '__BUILD_ID__'
const SHELL_CACHE = `shusheng-shell-${BUILD_ID}`
const ASSETS_CACHE = `shusheng-assets-${BUILD_ID}`
const SHELL_CACHE_PREFIX = 'shusheng-shell-'
const ASSETS_CACHE_PREFIX = 'shusheng-assets-'
const TTS_RUNTIME_PREFIX = 'shusheng-tts-runtime-'

const scopeUrl = new URL(self.registration.scope)
const toUrl = (path) => new URL(path, scopeUrl).href

const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'models/manifest.json',
  'workers/sherpa-tts.worker.js',
  'sample.epub',
].map(toUrl)

const INDEX_URL = toUrl('index.html')
const ASSET_REFERENCE = /(?:src|href)\s*=\s*["']([^"']+)["']/g

function isSameOrigin(url) {
  return url.origin === scopeUrl.origin
}

function pathOf(url) {
  return url.pathname
}

function indexAssetUrls(html) {
  const urls = new Set()
  for (const match of html.matchAll(ASSET_REFERENCE)) {
    const value = match[1]
    if (!value || value.startsWith('data:') || value.startsWith('#')) continue
    let url
    try {
      url = new URL(value, INDEX_URL)
    } catch {
      continue
    }
    if (!isSameOrigin(url)) continue
    if (url.href === INDEX_URL || url.href === scopeUrl.href) continue
    url.hash = ''
    urls.add(url.href)
  }
  return [...urls]
}

function isAssetPath(url) {
  return new URL(url).pathname.includes('/assets/')
}

async function fetchFresh(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to precache ${url}: ${response.status}`)
  }
  return response
}

async function readBuildAssets() {
  const response = await fetch(toUrl('sw-assets.json'), { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to read sw-assets.json: ${response.status}`)
  }
  const paths = await response.json()
  if (!Array.isArray(paths)) throw new Error('sw-assets.json is not a list')
  return new Set(
    paths.filter((path) => typeof path === 'string').map((path) => toUrl(path)),
  )
}

async function precache() {
  const shell = await caches.open(SHELL_CACHE)
  const assets = await caches.open(ASSETS_CACHE)

  try {
    const buildAssets = await readBuildAssets()
    const indexResponse = await fetchFresh(INDEX_URL)
    const html = await indexResponse.clone().text()
    await shell.put(INDEX_URL, indexResponse.clone())
    await shell.put(toUrl('./'), indexResponse.clone())

    // The cached index and its hashed assets must come from the same deploy.
    // A partially rolled-out deploy can otherwise leave a shell whose entry
    // script 404s after the previous build's caches are deleted.
    const linked = indexAssetUrls(html)
    for (const url of linked) {
      if (isAssetPath(url) && !buildAssets.has(url)) {
        throw new Error(`Index references an asset outside this build: ${url}`)
      }
    }

    const targets = new Map()
    for (const url of SHELL_ASSETS) {
      if (url === INDEX_URL || url === toUrl('./')) continue
      targets.set(url, 'shell')
    }
    for (const url of linked) {
      targets.set(url, isAssetPath(url) ? 'assets' : 'shell')
    }

    await Promise.all(
      [...targets].map(async ([url, bucket]) => {
        const response = await fetchFresh(url)
        const cache = bucket === 'assets' ? assets : shell
        await cache.put(url, response)
      }),
    )

    const extras = [...buildAssets].filter(
      (url) => !targets.has(url) && url !== INDEX_URL && url !== toUrl('./'),
    )
    await Promise.all(
      extras.map(async (url) => {
        try {
          const response = await fetchFresh(url)
          const cache = isAssetPath(url) ? assets : shell
          await cache.put(url, response)
        } catch {
          // Lazy chunks can still be fetched on demand; first paint is safe.
        }
      }),
    )

    for (const url of linked) {
      const cache = isAssetPath(url) ? assets : shell
      if (!(await cache.match(url))) {
        throw new Error(`Missing shell asset: ${url}`)
      }
    }
  } catch (error) {
    await caches.delete(SHELL_CACHE)
    await caches.delete(ASSETS_CACHE)
    throw error
  }
}

async function shellIndex() {
  const cache = await caches.open(SHELL_CACHE)
  return (
    (await cache.match(INDEX_URL)) ||
    (await cache.match(toUrl('./'))) ||
    null
  )
}

async function currentCacheHas(url) {
  const shell = await caches.open(SHELL_CACHE)
  if (await shell.match(url)) return true
  const assets = await caches.open(ASSETS_CACHE)
  return !!(await assets.match(url))
}

async function shellIndexComplete(response) {
  let html
  try {
    html = await response.clone().text()
  } catch {
    return false
  }
  for (const url of indexAssetUrls(html)) {
    if (!(await currentCacheHas(url))) return false
  }
  return true
}

async function handleNavigation(event) {
  const cached = await shellIndex()
  if (cached && (await shellIndexComplete(cached))) return cached

  try {
    // Navigation requests cannot be recreated with an init object; use the URL.
    return await fetch(event.request.url, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
  } catch {
    if (cached) return cached
    return new Response('书声暂时处于离线状态，请联网后重新打开。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

async function cachedIndexHtml(shellName) {
  const cache = await caches.open(shellName)
  const response =
    (await cache.match(INDEX_URL)) || (await cache.match(toUrl('./')))
  if (!response) return null
  try {
    return await response.text()
  } catch {
    return null
  }
}

async function pairedCacheHas(shellName, url) {
  const suffix = shellName.slice(SHELL_CACHE_PREFIX.length)
  for (const name of [shellName, `${ASSETS_CACHE_PREFIX}${suffix}`]) {
    const cache = await caches.open(name)
    if (await cache.match(url)) return true
  }
  return false
}

async function hasBrokenShellCache() {
  const names = (await caches.keys()).filter(
    (name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE,
  )
  for (const name of names) {
    const html = await cachedIndexHtml(name)
    if (!html) return true
    for (const url of indexAssetUrls(html)) {
      if (!(await pairedCacheHas(name, url))) return true
    }
  }
  return false
}

async function runtimeCaches() {
  const names = await caches.keys()
  return names.filter((name) => name.startsWith(TTS_RUNTIME_PREFIX))
}

function runtimeContentType(url) {
  const path = new URL(url).pathname
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.wasm')) return 'application/wasm'
  return ''
}

function withRuntimeType(response, url) {
  if (!response || response.headers.get('Content-Type')) return response
  const type = runtimeContentType(url)
  if (!type) return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: { 'Content-Type': type },
  })
}

async function matchRuntime(url) {
  for (const name of await runtimeCaches()) {
    const cache = await caches.open(name)
    const hit = await cache.match(url)
    if (hit) return withRuntimeType(hit, url)
  }
  return null
}

async function handleTtsRuntime(request) {
  const hit = await matchRuntime(request.url)
  if (hit) return hit

  const response = await fetch(request)
  if (response.ok) {
    const names = await runtimeCaches()
    if (names.length) {
      try {
        const cache = await caches.open(names[0])
        await cache.put(request, response.clone())
      } catch {
        // Runtime still works for this session without a cache write.
      }
    }
  }
  return response
}

async function handleAsset(request) {
  const [assets, shell] = await Promise.all([
    caches.open(ASSETS_CACHE),
    caches.open(SHELL_CACHE),
  ])

  // Build-precached files are immutable for this build; serve them directly.
  const shellHit = await shell.match(request)
  if (shellHit) return shellHit

  const cached = await assets.match(request)

  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        try {
          await assets.put(request, response.clone())
        } catch {
          // Ignore quota failures for non-critical assets.
        }
      }
      return response
    })
    .catch(() => null)

  if (cached) return cached
  const response = await network
  return response || Response.error()
}

async function handleRequest(event) {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (!isSameOrigin(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event))
    return
  }

  const path = pathOf(url)

  // Voice model data is large and already stored in the AI cache; never mirror it.
  if (path.includes('/models/')) {
    if (path.endsWith('/models/manifest.json')) {
      event.respondWith(
        (async () => {
          const cache = await caches.open(SHELL_CACHE)
          const cached = await cache.match(toUrl('models/manifest.json'))
          return cached || fetch(request)
        })(),
      )
    }
    return
  }

  if (path.includes('/sherpa/runtime/')) {
    event.respondWith(handleTtsRuntime(request))
    return
  }

  if (path.endsWith('/sw-assets.json') || path.endsWith('/sw.js')) {
    return
  }

  event.respondWith(handleAsset(request))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precache()
      let broken = false
      try {
        broken = await hasBrokenShellCache()
      } catch {
        broken = false
      }
      // A blank client cannot prompt for an update; replace a broken shell
      // immediately so activate() can navigate it to the repaired build.
      if (broken) await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      let broken = false
      try {
        broken = await hasBrokenShellCache()
      } catch {
        broken = false
      }
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter(
            (name) =>
              (name.startsWith(SHELL_CACHE_PREFIX) ||
                name.startsWith(ASSETS_CACHE_PREFIX)) &&
              name !== SHELL_CACHE &&
              name !== ASSETS_CACHE,
          )
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
      if (broken) {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          // Chrome does not always settle navigate() for a reloaded client;
          // do not hold activation open waiting for it.
          void client.navigate(client.url).catch(() => undefined)
        }
      }
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  void handleRequest(event).catch(() => undefined)
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data) return
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }
  if (data.type === 'BUILD_ID' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ buildId: BUILD_ID })
  }
})
