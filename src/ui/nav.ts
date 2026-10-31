export type Route =
  | { name: 'library' }
  | { name: 'reader'; bookId: string }

const READER_PREFIX = '#/read/'

export function parseRoute(hash: string): Route {
  if (hash.startsWith(READER_PREFIX)) {
    const raw = hash.slice(READER_PREFIX.length)
    if (raw) {
      try {
        return { name: 'reader', bookId: decodeURIComponent(raw) }
      } catch {
        return { name: 'library' }
      }
    }
  }
  return { name: 'library' }
}

export function navigateToReader(bookId: string): void {
  window.location.hash = `${READER_PREFIX}${encodeURIComponent(bookId)}`
}

export function navigateToLibrary(): void {
  window.location.hash = '#/'
}
