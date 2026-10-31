import type { StoredBook } from '@/types'
import { getBookFormat } from '@/types'
import { EpubSession } from './EpubSession'
import type { ReaderSession, SessionCallbacks } from './ReaderSession'

export async function createReaderSession(
  book: StoredBook,
  container: HTMLElement,
  callbacks: SessionCallbacks,
): Promise<ReaderSession> {
  if (getBookFormat(book) === 'epub') {
    return new EpubSession(container, callbacks)
  }
  const { FlowSession } = await import('./FlowSession')
  return new FlowSession(book, container, callbacks)
}
