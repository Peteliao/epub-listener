import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

    it('index.html 不锁定状态栏样式，交由 iOS 从页面背景取色', () => {
      const html = readFileSync('index.html', 'utf8')
      expect(html).not.toMatch(
        /name=["']apple-mobile-web-app-status-bar-style["']/,
      )
    })

    it('口袋模式把 html、body 与 #app 的页面底色一起刷黑', () => {
      const css = readFileSync('src/styles/main.css', 'utf8')
      expect(css).toMatch(
        /html\.pocket-lock,\s*html\.pocket-lock body,\s*html\.pocket-lock #app\s*\{\s*background: #000 !important;\s*\}/,
      )
    })

    it('浅色主题的状态栏表面与页面背景一致', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe(READER_PALETTES.paper.bg)
      expect(themeColorMeta?.content).toBe(READER_PALETTES.paper.bg)
      expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe(
        READER_PALETTES.paper.bg,
      )
    })

    it('所有主题的状态栏表面都等于主题背景', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      for (const next of READER_THEME_ORDER) {
        theme.value = next
        const nextPalette = READER_PALETTES[next]
        expect(
          document.documentElement.style.getPropertyValue('--status-bar-bg'),
        ).toBe(nextPalette.bg)
        expect(themeColorMeta?.content).toBe(nextPalette.bg)
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe(
          nextPalette.bg,
        )
      }
    })

    it('口袋模式为纯黑，退出后恢复原主题背景', () => {
      const theme = ref<ReaderTheme>('sky')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe(READER_PALETTES.sky.bg)

      theme.value = 'oled'
      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe('#000000')
      expect(themeColorMeta?.content).toBe('#000000')

      theme.value = 'sky'
      expect(
        document.documentElement.style.getPropertyValue('--status-bar-bg'),
      ).toBe(READER_PALETTES.sky.bg)
      expect(themeColorMeta?.content).toBe(READER_PALETTES.sky.bg)
    })
  })

  describe('Safari 26 状态栏取色', () => {
    let frames: FrameRequestCallback[]
    let writes: string[]

    beforeEach(() => {
      frames = []
      writes = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      })
      const meta = themeColorMeta as HTMLMetaElement
      const setAttribute = meta.setAttribute.bind(meta)
      vi.spyOn(meta, 'setAttribute').mockImplementation((name, value) => {
        if (name === 'content') writes.push(String(value))
        setAttribute(name, value)
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      document.body.removeAttribute('style')
    })

    function flushFrames(): void {
      let rounds = 0
      while (frames.length > 0 && rounds < 12) {
        const pending = frames
        frames = []
        for (const callback of pending) callback(0)
        rounds += 1
      }
    }

    /** jsdom normalises inline colours to rgb(). */
    function rgb(hex: string): string {
      const value = hex.replace('#', '')
      return `rgb(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(
        value.slice(2, 4),
        16,
      )}, ${Number.parseInt(value.slice(4, 6), 16)})`
    }

    it('换主题时先落目标色，再用相邻色值唤醒观察器后还原', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])
      const meta = themeColorMeta as HTMLMetaElement

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      theme.value = 'night'
      expect(meta.content).toBe(READER_PALETTES.night.bg)

      flushFrames()

      expect(writes).toContain(`${READER_PALETTES.night.bg}fe`)
      expect(meta.content).toBe(READER_PALETTES.night.bg)
    })

    it('口袋模式的纯黑同样先落盘再唤醒观察器', () => {
      const theme = ref<ReaderTheme>('sepia')
      const palette = computed(() => READER_PALETTES[theme.value])
      const meta = themeColorMeta as HTMLMetaElement

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      theme.value = 'oled'
      expect(meta.content).toBe('#000000')
      expect(document.body.style.backgroundColor).toBe(rgb('#000000'))

      flushFrames()

      expect(writes).toContain('#000000fe')
      expect(meta.content).toBe('#000000')
    })

    it('连续切换主题不会被上一轮的还原写回旧色', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])
      const meta = themeColorMeta as HTMLMetaElement

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      theme.value = 'night'
      theme.value = 'oled'
      flushFrames()

      expect(meta.content).toBe('#000000')
      expect(
        writes.filter((value) => value === READER_PALETTES.night.bg),
      ).toHaveLength(1)
    })

    it('body 的内联背景色跟随主题，供 Safari 工具条采样', () => {
      const theme = ref<ReaderTheme>('paper')
      const palette = computed(() => READER_PALETTES[theme.value])

      stop = bindThemeSurface(
        () => palette.value,
        () => theme.value,
      )

      expect(document.body.style.backgroundColor).toBe(
        rgb(READER_PALETTES.paper.bg),
      )

      theme.value = 'sepia'
      expect(document.body.style.backgroundColor).toBe(
        rgb(READER_PALETTES.sepia.bg),
      )
    })

    it('顶部色条内联写入背景色、位于所有弹层之上且高度满足采样阈值', () => {
      const app = readFileSync('src/App.vue', 'utf8')
      expect(app).toMatch(
        /:style="\{ backgroundColor: settingsStore\.activePalette\.bg \}"/,
      )
      expect(app).toMatch(
        /\.status-surface \{[\s\S]*?z-index: 130;[\s\S]*?background-color: var\(--status-bar-bg, var\(--app-bg\)\);/,
      )
      expect(app).toMatch(/env\(safe-area-inset-top, 0px\) \+ 12px/)
    })

    it('index.html 保留 theme-color 作为唤醒观察器的把手', () => {
      const html = readFileSync('index.html', 'utf8')
      expect(html).toMatch(
        /<meta name="theme-color" content="#[0-9a-f]{6}" \/>/,
      )
    })
  })
})