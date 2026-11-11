import {
  generateBookLexicon,
  type BookLexiconRequest,
  type BookLexiconResponse,
} from './bookLexicon'

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<BookLexiconRequest>) => void,
  ): void
  postMessage(message: BookLexiconResponse): void
}

const scope = self as unknown as WorkerScope

async function readCachedText(cacheName: string, url: string): Promise<string> {
  const cache = await caches.open(cacheName)
  const response = await cache.match(url)
  if (!response) throw new Error('音色包文件缺失，请重新下载音色包。')
  return response.text()
}

scope.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'generate') return
  const jobId = data.jobId

  void (async () => {
    try {
      const [lexiconText, tokensText] = await Promise.all([
        readCachedText(data.cacheName, data.lexiconUrl),
        readCachedText(data.cacheName, data.tokensUrl),
      ])
      const result = generateBookLexicon({
        chunks: data.chunks,
        lexiconText,
        tokensText,
        curatedOverlay: data.curatedOverlay,
      })
      scope.postMessage({
        type: 'done',
        jobId,
        overlay: result.overlay,
        entries: result.entries.length,
        stats: result.stats,
      })
    } catch (error) {
      scope.postMessage({
        type: 'error',
        jobId,
        message:
          error instanceof Error ? error.message : '本书读音生成失败。',
      })
    }
  })()
})
