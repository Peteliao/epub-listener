import { describe, expect, it } from 'vitest'
import { SHARE_PATTERN_TILES } from '@/core/share/patternTiles'
import { READER_THEME_GROUPS } from '@/types'

describe('share card pattern tiles', () => {
  it('provides a PNG tile for every vector pattern theme', () => {
    const patternThemes =
      READER_THEME_GROUPS.find((group) => group.id === 'pattern')?.themes ?? []
    expect(patternThemes.length).toBeGreaterThan(0)

    for (const theme of patternThemes) {
      const tile = SHARE_PATTERN_TILES[theme]
      expect(tile, theme).toBeTruthy()
      expect(tile, theme).toMatch(/\.png(?:\?|$)|^data:image\/png/)
      expect(tile, theme).not.toContain('image/svg')
    }
  })

  it('does not add tiles to solid or gradient themes', () => {
    for (const group of READER_THEME_GROUPS) {
      if (group.id === 'pattern') continue
      for (const theme of group.themes) {
        expect(SHARE_PATTERN_TILES[theme], theme).toBeUndefined()
      }
    }
  })
})
