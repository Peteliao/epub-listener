// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../pwa/sw.js', import.meta.url), 'utf8')

function runtimeCache() {
  const match = vi.fn(async () => new Response('old runtime', {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Cached': 'yes' },
  }))
  const fetch = vi.fn(async () => new Response('new runtime'))
  const context = createContext({
    self: { registration: { scope: 'https://example.test/epub/' }, addEventListener: vi.fn() },
    URL, Response, Request, Headers, fetch,
    caches: { keys: async () => ['shusheng-tts-runtime-old'], open: async () => ({ match }) },
  })
  runInContext(source, context)
  const handle = runInContext('handleTtsRuntime', context) as (request: Request) => Promise<Response>
  return { handle, match, fetch }
}

describe('TTS runtime service worker cache', () => {
  it.each(['no-store', 'reload'] as const)('does not return old runtime bytes for a %s update download', async (cache) => {
    const runtime = runtimeCache()
    const request = new Request('https://example.test/epub/hojo/runtime/hojo-core.js', { cache })
    const result = await runtime.handle(request)
    expect(await result.text()).toBe('new runtime')
    expect(runtime.match).not.toHaveBeenCalled()
    expect(runtime.fetch).toHaveBeenCalledWith(request)
  })

  it('serves cached ONNX modules offline with an executable module MIME type', async () => {
    const runtime = runtimeCache()
    const result = await runtime.handle(new Request('https://example.test/epub/hojo/runtime/ort-wasm-simd-threaded.mjs'))
    expect(await result.text()).toBe('old runtime')
    expect(result.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(result.headers.get('X-Cached')).toBe('yes')
    expect(runtime.fetch).not.toHaveBeenCalled()
  })

  it('continues serving cached WASM for normal playback requests', async () => {
    const runtime = runtimeCache()
    const result = await runtime.handle(new Request('https://example.test/epub/hojo/runtime/ort-wasm-simd-threaded.wasm'))
    expect(await result.text()).toBe('old runtime')
    expect(result.headers.get('Content-Type')).toBe('application/wasm')
    expect(runtime.fetch).not.toHaveBeenCalled()
  })
})
