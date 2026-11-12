import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../src/stores/settings'
import { DEFAULT_SETTINGS } from '../src/types'

const STORAGE_KEY = 'shusheng.settings.v1'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('shusheng.settings.v1 平滑迁移', () => {
  it('旧配置缺少 preferChineseOffline 时取默认开启，其余字段不丢', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        engine: 'sherpa',
        aiVoiceId: 'shanlan',
        groupSentences: true,
        englishAi: false,
        pausePreset: 'relaxed',
        rate: 1.4,
      }),
    )
    const store = useSettingsStore()
    expect(store.settings.preferChineseOffline).toBe(true)
    expect(store.settings.engine).toBe('sherpa')
    expect(store.settings.englishAi).toBe(false)
    expect(store.settings.pausePreset).toBe('relaxed')
    expect(store.settings.rate).toBe(1.4)
  })

  it('显式关闭的开关在重载后保留', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, preferChineseOffline: false }),
    )
    expect(useSettingsStore().settings.preferChineseOffline).toBe(false)
  })

  it('非法值回退到默认值，不写入脏数据', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, preferChineseOffline: 'yes' }),
    )
    expect(useSettingsStore().settings.preferChineseOffline).toBe(true)
  })

  it('patch 与 reset 都经过 sanitize，开关可逆', () => {
    const store = useSettingsStore()
    expect(store.settings.preferChineseOffline).toBe(true)
    store.patch({ preferChineseOffline: false })
    expect(store.settings.preferChineseOffline).toBe(false)
    store.reset()
    expect(store.settings.preferChineseOffline).toBe(true)
  })
})
