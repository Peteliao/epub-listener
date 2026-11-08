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
  /** Optional layered gradients painted over bg for non-solid themes. */
  bgImage?: string
  fg: string
  muted: string
  highlight: string
  accent: string
  uiBg: string
  /** Dark palettes need dark native controls and a matching status bar. */
  dark: boolean
}

export const READER_THEME_ORDER: ReaderTheme[] = [
  'paper',
  'sepia',
  'green',
  'mist',
  'celadon',
  'rose',
  'forest',
  'mint',
  'bee',
  'night',
  'indigo',
  'oled',
]

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
}

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
    fg: '#2e302c',
    muted: '#6c716b',
    highlight: 'rgba(110, 122, 112, 0.26)',
    accent: '#4d6257',
    uiBg: '#e1e2de',
    dark: false,
  },
  celadon: {
    bg: '#dce8e4',
    fg: '#263531',
    muted: '#5f746e',
    highlight: 'rgba(74, 128, 114, 0.28)',
    accent: '#33675c',
    uiBg: '#d3e1dd',
    dark: false,
  },
  rose: {
    bg: '#f4e6e3',
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
}
