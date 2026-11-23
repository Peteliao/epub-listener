import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../src/stores/settings'
import { bindThemeSurface } from '../src/ui/themeSurface'
import { READER_PALETTES } from '../src/types'

const STORAGE_KEY = 'shusheng.settings.v1'
const POCKET_RETURN_KEY = 'shusheng.pocket-return-theme.v1'

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

  it('进入口袋模式切换到省电主题，退出后恢复原主题', () => {
    const store = useSettingsStore()
    store.patch({ theme: 'sepia' })

    store.setPocketThemeActive(true)
    expect(store.activeTheme).toBe('oled')
    expect(store.activePalette).toBe(READER_PALETTES.oled)
    expect(store.settings.theme).toBe('oled')

    store.setPocketThemeActive(false)
    expect(store.activeTheme).toBe('sepia')
    expect(store.activePalette).toBe(READER_PALETTES.sepia)
    expect(store.settings.theme).toBe('sepia')
  })

  it('重复进入不会丢失退出时要恢复的主题', () => {
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

  it('口袋模式期间持久化省电主题，退出后写回原主题', async () => {
    const store = useSettingsStore()
    store.patch({ theme: 'sepia' })
    await nextTick()

    store.setPocketThemeActive(true)
    await nextTick()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').theme).toBe('oled')
    expect(localStorage.getItem(POCKET_RETURN_KEY)).toBe('sepia')

    store.setPocketThemeActive(false)
    await nextTick()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').theme).toBe('sepia')
    expect(localStorage.getItem(POCKET_RETURN_KEY)).toBeNull()
  })

  it('口袋模式中应用被杀后，下次加载恢复原主题', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'oled' }))
    localStorage.setItem(POCKET_RETURN_KEY, 'night')

    const store = useSettingsStore()

    expect(store.activeTheme).toBe('night')
    expect(store.settings.theme).toBe('night')
    expect(localStorage.getItem(POCKET_RETURN_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').theme).toBe('night')
  })

  it('口袋模式切换会同步把 theme-color 改为纯黑并在退出后恢复', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)

    const store = useSettingsStore()
    store.patch({ theme: 'sepia' })
    const stop = bindThemeSurface(
      () => store.activePalette,
      () => store.activeTheme,
    )

    store.setPocketThemeActive(true)
    expect(meta.content).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--status-bar-bg')).toBe(
      '#000000',
    )

    store.setPocketThemeActive(false)
    expect(meta.content).toBe(READER_PALETTES.sepia.bg)
    expect(document.documentElement.style.getPropertyValue('--status-bar-bg')).toBe(
      READER_PALETTES.sepia.bg,
    )

    stop()
    meta.remove()
  })
})
