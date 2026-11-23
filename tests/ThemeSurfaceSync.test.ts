import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { computed, ref } from 'vue'
import { bindThemeSurface } from '../src/ui/themeSurface'
import { READER_PALETTES, READER_THEME_ORDER, type ReaderTheme } from '../src/types'

describe('主题表面同步更新', () => {
  let themeColorMeta: HTMLMetaElement | null = null
  let stop: (() => void) | undefined

  beforeEach(() => {
    document.head.innerHTML = ''
    document.documentElement.removeAttribute('style')
    delete document.documentElement.dataset.theme
    themeColorMeta = document.createElement('meta')
    themeColorMeta.name = 'theme-color'
    themeColorMeta.content = READER_PALETTES.paper.bg
    document.head.appendChild(themeColorMeta)
  })

  afterEach(() => {
    stop?.()
    stop = undefined
  })

  it('绑定时立即同步 CSS 变量与 theme-color', () => {
    const theme = ref<ReaderTheme>('night')
    const palette = computed(() => READER_PALETTES[theme.value])

    stop = bindThemeSurface(
      () => palette.value,
      () => theme.value,
    )

    const root = document.documentElement
    expect(root.style.getPropertyValue('--app-bg')).toBe(READER_PALETTES.night.bg)
    expect(root.style.getPropertyValue('--status-bar-bg')).toBe(
      READER_PALETTES.night.bg,
    )
    expect(root.style.getPropertyValue('--app-fg')).toBe(READER_PALETTES.night.fg)
    expect(root.style.colorScheme).toBe('dark')
    expect(root.dataset.theme).toBe('night')
    expect(themeColorMeta?.content).toBe(READER_PALETTES.night.bg)
  })

  it('换主题时无需等待 Vue tick，状态栏颜色同步落盘', () => {
    const theme = ref<ReaderTheme>('paper')
    const palette = computed(() => READER_PALETTES[theme.value])

    stop = bindThemeSurface(
      () => palette.value,
      () => theme.value,
    )

    theme.value = 'night'

    const root = document.documentElement
    expect(themeColorMeta?.content).toBe(READER_PALETTES.night.bg)
    expect(root.style.getPropertyValue('--app-bg')).toBe(READER_PALETTES.night.bg)
    expect(root.style.getPropertyValue('--status-bar-bg')).toBe(
      READER_PALETTES.night.bg,
    )
    expect(root.dataset.theme).toBe('night')
  })

  it('口袋模式强制 OLED 与退出恢复都同步反映到状态栏', () => {
    const chosenTheme = ref<ReaderTheme>('sepia')
    const pocketMode = ref(false)
    const activeTheme = computed<ReaderTheme>(() =>
      pocketMode.value ? 'oled' : chosenTheme.value,
    )
    const palette = computed(() => READER_PALETTES[activeTheme.value])

    stop = bindThemeSurface(
      () => palette.value,
      () => activeTheme.value,
    )

    pocketMode.value = true
    expect(themeColorMeta?.content).toBe('#000000')
    expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe(
      '#000000',
    )
    expect(
      document.documentElement.style.getPropertyValue('--status-bar-bg'),
    ).toBe('#000000')
    expect(
      document.documentElement.style.getPropertyValue('--app-bg-image'),
    ).toBe('none')
    expect(document.documentElement.dataset.theme).toBe('oled')

    pocketMode.value = false
    expect(themeColorMeta?.content).toBe(READER_PALETTES.sepia.bg)
    expect(
      document.documentElement.style.getPropertyValue('--status-bar-bg'),
    ).toBe(READER_PALETTES.sepia.bg)
    expect(document.documentElement.dataset.theme).toBe('sepia')
    expect(chosenTheme.value).toBe('sepia')
  })

  it('图案主题同时保留背景图与面板纹理变量', () => {
    const theme = ref<ReaderTheme>('bamboo')
    const palette = computed(() => READER_PALETTES[theme.value])

    stop = bindThemeSurface(
      () => palette.value,
      () => theme.value,
    )

    const root = document.documentElement
    expect(root.style.getPropertyValue('--app-bg-image')).toBe(
      READER_PALETTES.bamboo.bgImage,
    )
    expect(root.style.getPropertyValue('--app-pattern')).toBe(
      READER_PALETTES.bamboo.bgImage,
    )
    expect(root.style.getPropertyValue('--status-bar-bg')).toBe(
      READER_PALETTES.bamboo.bg,
    )
  })

  it('所有主题的状态栏变量都是与 theme-color 一致的纯色', () => {
    const theme = ref<ReaderTheme>('paper')
    const palette = computed(() => READER_PALETTES[theme.value])

    stop = bindThemeSurface(
      () => palette.value,
      () => theme.value,
    )

    for (const next of READER_THEME_ORDER) {
      theme.value = next
      const statusBarBg = document.documentElement.style.getPropertyValue(
        '--status-bar-bg',
      )
      expect(statusBarBg).toBe(READER_PALETTES[next].bg)
      expect(themeColorMeta?.content).toBe(statusBarBg)
      expect(statusBarBg).not.toContain('gradient')
      expect(statusBarBg).not.toContain('url(')
    }
  })

  it('缺失 theme-color 时仍可更新页面变量且不抛错', () => {
    themeColorMeta?.remove()
    const theme = ref<ReaderTheme>('paper')
    const palette = computed(() => READER_PALETTES[theme.value])

    expect(() => {
      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )
    }).not.toThrow()

    expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe(
      READER_PALETTES.paper.bg,
    )
    expect(
      document.documentElement.style.getPropertyValue('--status-bar-bg'),
    ).toBe(READER_PALETTES.paper.bg)
  })

  describe('iOS 主屏幕独立模式', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'standalone', {
        configurable: true,
        value: true,
      })
    })

    afterEach(() => {
      delete (navigator as Navigator & { standalone?: boolean }).standalone
    })

    it('index.html 声明固定白色系统图标', () => {
      const html = readFileSync('index.html', 'utf8')
      expect(html).toContain(
        'name="apple-mobile-web-app-status-bar-style" content="black-translucent"',
      )
    })

    it('浅色主题用墨色表面承托白色图标，页面背景保持不变', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe(READER_PALETTES.paper.fg)
      expect(themeColorMeta?.content).toBe(READER_PALETTES.paper.fg)
      expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe(
        READER_PALETTES.paper.bg,
      )
    })

    it('所有主题的状态栏表面都保持深色可读', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      for (const next of READER_THEME_ORDER) {
        theme.value = next
        const nextPalette = READER_PALETTES[next]
        const expected = nextPalette.dark ? nextPalette.bg : nextPalette.fg
        expect(
          document.documentElement.style.getPropertyValue('--status-bar-bg'),
        ).toBe(expected)
        expect(themeColorMeta?.content).toBe(expected)
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe(
          nextPalette.bg,
        )
      }
    })

    it('口袋模式为纯黑，退出后恢复原主题的深色状态栏表面', () => {
      const theme = ref<ReaderTheme>('sky')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe(READER_PALETTES.sky.fg)

      theme.value = 'oled'
      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe('#000000')
      expect(themeColorMeta?.content).toBe('#000000')

      theme.value = 'sky'
      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe(READER_PALETTES.sky.fg)
      expect(themeColorMeta?.content).toBe(READER_PALETTES.sky.fg)
    })
  })
})