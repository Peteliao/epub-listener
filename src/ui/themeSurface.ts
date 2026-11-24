import { watch, type WatchStopHandle } from 'vue'
import {
  patternTileUrl,
  type ReaderPalette,
  type ReaderTheme,
} from '@/types'

interface ThemeSurface {
  root: HTMLElement
  body: HTMLElement | null
  themeColorMeta: HTMLMetaElement | null
}

function resolveThemeSurface(): ThemeSurface {
  return {
    root: document.documentElement,
    body: document.body,
    themeColorMeta: document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    ),
  }
}

/**
 * Safari 26 stopped taking the status bar colour from theme-color. It now
 * samples the background-color of page elements: <body> plus any fixed/sticky
 * element that sits within 4px of the top, spans 80%+ of the width and is at
 * least 11px tall. The meta tag is still useful: rewriting its content wakes
 * Safari's internal observer, which otherwise ignores most runtime colour
 * changes. The "fe" suffix keeps the value a parseable colour while still
 * counting as a change; the clean value returns one frame later.
 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i
let tintRevision = 0

function scheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback())
    return
  }
  window.setTimeout(callback, 16)
}

function syncThemeColorMeta(
  meta: HTMLMetaElement | null,
  color: string,
): void {
  if (!meta) return
  const revision = ++tintRevision
  meta.setAttribute('content', color)
  if (!HEX_COLOR.test(color)) return
  scheduleFrame(() => {
    if (revision !== tintRevision) return
    meta.setAttribute('content', `${color}fe`)
    scheduleFrame(() => {
      if (revision !== tintRevision) return
      meta.setAttribute('content', color)
    })
  })
}

export function applyThemeSurface(
  palette: ReaderPalette,
  theme: ReaderTheme,
  surface: ThemeSurface = resolveThemeSurface(),
): void {
  const { root, body, themeColorMeta } = surface
  // The strip behind the iOS status bar must match the reading surface. Pocket
  // mode swaps in the OLED palette, so the same variable becomes pure black.
  // The status bar cannot paint a gradient, so this stays one solid color.
  const statusBarBg = palette.bg
  root.style.setProperty('--app-bg', palette.bg)
  root.style.setProperty('--status-bar-bg', statusBarBg)
  root.style.setProperty('--app-bg-image', palette.bgImage ?? 'none')
  // Panels use --app-ui as their base color, so they need a tile-only layer:
  // the full gradient would repaint the panel and erase its elevation.
  root.style.setProperty(
    '--app-pattern',
    patternTileUrl(palette) ? (palette.bgImage ?? 'none') : 'none',
  )
  root.style.setProperty('--app-fg', palette.fg)
  root.style.setProperty('--app-muted', palette.muted)
  root.style.setProperty('--app-accent', palette.accent)
  root.style.setProperty('--app-ui', palette.uiBg)
  root.style.setProperty('--app-highlight', palette.highlight)
  root.style.colorScheme = palette.dark ? 'dark' : 'light'
  root.dataset.theme = theme
  // <body> is one of the surfaces Safari samples for its own toolbar, and its
  // observer only tracks an explicitly present background-color. Writing it
  // inline keeps the property there on every theme, pocket mode included.
  if (body) body.style.backgroundColor = statusBarBg
  syncThemeColorMeta(themeColorMeta, statusBarBg)
}

export function bindThemeSurface(
  palette: () => ReaderPalette,
  theme: () => ReaderTheme,
  surface: ThemeSurface = resolveThemeSurface(),
): WatchStopHandle {
  // Sync flush keeps the page surface and iOS status bar color in the same task.
  return watch(
    [palette, theme],
    ([nextPalette, nextTheme]) => {
      applyThemeSurface(nextPalette, nextTheme, surface)
    },
    { immediate: true, flush: 'sync' },
  )
}
