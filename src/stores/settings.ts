import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_SETTINGS,
  READER_PALETTES,
  READER_THEME_ORDER,
  type PausePreset,
  type ReaderSettings,
  type ReaderTheme,
  type TtsEngine,
} from '@/types'

const STORAGE_KEY = 'shusheng.settings.v1'
const ENGINES: TtsEngine[] = ['system', 'sherpa']
const PAUSE_PRESETS: PausePreset[] = ['compact', 'standard', 'relaxed']

function sanitize(raw: unknown): ReaderSettings {
  const source =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  const theme = READER_THEME_ORDER.includes(source.theme as ReaderTheme)
    ? (source.theme as ReaderTheme)
    : DEFAULT_SETTINGS.theme

  const fontSize =
    typeof source.fontSize === 'number' && Number.isFinite(source.fontSize)
      ? Math.min(28, Math.max(14, Math.round(source.fontSize)))
      : DEFAULT_SETTINGS.fontSize

  const rate =
    typeof source.rate === 'number' && Number.isFinite(source.rate)
      ? Math.min(2, Math.max(0.5, Math.round(source.rate * 10) / 10))
      : DEFAULT_SETTINGS.rate

  const voiceURI =
    typeof source.voiceURI === 'string' && source.voiceURI ? source.voiceURI : null

  const englishVoiceURI =
    typeof source.englishVoiceURI === 'string' && source.englishVoiceURI
      ? source.englishVoiceURI
      : null

  const englishVolume =
    typeof source.englishVolume === 'number' &&
    Number.isFinite(source.englishVolume)
      ? Math.min(1.2, Math.max(0.6, Math.round(source.englishVolume * 20) / 20))
      : DEFAULT_SETTINGS.englishVolume

  const englishRate =
    typeof source.englishRate === 'number' && Number.isFinite(source.englishRate)
      ? Math.min(1.4, Math.max(0.6, Math.round(source.englishRate * 10) / 10))
      : DEFAULT_SETTINGS.englishRate

  const autoScroll =
    typeof source.autoScroll === 'boolean'
      ? source.autoScroll
      : DEFAULT_SETTINGS.autoScroll

  const engine = ENGINES.includes(source.engine as TtsEngine)
    ? (source.engine as TtsEngine)
    : DEFAULT_SETTINGS.engine

  const aiVoiceId =
    typeof source.aiVoiceId === 'string' && source.aiVoiceId
      ? source.aiVoiceId
      : DEFAULT_SETTINGS.aiVoiceId

  const englishAi =
    typeof source.englishAi === 'boolean'
      ? source.englishAi
      : DEFAULT_SETTINGS.englishAi

  const autoBookPolyphones =
    typeof source.autoBookPolyphones === 'boolean'
      ? source.autoBookPolyphones
      : DEFAULT_SETTINGS.autoBookPolyphones

  const groupSentences =
    typeof source.groupSentences === 'boolean'
      ? source.groupSentences
      : DEFAULT_SETTINGS.groupSentences

  const skipEnglishWhenLocked =
    typeof source.skipEnglishWhenLocked === 'boolean'
      ? source.skipEnglishWhenLocked
      : DEFAULT_SETTINGS.skipEnglishWhenLocked

  const pausePreset = PAUSE_PRESETS.includes(source.pausePreset as PausePreset)
    ? (source.pausePreset as PausePreset)
    : DEFAULT_SETTINGS.pausePreset

  const labNoiseScale =
    typeof source.labNoiseScale === 'number' && Number.isFinite(source.labNoiseScale)
      ? Math.min(1.5, Math.max(0.1, Math.round(source.labNoiseScale * 1000) / 1000))
      : null

  const labSilenceScale =
    typeof source.labSilenceScale === 'number' &&
    Number.isFinite(source.labSilenceScale)
      ? Math.min(1.5, Math.max(0.5, Math.round(source.labSilenceScale * 100) / 100))
      : DEFAULT_SETTINGS.labSilenceScale

  return {
    theme,
    fontSize,
    rate,
    voiceURI,
    englishVoiceURI,
    englishVolume,
    englishRate,
    autoScroll,
    engine,
    aiVoiceId,
    englishAi,
    autoBookPolyphones,
    groupSentences,
    skipEnglishWhenLocked,
    pausePreset,
    labNoiseScale,
    labSilenceScale,
  }
}

function loadSettings(): ReaderSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<ReaderSettings>(loadSettings())
  const palette = computed(() => READER_PALETTES[settings.value.theme])

  function patch(partial: Partial<ReaderSettings>): void {
    settings.value = sanitize({ ...settings.value, ...partial })
  }

  function reset(): void {
    settings.value = { ...DEFAULT_SETTINGS }
  }

  watch(
    settings,
    (value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // Private browsing may reject writes; settings stay in memory.
      }
    },
    { deep: true },
  )

  return { settings, palette, patch, reset }
})
