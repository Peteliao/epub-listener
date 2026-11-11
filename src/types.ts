export type ReaderTheme =
  | 'paper'
  | 'sepia'
  | 'green'
  | 'mist'
  | 'celadon'
  | 'rose'
  | 'forest'
  | 'mint'
  | 'bee'
  | 'night'
  | 'indigo'
  | 'oled'
  | 'bamboo'
  | 'ripple'
  | 'cloud'
  | 'petal'
  | 'lattice'
  | 'star'
  | 'snow'
  | 'sky'
  | 'violet'
  | 'sunset'
  | 'ocean'
  | 'wisteria'
  | 'lotus'
  | 'willow'
  | 'wheat'

/** Compact appearance panels opened from the player's tune bar. */
export type ReaderTuneKind = 'theme' | 'font' | 'rate'

export type TtsEngine = 'system' | 'sherpa'

export type PausePreset = 'compact' | 'standard' | 'relaxed'

export const PAUSE_PRESET_SCALES: Record<PausePreset, number> = {
  compact: 0.8,
  standard: 1,
  relaxed: 1.25,
}

export type BookFormat = 'epub' | 'fb2' | 'mobi' | 'azw3' | 'txt'

export const BOOK_FORMAT_LABELS: Record<BookFormat, string> = {
  epub: 'EPUB',
  fb2: 'FB2',
  mobi: 'MOBI',
  azw3: 'AZW3',
  txt: 'TXT',
}

export interface ReaderSettings {
  theme: ReaderTheme
  fontSize: number
  rate: number
  voiceURI: string | null
  englishVoiceURI: string | null
  /** English-only loudness; system voices clamp at 1. */
  englishVolume: number
  /** English-only speed multiplier applied on top of rate. */
  englishRate: number
  autoScroll: boolean
  engine: TtsEngine
  aiVoiceId: string
  /** English voice used by offline synthesis; paired with the Chinese voice. */
  aiEnglishVoiceId: string
  /** Hojo model size: auto picks full on desktop and int8 on touch devices. */
  aiVariant: 'auto' | 'full' | 'int8'
  /** Use the offline English voice for English runs instead of system TTS. */
  englishAi: boolean
  autoBookPolyphones: boolean
  /** Merge neighbouring sentences into one synthesis request. */
  groupSentences: boolean
  /** Skip English chunks while the screen is locked in AI mode. */
  skipEnglishWhenLocked: boolean
  pausePreset: PausePreset
  /** null keeps the value declared by the voice pack. */
  labNoiseScale: number | null
  labSilenceScale: number
}

export interface StoredBook {
  id: string
  title: string
  author: string
  /** Missing on books imported before multi-format support; treated as EPUB. */
  format?: BookFormat
  fileName: string
  size: number
  addedAt: number
  lastOpenedAt: number | null
  chapterCount: number
  source: 'local' | 'sample'
  file: ArrayBuffer
}

export type BookSummary = Omit<StoredBook, 'file'>

export function getBookFormat(book: Pick<StoredBook, 'format'>): BookFormat {
  return book.format ?? 'epub'
}

export interface StoredProgress {
  bookId: string
  chapterIndex: number
  chapterLabel: string
  sentenceIndex: number
  sentenceCount: number
  percent: number
  updatedAt: number
}

export interface ChapterInfo {
  index: number
  href: string
  label: string
}

export interface TocEntry extends ChapterInfo {
  depth: number
}

export type VoiceQuality = 'enhanced' | 'standard' | 'unknown'

export interface VoiceOption {
  uri: string
  name: string
  lang: string
  local: boolean
  isDefault: boolean
  quality: VoiceQuality
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'paper',
  fontSize: 18,
  rate: 1,
  voiceURI: null,
  englishVoiceURI: null,
  englishVolume: 1,
  englishRate: 1,
  autoScroll: true,
  engine: 'system',
  aiVoiceId: 'shanlan',
  aiEnglishVoiceId: 'kristin',
  aiVariant: 'auto',
  englishAi: true,
  autoBookPolyphones: true,
  groupSentences: true,
  skipEnglishWhenLocked: true,
  pausePreset: 'standard',
  labNoiseScale: null,
  labSilenceScale: 1,
}

export interface ReaderPalette {
  /** Solid base color: meta theme-color, share canvas and color-mix() need a plain color. */
  bg: string
  /** Optional layered gradients or SVG pattern tiles painted over bg. */
  bgImage?: string
  fg: string
  muted: string
  highlight: string
  accent: string
  uiBg: string
  /** Dark palettes need dark native controls and a matching status bar. */
  dark: boolean
}

export type ReaderThemeCategory = 'solid' | 'gradient' | 'pattern'

export interface ReaderThemeGroup {
  id: ReaderThemeCategory
  label: string
  hint: string
  themes: ReaderTheme[]
}

export const READER_THEME_GROUPS: ReaderThemeGroup[] = [
  {
    id: 'solid',
    label: '纯色',
    hint: '纸白、米黄、护眼、月白、天青适合白天；夜读、靛蓝、黛紫、省电为深色纸面，省电是纯黑背景，OLED 屏更省电。',
    themes: ['paper', 'sepia', 'green', 'snow', 'sky', 'night', 'indigo', 'violet', 'oled'],
  },
  {
    id: 'gradient',
    label: '渐变',
    hint: '九款渐变纸面，从森林晨雾到晚霞、海天、紫藤，如光线般柔和过渡。',
    themes: ['forest', 'mint', 'bee', 'sunset', 'ocean', 'wisteria', 'mist', 'celadon', 'rose'],
  },
  {
    id: 'pattern',
    label: '矢量图案',
    hint: '竹影涟漪、祥云落樱、荷塘月色、燕剪春风、风吹麦浪，矢量纹样细腻淡雅，任意缩放都清晰；星野为深色图案。',
    themes: ['bamboo', 'ripple', 'cloud', 'petal', 'lattice', 'lotus', 'willow', 'wheat', 'star'],
  },
]

export const READER_THEME_ORDER: ReaderTheme[] = READER_THEME_GROUPS.flatMap(
  (group) => group.themes,
)

export const READER_THEME_LABELS: Record<ReaderTheme, string> = {
  paper: '纸白',
  sepia: '米黄',
  green: '护眼',
  mist: '雾灰',
  celadon: '青瓷',
  rose: '绯纸',
  forest: '森林',
  mint: '薄荷',
  bee: '蜜蜂',
  night: '夜读',
  indigo: '靛蓝',
  oled: '省电',
  bamboo: '竹影',
  ripple: '涟漪',
  cloud: '祥云',
  petal: '落樱',
  lattice: '菱格',
  star: '星野',
  snow: '月白',
  sky: '天青',
  violet: '黛紫',
  sunset: '晚霞',
  ocean: '海天',
  wisteria: '紫藤',
  lotus: '荷塘月色',
  willow: '燕剪春风',
  wheat: '风吹麦浪',
}

/** Inline SVG tile as a CSS background image; vector motifs stay crisp at any scale. */
function svgTile(size: number, body: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>${body}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/**
 * Inline SVG data URL of a pattern theme, or null for solid/gradient themes.
 * Panels and the share canvas cannot paint a CSS gradient string, but an SVG
 * tile can be tiled with CanvasRenderingContext2D.createPattern().
 */
export function patternTileUrl(palette: ReaderPalette): string | null {
  const image = palette.bgImage
  if (!image) return null
  const match = /^url\("(data:image\/svg\+xml,[^"]+)"\)$/.exec(image)
  return match ? match[1] : null
}

const BAMBOO_LEAF = 'M0 0 Q15 -6 31 -2 Q15 5 0 0 Z'
const BAMBOO_LEAF_SMALL = 'M0 0 Q14 -5 27 -1 Q14 4 0 0 Z'
const CLOUD_SPIRAL =
  'M0 0 C-9 0 -15 -6 -15 -13 C-15 -21 -8 -27 0 -27 C7 -27 13 -21 13 -14 C13 -8 8 -4 3 -4 C-2 -4 -5 -7 -5 -11 C-5 -14 -2 -16 1 -16'
const SAKURA_PETAL =
  'M0 0 C-5 -6 -5 -13 -1.5 -16 L0 -14.2 L1.5 -16 C5 -13 5 -6 0 0 Z'
const STAR_SPARKLE =
  'M0 -6 L1.5 -1.5 L6 0 L1.5 1.5 L0 6 L-1.5 1.5 L-6 0 L-1.5 -1.5 Z'
const LOTUS_PETAL = 'M0 0 C-4 -8 -3 -17 0 -21 C3 -17 4 -8 0 0 Z'
const CRESCENT = 'M0 -12 A12 12 0 1 0 0 12 A13.5 13.5 0 0 1 0 -12 Z'
/** Swallow in flight: swept-back wing and long forked tail, after the ink-painting reference. */
const SWALLOW =
  'M16 0 Q12 -3 8 -2 Q2 -12 -8 -16 Q-2 -8 2 -2 Q-4 0 -6 2 L-18 8 L-7 5 L-16 14 L-4 7 Q4 8 10 4 Q15 3 16 0 Z'
const WILLOW_LEAF = 'M0 0 Q2.5 6 1 13 Q-1.5 6 0 0 Z'
const WHEAT_GRAIN = 'M0 0 C-3 -2 -3.5 -7 0 -11 C3.5 -7 3 -2 0 0 Z'

export const READER_PALETTES: Record<ReaderTheme, ReaderPalette> = {
  paper: {
    bg: '#f7f0e4',
    fg: '#33291f',
    muted: '#8a7a67',
    highlight: 'rgba(218, 154, 70, 0.34)',
    accent: '#9c4a26',
    uiBg: '#f3eadb',
    dark: false,
  },
  sepia: {
    bg: '#efe0c3',
    fg: '#4b3823',
    muted: '#8c7250',
    highlight: 'rgba(178, 117, 39, 0.32)',
    accent: '#8a4b1f',
    uiBg: '#e9d9b9',
    dark: false,
  },
  green: {
    bg: '#dfe9d8',
    fg: '#2f3b2b',
    muted: '#5f7057',
    highlight: 'rgba(96, 138, 74, 0.3)',
    accent: '#3f6b34',
    uiBg: '#d8e4d0',
    dark: false,
  },
  mist: {
    bg: '#e9e9e6',
    bgImage:
      'radial-gradient(115% 85% at 90% -10%, rgba(158, 168, 160, 0.3) 0%, rgba(158, 168, 160, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(120, 130, 124, 0.2) 0%, rgba(120, 130, 124, 0) 58%), linear-gradient(165deg, #f0f0ed 0%, #e9e9e6 48%, #dfe0da 100%)',
    fg: '#2e302c',
    muted: '#6c716b',
    highlight: 'rgba(110, 122, 112, 0.26)',
    accent: '#4d6257',
    uiBg: '#e1e2de',
    dark: false,
  },
  celadon: {
    bg: '#dce8e4',
    bgImage:
      'radial-gradient(115% 85% at 92% -10%, rgba(110, 168, 148, 0.32) 0%, rgba(110, 168, 148, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(74, 128, 114, 0.22) 0%, rgba(74, 128, 114, 0) 58%), linear-gradient(164deg, #e6f1ec 0%, #dce8e4 48%, #cfe0d8 100%)',
    fg: '#263531',
    muted: '#5f746e',
    highlight: 'rgba(74, 128, 114, 0.28)',
    accent: '#33675c',
    uiBg: '#d3e1dd',
    dark: false,
  },
  rose: {
    bg: '#f4e6e3',
    bgImage:
      'radial-gradient(115% 85% at 90% -10%, rgba(216, 150, 140, 0.32) 0%, rgba(216, 150, 140, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(176, 106, 98, 0.2) 0%, rgba(176, 106, 98, 0) 58%), linear-gradient(165deg, #f9efec 0%, #f4e6e3 48%, #eedad5 100%)',
    fg: '#3a2b2a',
    muted: '#876f6b',
    highlight: 'rgba(176, 106, 98, 0.3)',
    accent: '#8d4a44',
    uiBg: '#eeddd9',
    dark: false,
  },
  forest: {
    bg: '#eef5ea',
    bgImage:
      'radial-gradient(120% 85% at 88% -12%, rgba(150, 205, 140, 0.36) 0%, rgba(150, 205, 140, 0) 56%), radial-gradient(110% 80% at -8% 108%, rgba(97, 152, 116, 0.22) 0%, rgba(97, 152, 116, 0) 58%), linear-gradient(168deg, #f5faf1 0%, #eef5e9 46%, #e6f0e0 100%)',
    fg: '#2a3526',
    muted: '#5d7055',
    highlight: 'rgba(92, 152, 86, 0.3)',
    accent: '#37743d',
    uiBg: '#e6f0df',
    dark: false,
  },
  mint: {
    bg: '#eaf6f2',
    bgImage:
      'radial-gradient(115% 85% at 100% -10%, rgba(126, 219, 195, 0.38) 0%, rgba(126, 219, 195, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(112, 198, 220, 0.24) 0%, rgba(112, 198, 220, 0) 58%), linear-gradient(165deg, #f3fbf8 0%, #eaf6f1 48%, #e1f1ec 100%)',
    fg: '#1f3833',
    muted: '#52716a',
    highlight: 'rgba(46, 162, 130, 0.26)',
    accent: '#187a60',
    uiBg: '#dfefe8',
    dark: false,
  },
  bee: {
    bg: '#fbf6e7',
    bgImage:
      'radial-gradient(115% 85% at 90% -10%, rgba(252, 208, 100, 0.4) 0%, rgba(252, 208, 100, 0) 55%), radial-gradient(100% 75% at -6% 108%, rgba(238, 178, 82, 0.22) 0%, rgba(238, 178, 82, 0) 58%), linear-gradient(166deg, #fdfbf1 0%, #fbf6e6 48%, #f7efd7 100%)',
    fg: '#3d321e',
    muted: '#7d6b44',
    highlight: 'rgba(226, 170, 60, 0.32)',
    accent: '#946412',
    uiBg: '#f4edd7',
    dark: false,
  },
  night: {
    bg: '#151310',
    fg: '#cfc4b2',
    muted: '#807464',
    highlight: 'rgba(206, 146, 66, 0.3)',
    accent: '#d99a5b',
    uiBg: '#1e1a15',
    dark: true,
  },
  indigo: {
    bg: '#141a26',
    fg: '#c6d1e2',
    muted: '#7d89a0',
    highlight: 'rgba(102, 146, 214, 0.32)',
    accent: '#82a9e2',
    uiBg: '#1b2331',
    dark: true,
  },
  oled: {
    bg: '#000000',
    fg: '#aaa59c',
    muted: '#77726a',
    highlight: 'rgba(196, 150, 84, 0.22)',
    accent: '#c79a5b',
    uiBg: '#0b0b0b',
    dark: true,
  },
  bamboo: {
    bg: '#edf4e6',
    bgImage: svgTile(
      120,
      `<g fill='#37743d' opacity='0.13'><g transform='translate(20 32)'><path d='${BAMBOO_LEAF}' transform='rotate(-32)'/><path d='${BAMBOO_LEAF}' transform='rotate(-4)'/><path d='${BAMBOO_LEAF_SMALL}' transform='rotate(24)'/></g><g transform='translate(88 92) rotate(158)'><path d='${BAMBOO_LEAF}' transform='rotate(-28)'/><path d='${BAMBOO_LEAF}'/><path d='${BAMBOO_LEAF_SMALL}' transform='rotate(26)'/></g><path d='${BAMBOO_LEAF_SMALL}' transform='translate(66 12) rotate(-58)' opacity='0.8'/></g>`,
    ),
    fg: '#2a3526',
    muted: '#5d7055',
    highlight: 'rgba(92, 152, 86, 0.3)',
    accent: '#37743d',
    uiBg: '#e4eedb',
    dark: false,
  },
  ripple: {
    bg: '#e8f1f5',
    bgImage: svgTile(
      132,
      `<g fill='none' stroke='#2c6e8a' stroke-width='1.3'><g opacity='0.12'><circle cx='34' cy='38' r='7'/><circle cx='34' cy='38' r='14'/><circle cx='34' cy='38' r='21'/></g><g opacity='0.1'><circle cx='96' cy='96' r='5'/><circle cx='96' cy='96' r='11'/><circle cx='96' cy='96' r='17'/></g><circle cx='104' cy='22' r='4' opacity='0.1'/><circle cx='14' cy='104' r='3' opacity='0.09'/></g>`,
    ),
    fg: '#24333d',
    muted: '#54697a',
    highlight: 'rgba(60, 130, 165, 0.28)',
    accent: '#2c6e8a',
    uiBg: '#dde9ef',
    dark: false,
  },
  cloud: {
    bg: '#f8f1e2',
    bgImage: svgTile(
      144,
      `<g fill='none' stroke='#946412' stroke-width='1.6' stroke-linecap='round' opacity='0.13'><g transform='translate(46 50)'><path d='${CLOUD_SPIRAL}'/><path d='M-15 -1 C-23 5 -33 5 -40 0'/><path d='M-42 13 L14 13 C21 13 25 10 26 5'/></g><g transform='translate(110 116) scale(0.72)' opacity='0.8'><path d='${CLOUD_SPIRAL}'/><path d='M-15 -1 C-23 5 -33 5 -40 0'/><path d='M-42 13 L14 13 C21 13 25 10 26 5'/></g></g>`,
    ),
    fg: '#3d321e',
    muted: '#7d6b44',
    highlight: 'rgba(226, 170, 60, 0.32)',
    accent: '#946412',
    uiBg: '#f2e9d4',
    dark: false,
  },
  petal: {
    bg: '#f7e9e8',
    bgImage: svgTile(
      128,
      `<g fill='#b06a62'><g transform='translate(38 38)' opacity='0.15'><path d='${SAKURA_PETAL}'/><path d='${SAKURA_PETAL}' transform='rotate(72)'/><path d='${SAKURA_PETAL}' transform='rotate(144)'/><path d='${SAKURA_PETAL}' transform='rotate(216)'/><path d='${SAKURA_PETAL}' transform='rotate(288)'/><circle r='1.8'/></g><path d='${SAKURA_PETAL}' transform='translate(92 26) rotate(42) scale(0.55)' opacity='0.12'/><path d='${SAKURA_PETAL}' transform='translate(102 88) rotate(-30) scale(0.5)' opacity='0.12'/><path d='${SAKURA_PETAL}' transform='translate(56 100) rotate(75) scale(0.45)' opacity='0.11'/></g>`,
    ),
    fg: '#3a2b2a',
    muted: '#876f6b',
    highlight: 'rgba(176, 106, 98, 0.3)',
    accent: '#8d4a44',
    uiBg: '#f1dfdd',
    dark: false,
  },
  lattice: {
    bg: '#edebe5',
    bgImage: svgTile(
      40,
      `<path d='M20 0 L40 20 L20 40 L0 20 Z' fill='none' stroke='#5c6157' stroke-width='1' opacity='0.1'/>`,
    ),
    fg: '#33352f',
    muted: '#6c716b',
    highlight: 'rgba(110, 122, 112, 0.26)',
    accent: '#4d6257',
    uiBg: '#e5e3da',
    dark: false,
  },
  star: {
    bg: '#101725',
    bgImage: svgTile(
      160,
      `<g fill='#c6d1e2'><path d='${STAR_SPARKLE}' transform='translate(30 34)' opacity='0.4'/><path d='${STAR_SPARKLE}' transform='translate(52 18) scale(0.55)' opacity='0.32'/><path d='${STAR_SPARKLE}' transform='translate(120 62) scale(0.7)' opacity='0.35'/><path d='${STAR_SPARKLE}' transform='translate(78 122) scale(0.85)' opacity='0.38'/><path d='${STAR_SPARKLE}' transform='translate(142 132) scale(0.5)' opacity='0.3'/><circle cx='60' cy='48' r='1' opacity='0.3'/><circle cx='96' cy='30' r='0.8' opacity='0.25'/><circle cx='18' cy='92' r='1' opacity='0.3'/><circle cx='48' cy='76' r='0.7' opacity='0.22'/><circle cx='132' cy='18' r='0.9' opacity='0.26'/><circle cx='104' cy='142' r='0.8' opacity='0.24'/><circle cx='14' cy='140' r='0.9' opacity='0.26'/><circle cx='146' cy='92' r='0.7' opacity='0.22'/><circle cx='86' cy='86' r='0.6' opacity='0.2'/></g>`,
    ),
    fg: '#c6d1e2',
    muted: '#7d89a0',
    highlight: 'rgba(102, 146, 214, 0.32)',
    accent: '#82a9e2',
    uiBg: '#171f30',
    dark: true,
  },
  snow: {
    bg: '#eef2f5',
    fg: '#2e343b',
    muted: '#68727e',
    highlight: 'rgba(90, 120, 150, 0.26)',
    accent: '#47617e',
    uiBg: '#e5ebf0',
    dark: false,
  },
  sky: {
    bg: '#e1ebf2',
    fg: '#24313c',
    muted: '#596c7b',
    highlight: 'rgba(70, 120, 155, 0.28)',
    accent: '#35617f',
    uiBg: '#d6e3ec',
    dark: false,
  },
  violet: {
    bg: '#1c1526',
    fg: '#cdc3dd',
    muted: '#847898',
    highlight: 'rgba(160, 130, 200, 0.32)',
    accent: '#b39ddb',
    uiBg: '#251c33',
    dark: true,
  },
  sunset: {
    bg: '#f9ece2',
    bgImage:
      'radial-gradient(115% 85% at 90% -10%, rgba(245, 158, 110, 0.38) 0%, rgba(245, 158, 110, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(214, 120, 140, 0.24) 0%, rgba(214, 120, 140, 0) 58%), linear-gradient(166deg, #fdf4ec 0%, #f9ece2 48%, #f4ddd2 100%)',
    fg: '#402e24',
    muted: '#83655a',
    highlight: 'rgba(226, 140, 90, 0.32)',
    accent: '#a8512c',
    uiBg: '#f3e2d6',
    dark: false,
  },
  ocean: {
    bg: '#e6eef6',
    bgImage:
      'radial-gradient(115% 85% at 92% -10%, rgba(120, 170, 220, 0.36) 0%, rgba(120, 170, 220, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(70, 120, 180, 0.22) 0%, rgba(70, 120, 180, 0) 58%), linear-gradient(165deg, #eef5fb 0%, #e6eef6 48%, #d8e5f1 100%)',
    fg: '#22303e',
    muted: '#546a7e',
    highlight: 'rgba(70, 125, 180, 0.28)',
    accent: '#2f5f92',
    uiBg: '#dbe7f1',
    dark: false,
  },
  wisteria: {
    bg: '#efe9f6',
    bgImage:
      'radial-gradient(115% 85% at 90% -10%, rgba(170, 140, 215, 0.34) 0%, rgba(170, 140, 215, 0) 55%), radial-gradient(100% 75% at -6% 106%, rgba(130, 100, 180, 0.22) 0%, rgba(130, 100, 180, 0) 58%), linear-gradient(165deg, #f5f0fa 0%, #efe9f6 48%, #e4daf0 100%)',
    fg: '#322a40',
    muted: '#6f6482',
    highlight: 'rgba(140, 105, 190, 0.28)',
    accent: '#6a4a94',
    uiBg: '#e7dff2',
    dark: false,
  },
  lotus: {
    bg: '#f2eef1',
    bgImage: svgTile(
      150,
      `<g transform='translate(38 56)'><g fill='#b06a72' opacity='0.18'><path d='${LOTUS_PETAL}' transform='rotate(-58) scale(0.72)'/><path d='${LOTUS_PETAL}' transform='rotate(58) scale(0.72)'/><path d='${LOTUS_PETAL}' transform='rotate(-28) scale(0.88)'/><path d='${LOTUS_PETAL}' transform='rotate(28) scale(0.88)'/><path d='${LOTUS_PETAL}'/></g><path d='M0 2 Q-2 24 -1 50' stroke='#5f7d6a' fill='none' stroke-width='1.4' opacity='0.18'/></g><g transform='translate(94 76)'><path d='M-16 0 Q-12 -7 -7 -5 Q-3 -9 1 -5 Q6 -8 10 -4 Q14 -6 16 0 Q8 4 0 4 Q-8 4 -16 0 Z' fill='#5f7d6a' opacity='0.15'/><path d='M0 4 Q1 16 2 30' stroke='#5f7d6a' fill='none' stroke-width='1.3' opacity='0.16'/></g><g transform='translate(126 90)'><path d='M0 0 C-3 -5 -3 -11 0 -14 C3 -11 3 -5 0 0 Z' transform='scale(0.9)' fill='#b06a72' opacity='0.16'/><path d='M0 1 Q1 10 0 18' stroke='#5f7d6a' fill='none' stroke-width='1.2' opacity='0.16'/></g><g transform='translate(126 75)' opacity='0.22'><path d='M0 0 L5 -3' stroke='#3a3f35' stroke-width='0.9' fill='none'/><ellipse cx='1.6' cy='-2.6' rx='3' ry='1' fill='#3a3f35' transform='rotate(-24 1.6 -2.6)'/><ellipse cx='1.8' cy='-0.6' rx='2.7' ry='0.9' fill='#3a3f35' transform='rotate(18 1.8 -0.6)'/></g><path d='${CRESCENT}' transform='translate(117 25) scale(0.95)' fill='#c9a86a' opacity='0.26'/><g stroke='#5f7d6a' fill='none' stroke-width='1.1' opacity='0.1'><path d='M-4 108 Q12 105 28 108 T60 108 T92 108 T124 108 T156 108'/><path d='M10 116 Q26 113.5 42 116 T74 116 T106 116 T138 116'/><path d='M-4 124 Q12 121.5 28 124 T60 124 T92 124'/></g>`,
    ),
    fg: '#372f35',
    muted: '#7a6f78',
    highlight: 'rgba(176, 106, 114, 0.28)',
    accent: '#96555f',
    uiBg: '#eae4ea',
    dark: false,
  },
  willow: {
    bg: '#f6f1dc',
    bgImage: svgTile(
      160,
      `<defs><path id='wl' d='${WILLOW_LEAF}'/></defs><g stroke='#5e8046' fill='none' stroke-width='1.3' opacity='0.13'><path d='M22 -4 C24 28 34 58 56 84 C70 100 88 110 108 114'/><path d='M70 -4 C72 24 80 50 98 72 C112 88 128 96 146 100'/><path d='M118 -4 C120 20 126 42 140 58 C148 68 154 72 158 74'/></g><g fill='#5e8046' opacity='0.14'><use href='#wl' transform='translate(26 24) rotate(-58)'/><use href='#wl' transform='translate(35 48) rotate(-50) scale(0.9)'/><use href='#wl' transform='translate(46 68) rotate(-60)'/><use href='#wl' transform='translate(60 86) rotate(-46) scale(1.05)'/><use href='#wl' transform='translate(76 99) rotate(-55)'/><use href='#wl' transform='translate(94 108) rotate(-42) scale(0.9)'/><use href='#wl' transform='translate(74 20) rotate(-55) scale(0.95)'/><use href='#wl' transform='translate(82 40) rotate(-48)'/><use href='#wl' transform='translate(92 56) rotate(-58) scale(1.05)'/><use href='#wl' transform='translate(104 72) rotate(-44)'/><use href='#wl' transform='translate(118 84) rotate(-52) scale(0.9)'/><use href='#wl' transform='translate(134 92) rotate(-46)'/><use href='#wl' transform='translate(122 18) rotate(-52) scale(0.9)'/><use href='#wl' transform='translate(130 36) rotate(-58)'/><use href='#wl' transform='translate(140 52) rotate(-46) scale(1.05)'/><use href='#wl' transform='translate(150 62) rotate(-55) scale(0.9)'/></g><g stroke='#5e8046' fill='none' stroke-width='1' opacity='0.06'><path d='M-40 46 Q0 40 40 46 T120 46 T200 46'/><path d='M-40 132 Q0 126 40 132 T120 132 T200 132'/></g><g fill='#2e322a' opacity='0.18'><path d='${SWALLOW}' transform='translate(56 54) rotate(-12) scale(1.05)'/><path d='${SWALLOW}' transform='translate(126 126) rotate(10) scale(0.7)'/></g>`,
    ),
    fg: '#33301f',
    muted: '#6f6845',
    highlight: 'rgba(120, 140, 60, 0.3)',
    accent: '#4a6b35',
    uiBg: '#efe9d0',
    dark: false,
  },
  wheat: {
    bg: '#f7f2e2',
    bgImage: svgTile(
      150,
      `<defs><g id='wg'><path d='${WHEAT_GRAIN}'/><path d='M0 -10 L0.8 -19' fill='none' stroke-width='0.7'/></g><g id='ws'><path d='M0 30 Q1 15 0 0 L0 -34' fill='none' stroke-width='1.2'/><path d='M0 22 Q-10 14 -16 4 Q-9 12 0 18 Z'/><path d='M0 26 Q8 20 13 12 Q7 19 0 22 Z'/><use href='#wg' transform='translate(0 -6) rotate(-32)'/><use href='#wg' transform='translate(0 -6) rotate(32)'/><use href='#wg' transform='translate(0 -13) rotate(-30) scale(0.92)'/><use href='#wg' transform='translate(0 -13) rotate(30) scale(0.92)'/><use href='#wg' transform='translate(0 -20) rotate(-28) scale(0.84)'/><use href='#wg' transform='translate(0 -20) rotate(28) scale(0.84)'/><use href='#wg' transform='translate(0 -27) rotate(-26) scale(0.76)'/><use href='#wg' transform='translate(0 -27) rotate(26) scale(0.76)'/><use href='#wg' transform='translate(0 -33) scale(0.7)'/></g></defs><g stroke='#a8823c' fill='none' stroke-width='1' opacity='0.05'><path d='M-40 26 Q0 20 40 26 T120 26 T200 26'/><path d='M-40 140 Q0 134 40 140 T120 140 T200 140'/></g><g fill='#a8823c' stroke='#a8823c' opacity='0.18'><use href='#ws' transform='translate(30 108) rotate(6) scale(1.25)'/><use href='#ws' transform='translate(80 116) rotate(-3) scale(1.05)'/><use href='#ws' transform='translate(126 100) rotate(9) scale(1.35)'/></g>`,
    ),
    fg: '#3a3320',
    muted: '#7a6c48',
    highlight: 'rgba(176, 138, 62, 0.3)',
    accent: '#8f6d24',
    uiBg: '#f0e9d2',
    dark: false,
  },
}
