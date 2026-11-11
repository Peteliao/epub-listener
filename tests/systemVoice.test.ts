import { describe, expect, it } from 'vitest'
import {
  compareEnglishVoices,
  compareSystemVoices,
  detectVoiceQuality,
  isChineseVoice,
  isEnglishVoice,
  isIOSDevice,
  isNoveltyVoice,
  normalizeVoiceLang,
} from '../src/core/tts/systemVoice'
import type { VoiceOption } from '../src/types'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

function voice(partial: Partial<VoiceOption>): VoiceOption {
  return {
    uri: 'voice',
    name: 'Voice',
    lang: 'zh-CN',
    local: true,
    isDefault: false,
    quality: 'unknown',
    ...partial,
  }
}

describe('isIOSDevice', () => {
  it('detects iPhone and iPad browsers', () => {
    expect(
      isIOSDevice({
        userAgent: IPHONE_UA,
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
    expect(
      isIOSDevice({
        userAgent: IPAD_UA,
        platform: 'iPad',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
  })

  it('detects iPadOS desktop mode through touch points', () => {
    expect(
      isIOSDevice({
        userAgent: MAC_UA,
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true)
  })

  it('rejects macOS, Android and unknown environments', () => {
    expect(
      isIOSDevice({
        userAgent: MAC_UA,
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false)
    expect(
      isIOSDevice({
        userAgent: ANDROID_UA,
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      }),
    ).toBe(false)
    expect(
      isIOSDevice({ userAgent: '', platform: '', maxTouchPoints: 0 }),
    ).toBe(false)
  })
})

describe('system voice metadata', () => {
  it('normalises language tags and filters Chinese voices', () => {
    expect(normalizeVoiceLang('zh_CN')).toBe('zh-CN')
    expect(isChineseVoice('zh_CN')).toBe(true)
    expect(isChineseVoice('zh-Hans-CN')).toBe(true)
    expect(isChineseVoice('en-US')).toBe(false)
  })

  it('detects enhanced and compact voice bundles', () => {
    expect(
      detectVoiceQuality('Ting-Ting', 'com.apple.ttsbundle.Ting-Ting-premium'),
    ).toBe('enhanced')
    expect(
      detectVoiceQuality('Mei-Jia (Enhanced)', 'com.apple.voice.enhanced.zh-TW'),
    ).toBe('enhanced')
    expect(
      detectVoiceQuality('Ting-Ting', 'com.apple.ttsbundle.Ting-Ting-compact'),
    ).toBe('standard')
    expect(detectVoiceQuality('Ting-Ting', 'com.apple.ttsbundle.Ting-Ting')).toBe(
      'unknown',
    )
  })

  it('recognises English voices', () => {
    expect(isEnglishVoice('en_US')).toBe(true)
    expect(isEnglishVoice('en-GB')).toBe(true)
    expect(isEnglishVoice('zh-CN')).toBe(false)
    expect(isEnglishVoice('')).toBe(false)
  })

  it('filters Apple novelty and character voices', () => {
    expect(
      isNoveltyVoice('Albert', 'com.apple.speech.synthesis.voice.Albert'),
    ).toBe(true)
    expect(
      isNoveltyVoice('Bells', 'com.apple.speech.synthesis.voice.Bells'),
    ).toBe(true)
    expect(isNoveltyVoice('Grandma', 'com.apple.eloquence.en-US.Grandma')).toBe(
      true,
    )
    expect(
      isNoveltyVoice('Samantha', 'com.apple.voice.compact.en-US.Samantha'),
    ).toBe(false)
    expect(
      isNoveltyVoice('Aaron', 'com.apple.ttsbundle.siri_Aaron_en-US_compact'),
    ).toBe(false)
  })
})

describe('compareEnglishVoices', () => {
  it('prefers en-US, offline-capable and enhanced voices', () => {
    const voices = [
      voice({ name: 'British', lang: 'en-GB' }),
      voice({ name: 'Australian', lang: 'en-AU' }),
      voice({ name: 'Compact', lang: 'en-US', quality: 'standard' }),
      voice({ name: 'Remote', lang: 'en-US', quality: 'enhanced', local: false }),
      voice({ name: 'Enhanced', lang: 'en-US', quality: 'enhanced' }),
    ]
    expect(voices.sort(compareEnglishVoices).map((item) => item.name)).toEqual([
      'Enhanced',
      'Compact',
      'Remote',
      'British',
      'Australian',
    ])
  })

  it('prefers a declared system voice over a legacy unknown voice', () => {
    const voices = [
      voice({ name: 'Kathy', lang: 'en-US', quality: 'unknown' }),
      voice({ name: 'Samantha', lang: 'en-US', quality: 'standard' }),
    ]
    expect(voices.sort(compareEnglishVoices).map((item) => item.name)).toEqual([
      'Samantha',
      'Kathy',
    ])
  })
})

describe('compareSystemVoices', () => {
  it('prefers the system default voice first', () => {
    const voices = [
      voice({ name: 'A', lang: 'zh-CN', quality: 'enhanced' }),
      voice({ name: 'B', lang: 'zh-TW', isDefault: true }),
    ]
    expect(voices.sort(compareSystemVoices)[0]?.name).toBe('B')
  })

  it('prefers Mandarin, enhanced quality and local voices', () => {
    const voices = [
      voice({ name: 'Cantonese', lang: 'zh-HK', quality: 'enhanced' }),
      voice({ name: 'Compact', lang: 'zh-CN', quality: 'standard' }),
      voice({ name: 'Remote', lang: 'zh-CN', quality: 'unknown', local: false }),
      voice({ name: 'Local', lang: 'zh-CN', quality: 'unknown', local: true }),
      voice({ name: 'Enhanced', lang: 'zh-CN', quality: 'enhanced' }),
    ]
    expect(voices.sort(compareSystemVoices).map((item) => item.name)).toEqual([
      'Enhanced',
      'Local',
      'Remote',
      'Compact',
      'Cantonese',
    ])
  })
})
