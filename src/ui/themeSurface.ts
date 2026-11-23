import { watch, type WatchStopHandle } from 'vue'
import {
  patternTileUrl,
  type ReaderPalette,
  type ReaderTheme,
} from '@/types'

interface ThemeSurface {
  root: HTMLElement
  themeColorMeta: HTMLMetaElement | null
}

function resolveThemeSurface(): ThemeSurface {
  return {
    root: document.documentElement,
    themeColorMeta: document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    ),
  }
}

export function applyThemeSurface(
  palette: ReaderPalette,
  theme: ReaderTheme,
  surface: ThemeSurface = resolveThemeSurface(),
): void {
  const { root, themeColorMeta } = surface
  root.style.setProperty('--app-bg', palette.bg)
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
  themeColorMeta?.setAttribute('content', palette.bg)
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