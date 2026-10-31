import type { VoiceOption, VoiceQuality } from '@/types'

export interface IOSDeviceSnapshot {
  userAgent: string
  platform: string
  maxTouchPoints: number
}

export function isIOSDevice(snapshot?: Partial<IOSDeviceSnapshot>): boolean {
  const navigatorRef = typeof navigator === 'undefined' ? null : navigator
  const userAgent = snapshot?.userAgent ?? navigatorRef?.userAgent ?? ''
  const platform = snapshot?.platform ?? navigatorRef?.platform ?? ''
  const maxTouchPoints =
    snapshot?.maxTouchPoints ?? navigatorRef?.maxTouchPoints ?? 0

  if (/iPhone|iPod/i.test(userAgent)) return true
  if (/iPad/i.test(userAgent)) return true

  // iPadOS 13+ reports a desktop Mac UA; touch points tell it apart from a Mac.
  return (
    /Macintosh|MacIntel/i.test(`${platform} ${userAgent}`) && maxTouchPoints > 1
  )
}

export function normalizeVoiceLang(lang: string): string {
  return String(lang || '').replace(/_/g, '-')
}

export function isChineseVoice(lang: string): boolean {
  return normalizeVoiceLang(lang).toLowerCase().startsWith('zh')
}

export function isEnglishVoice(lang: string): boolean {
  return normalizeVoiceLang(lang).toLowerCase().startsWith('en')
}

export function detectVoiceQuality(
  name: string,
  voiceURI: string,
): VoiceQuality {
  const signature = `${name} ${voiceURI}`.toLowerCase()
  if (/(premium|enhanced)/.test(signature)) return 'enhanced'
  if (/(compact|eloquence)/.test(signature)) return 'standard'
  return 'unknown'
}

// Apple lists these alongside real voices. Picking one turns a sentence into a
// whisper, a bell or a cartoon character, so keep them out of auto-selection.
const NOVELTY_VOICES = new Set([
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'deranged',
  'fred',
  'good news',
  'hysterical',
  'jester',
  'junior',
  'organ',
  'pipe organ',
  'ralph',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
  'eddy',
  'flo',
  'grandma',
  'grandpa',
  'reed',
  'rocko',
  'sandy',
  'shelley',
])

export function isNoveltyVoice(name: string, voiceURI: string): boolean {
  const signature = `${name} ${voiceURI}`.toLowerCase()
  if (signature.includes('eloquence')) return true
  const baseName = name.replace(/\s*\(.*$/, '').trim().toLowerCase()
  return NOVELTY_VOICES.has(baseName)
}

function languageRank(lang: string): number {
  const normalized = normalizeVoiceLang(lang).toLowerCase()
  if (normalized === 'zh-cn' || normalized.startsWith('zh-hans')) return 0
  if (normalized === 'zh-tw' || normalized.startsWith('zh-hant')) return 1
  if (normalized === 'zh-hk' || normalized === 'zh-mo') return 2
  return 3
}

const QUALITY_RANK: Record<VoiceQuality, number> = {
  enhanced: 0,
  unknown: 1,
  standard: 2,
}

// "unknown" is where Apple's legacy novelty and character voices land, while
// its real English voices ship as compact or Siri bundles. Unlike Chinese,
// where an unknown local voice may be a user download, English auto-selection
// must prefer the declared system voices.
const ENGLISH_QUALITY_RANK: Record<VoiceQuality, number> = {
  enhanced: 0,
  standard: 1,
  unknown: 2,
}

function englishLanguageRank(lang: string): number {
  const normalized = normalizeVoiceLang(lang).toLowerCase()
  if (normalized === 'en-us') return 0
  if (normalized === 'en-gb') return 1
  if (normalized === 'en') return 2
  if (normalized.startsWith('en-')) return 3
  return 4
}

export function compareEnglishVoices(a: VoiceOption, b: VoiceOption): number {
  const langDiff = englishLanguageRank(a.lang) - englishLanguageRank(b.lang)
  if (langDiff !== 0) return langDiff

  // The reader is used offline; a remote "enhanced" voice is silent there.
  if (a.local !== b.local) return a.local ? -1 : 1

  const qualityDiff =
    ENGLISH_QUALITY_RANK[a.quality] - ENGLISH_QUALITY_RANK[b.quality]
  if (qualityDiff !== 0) return qualityDiff

  return a.name.localeCompare(b.name, 'en-US')
}

export function compareSystemVoices(a: VoiceOption, b: VoiceOption): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1

  const langDiff = languageRank(a.lang) - languageRank(b.lang)
  if (langDiff !== 0) return langDiff

  const qualityDiff = QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality]
  if (qualityDiff !== 0) return qualityDiff

  if (a.local !== b.local) return a.local ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN')
}
