import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const swTemplatePath = fileURLToPath(new URL('./pwa/sw.js', import.meta.url))
const appVersion = String(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
  ).version ?? '0.0.0',
)

function shushengPwa(): Plugin {
  return {
    name: 'shusheng-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      const template = readFileSync(swTemplatePath, 'utf8')
      const hash = createHash('sha256')
      const assetPaths = new Set<string>(['./index.html'])

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          hash.update(fileName).update(output.code)
        } else {
          hash.update(fileName).update(String(output.source))
        }
        if (/\.(?:js|css|html|woff2?|png|svg|webmanifest)$/.test(fileName)) {
          assetPaths.add(`./${fileName}`)
        }
      }

      hash.update(template)
      // Public shell assets sit outside the Rollup bundle; include the ones
      // that change independently so the service worker rotates its cache
      // instead of serving the previous sample or offline voice.
      for (const path of [
        'public/models/manifest.json',
        'public/workers/sherpa-tts.worker.js',
        'public/sample.epub',
      ]) {
        try {
          hash.update(path).update(
            readFileSync(fileURLToPath(new URL(`./${path}`, import.meta.url))),
          )
        } catch {
          // Optional public assets may be absent in stripped builds.
        }
      }
      // Readable release number + content digest. Bumping package.json version
      // is the explicit "update build number" action a listener can check in
      // 书架/阅读器; the digest still rotates the SW caches on every content
      // change between releases, which is what delivers hot updates.
      const buildId = `${appVersion}.${hash.digest('hex').slice(0, 8)}`

      this.emitFile({
        type: 'asset',
        fileName: 'sw-assets.json',
        source: JSON.stringify([...assetPaths].sort()),
      })
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replaceAll('__BUILD_ID__', buildId),
      })
    },
  }
}

/**
 * Dev-only: Vite's SPA fallback treats `/di-test/` as an app route and serves
 * the Vue shell, while GitHub Pages correctly serves public/di-test/index.html.
 * Redirect so a local directory link behaves exactly like the deployed one.
 */
function devDirectoryIndex(): Plugin {
  return {
    name: 'shusheng-dev-directory-index',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path === '/di-test' || path === '/di-test/') {
          res.writeHead(302, { Location: '/di-test/index.html' })
          res.end()
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), shushengPwa(), devDirectoryIndex()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
})
