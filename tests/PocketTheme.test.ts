import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../src/stores/settings'
import { READER_PALETTES } from '../src/types'

const STORAGE_KEY = 'shusheng.settings.v1'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('口袋模式 OLED 主题', () => {
  it('省电主题使用纯黑 OLED 配色', () => {
    const palette = READER_PALETTES.oled
    expect(palette.bg).toBe('#000000')
    expect(palette.uiBg).toBe('#000000')
    expect(palette.bgImage).toBeUndefined()
    expect(palette.dark).toBe(true)
  })

  it('进入口袋模式只覆盖生效主题，退出后恢复原主题', () => {
    const store = useSettingsStore()
    store.patch({ theme: 'sepia' })

    store.setPocketThemeActive(true)
    expect(store.activeTheme).toBe('oled')
    expect(store.activePalette).toBe(READER_PALETTES.oled)
    expect(store.settings.theme).toBe('sepia')

    store.setPocketThemeActive(false)
    expect(store.activeTheme).toBe('sepia')
    expect(store.activePalette).toBe(READER_PALETTES.sepia)
    expect(store.settings.theme).toBe('sepia')
  })

  it('重复进入不会改写用户主题，退出仍恢复原主题', () => {
    const store = useSettingsStore()
    store.patch({ theme: 'night' })

    store.setPocketThemeActive(true)
    store.setPocketThemeActive(true)
    store.setPocketThemeActive(false)

    expect(store.activeTheme).toBe('night')
    expect(store.settings.theme).toBe('night')
  })

  it('从省电主题进入再退出，仍保持省电主题', () => {
    const store = useSettingsStore()
    store.patch({ theme: 'oled' })

    store.setPocketThemeActive(true)
    expect(store.activeTheme).toBe('oled')
    store.setPocketThemeActive(false)
    expect(store.activeTheme).toBe('oled')
  })

  it('临时覆盖不会把省电主题写入本地设置', async () => {
    const store = useSettingsStore()
    store.patch({ theme: 'sepia' })
    await nextTick()

    store.setPocketThemeActive(true)
    await nextTick()

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').theme).toBe('sepia')
    store.setPocketThemeActive(false)
  })
})