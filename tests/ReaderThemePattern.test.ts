import { describe, expect, it } from 'vitest'
import {
  patternTileUrl,
  READER_PALETTES,
  READER_THEME_GROUPS,
  READER_THEME_ORDER,
  type ReaderTheme,
  type ReaderThemeCategory,
} from '@/types'

function themesOf(id: ReaderThemeCategory): ReaderTheme[] {
  const group = READER_THEME_GROUPS.find((item) => item.id === id)
  if (!group) throw new Error(`missing theme group ${id}`)
  return group.themes
}

describe('reader theme backgrounds', () => {
  it('exposes an inline SVG tile for every pattern theme', () => {
    for (const theme of themesOf('pattern')) {
      const url = patternTileUrl(READER_PALETTES[theme])
      expect(url, theme).toMatch(/^data:image\/svg\+xml,/)
      // It is re-used as a CSS background-image, so it must stay quote-safe.
      expect(url, theme).not.toContain('"')
      const svg = decodeURIComponent(url!.slice('data:image/svg+xml,'.length))
      expect(svg, theme).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg'/)
      expect(svg, theme).toContain('viewBox=')
    }
  })

  it('returns no tile for solid and gradient themes', () => {
    for (const theme of [...themesOf('solid'), ...themesOf('gradient')]) {
      expect(patternTileUrl(READER_PALETTES[theme]), theme).toBeNull()
    }
  })

  it('keeps every theme in exactly one category', () => {
    const grouped = READER_THEME_GROUPS.flatMap((group) => group.themes)
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(new Set(grouped)).toEqual(new Set(READER_THEME_ORDER))
  })
})
