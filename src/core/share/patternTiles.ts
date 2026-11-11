import bamboo from '@/assets/share-patterns/bamboo.png'
import cloud from '@/assets/share-patterns/cloud.png'
import lattice from '@/assets/share-patterns/lattice.png'
import lotus from '@/assets/share-patterns/lotus.png'
import petal from '@/assets/share-patterns/petal.png'
import ripple from '@/assets/share-patterns/ripple.png'
import star from '@/assets/share-patterns/star.png'
import wheat from '@/assets/share-patterns/wheat.png'
import willow from '@/assets/share-patterns/willow.png'
import type { ReaderTheme } from '@/types'

/**
 * PNG copies of the vector tiles used by the share card. iOS Safari taints a
 * canvas that draws SVG images, even when they come from a same-origin blob;
 * PNG tiles keep the canvas exportable while preserving the motif.
 *
 * The files are rendered at 3× the CSS tile size, which is 1:1 at the card's
 * display size while keeping the asset payload under 200 KB.
 */
export const SHARE_PATTERN_PIXEL_RATIO = 3

export const SHARE_PATTERN_TILES: Partial<Record<ReaderTheme, string>> = {
  bamboo,
  ripple,
  cloud,
  petal,
  lattice,
  lotus,
  willow,
  wheat,
  star,
}
