export interface MediaSessionActions {
  play: () => void
  pause: () => void
  next: () => void
  previous: () => void
}

function artworkUrl(): string {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI)
  return new URL('icons/icon-512.png', base).href
}

function supported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'mediaSession' in navigator &&
    typeof MediaMetadata !== 'undefined'
  )
}

export class MediaSessionController {
  private readonly bookTitle: string
  private readonly author: string
  private bound = false
  private metadataKey = ''
  private lastPlaying: boolean | null = null

  constructor(bookTitle: string, author: string) {
    this.bookTitle = bookTitle
    this.author = author
  }

  bind(actions: MediaSessionActions): void {
    if (!supported() || this.bound) return
    this.bound = true

    const handlers: Array<[MediaSessionAction, () => void]> = [
      ['play', actions.play],
      ['pause', actions.pause],
      ['previoustrack', actions.previous],
      ['nexttrack', actions.next],
      ['seekbackward', actions.previous],
      ['seekforward', actions.next],
      ['stop', actions.pause],
    ]

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // Browsers ignore individual actions they do not implement.
      }
    }
  }

  update(chapterLabel: string, isPlaying: boolean): void {
    if (!supported()) return
    const session = navigator.mediaSession

    if (chapterLabel && chapterLabel !== this.metadataKey) {
      this.metadataKey = chapterLabel
      const artist = [this.bookTitle, this.author].filter(Boolean).join(' · ')
      session.metadata = new MediaMetadata({
        title: chapterLabel,
        artist: artist || '书声',
        album: '书声 · 网页听书',
        artwork: [
          {
            src: artworkUrl(),
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      })
    }

    if (this.lastPlaying !== isPlaying) {
      this.lastPlaying = isPlaying
      session.playbackState = isPlaying ? 'playing' : 'paused'
    }
  }

  clear(): void {
    if (!supported() || !this.bound) return
    const session = navigator.mediaSession
    try {
      session.metadata = null
      session.playbackState = 'none'
    } catch {
      // Metadata is advisory only.
    }
    for (const action of [
      'play',
      'pause',
      'previoustrack',
      'nexttrack',
      'seekbackward',
      'seekforward',
      'stop',
    ] as MediaSessionAction[]) {
      try {
        session.setActionHandler(action, null)
      } catch {
        // Ignore actions the browser does not support.
      }
    }
    this.bound = false
    this.metadataKey = ''
    this.lastPlaying = null
  }
}
