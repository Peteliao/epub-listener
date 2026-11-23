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

function isIosStandaloneWebApp(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function statusBarSurfaceColor(palette: ReaderPalette): string {
  if (!isIosStandaloneWebApp()) return palette.bg
  // black-translucent fixes installed iOS apps to white system glyphs, so the
  // strip behind them must stay dark; light themes use their ink color.
  return palette.dark ? palette.bg : palette.fg
}

export function applyThemeSurface(
  palette: ReaderPalette,
  theme: ReaderTheme,
  surface: ThemeSurface = resolveThemeSurface(),
): void {
  const { root, themeColorMeta } = surface
  // The status bar cannot paint a gradient, so its strip and theme-color stay
  // one solid color instead of reusing the page background image.
  const statusBarBg = statusBarSurfaceColor(palette)
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
  themeColorMeta?.setAttribute('content', statusBarBg)
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