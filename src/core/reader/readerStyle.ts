import type { ReaderSettings } from '@/types'
import { READER_PALETTES } from '@/types'

export const READER_STYLE_ID = 'shusheng-reader-style'

export function buildReaderCss(settings: ReaderSettings): string {
  const palette = READER_PALETTES[settings.theme]
  return `
:root { --tts-highlight: ${palette.highlight}; }
html {
  background: ${palette.bg} !important;
  overflow-x: hidden !important;
  touch-action: pan-y;
}
body {
  background: ${palette.bg} !important;
  color: ${palette.fg} !important;
  touch-action: pan-y;
  font-size: ${settings.fontSize}px !important;
  line-height: 1.85 !important;
  padding: 26px clamp(20px, 6vw, 56px) 48px !important;
  max-width: 780px !important;
  margin: 0 auto !important;
  box-sizing: border-box !important;
  overflow-wrap: break-word !important;
  -webkit-text-size-adjust: 100% !important;
}
body, body *:not(a):not(a *) {
  color: ${palette.fg} !important;
}
body a, body a * {
  color: ${palette.accent} !important;
  text-decoration-color: ${palette.accent} !important;
}
body p {
  margin: 0 0 0.9em !important;
}
body img, body svg, body video, body image {
  max-width: 100% !important;
  height: auto !important;
}
body hr {
  border-color: ${palette.muted} !important;
  opacity: 0.35 !important;
}
body table {
  max-width: 100% !important;
}
::selection {
  background: ${palette.highlight};
  color: ${palette.fg};
}
`
}

export function injectContentPolicy(doc: Document): void {
  if (!doc.head || doc.querySelector('meta[data-shusheng-csp]')) return

  const meta = doc.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data: blob:; font-src data: blob:; media-src data: blob:;"
  meta.dataset.shushengCsp = 'true'
  doc.head.appendChild(meta)
}

export function applyReaderStyle(doc: Document, settings: ReaderSettings): void {
  const head = doc.head ?? doc.documentElement
  let style = doc.getElementById(READER_STYLE_ID) as HTMLStyleElement | null

  if (!style) {
    style = doc.createElement('style')
    style.id = READER_STYLE_ID
    head.appendChild(style)
  }

  style.textContent = buildReaderCss(settings)
  doc.documentElement.dataset.shushengTheme = settings.theme
}
