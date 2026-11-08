import { driver, type DriveStep, type Driver, type PopoverDOM } from 'driver.js'
import 'driver.js/dist/driver.css'
import '@/styles/tour.css'

export const LIBRARY_TOUR_KEY = 'shusheng.tour.library.v1'
export const READER_TOUR_KEY = 'shusheng.tour.reader.v1'

export function tourSeen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function markTour(key: string, status: 'done' | 'skipped'): void {
  try {
    window.localStorage.setItem(key, status)
  } catch {
    // Private browsing may reject writes; the tour stays dismissible.
  }
}

let active: Driver | null = null

export function stopTour(): void {
  const current = active
  active = null
  if (current?.isActive()) current.destroy()
}

function renderChrome(popover: PopoverDOM): void {
  popover.closeButton.textContent = '跳过'
  popover.footer.appendChild(popover.closeButton)
}

export function buildLibrarySteps(options: {
  hasStats: boolean
  hasBooks: boolean
}): DriveStep[] {
  const steps: DriveStep[] = [
    {
      popover: {
        title: '欢迎来到书声',
        description:
          '把电子书读给你听：导入一本电子书，点按播放，逐句高亮跟着读。书籍与进度只保存在本机。',
        nextBtnText: '开始引导',
        align: 'center',
      },
    },
    {
      element: '[data-tour="import"]',
      popover: {
        title: '导入电子书',
        description:
          '支持 EPUB、FB2、MOBI、AZW3 与 TXT。文件不上传服务器，只留在你的设备里。',
        side: 'bottom',
        align: 'start',
      },
    },
    {
      element: '[data-tour="sample"]',
      popover: {
        title: '没有书？先听样书',
        description: '原创样书《山间来信》一键打开，立刻体验逐句朗读与同步高亮。',
        side: 'bottom',
        align: 'start',
      },
    },
    {
      element: '[data-tour="shelf"]',
      popover: {
        title: '书架与进度',
        description: '导入或听过的书都会出现在这里，进度自动保存，随时接着听。',
        side: 'top',
        align: 'start',
      },
    },
  ]

  if (options.hasStats) {
    steps.push({
      element: '[data-tour="stats"]',
      skipMissingElement: true,
      popover: {
        title: '听书统计',
        description: '累计时长、连续收听天数都在这里，还能生成分享卡。',
        side: 'bottom',
        align: 'start',
      },
    })
  }

  steps.push(
    {
      element: '[data-tour="help"]',
      popover: {
        title: '随时重看引导',
        description: '跳过或看完之后，点这个按钮就能重新打开新手引导。',
        side: 'bottom',
        align: 'end',
      },
    },
    {
      popover: {
        title: '开始听书吧',
        description: '打开一本书，阅读器里还有播放器的分步引导等着你。',
        doneBtnText: options.hasBooks ? '打开最近的书' : '打开样书试试',
        align: 'center',
      },
    },
  )

  return steps
}

export function buildReaderSteps(isPlaying: () => boolean): DriveStep[] {
  return [
    {
      element: '[data-tour="play"]',
      advanceOnClick: true,
      disableActiveInteraction: false,
      popover: {
        title: '开始朗读',
        description:
          '点按播放键开始听书，再点一次暂停；锁屏或切到后台也能继续听。现在就点它试试。',
        side: 'top',
        align: 'center',
      },
    },
    {
      element: '[data-tour="stage"]',
      popover: {
        title: '正文就是遥控器',
        description: '轻点任意句子，从那里开始朗读；暂停时，正文两侧会出现翻页按钮。',
        align: 'center',
      },
    },
    {
      element: '[data-tour="appearance"]',
      popover: {
        title: '阅读外观',
        description: '切换主题、调节字号，夜里听书不刺眼。',
        side: 'top',
        align: 'start',
      },
    },
    {
      element: '[data-tour="pace"]',
      popover: {
        title: '语速与口袋模式',
        description: '点数字调节 0.5–2 倍语速；点月亮进入口袋模式，熄屏安心听。',
        side: 'top',
        align: 'end',
      },
    },
    {
      element: '[data-tour="toc"]',
      popover: {
        title: '目录',
        description: '一键跳到想听的章节。',
        side: 'bottom',
        align: 'end',
      },
    },
    {
      element: '[data-tour="sleep"]',
      popover: {
        title: '定时关闭',
        description: '睡前听书：设个倒计时或定点时间，到点自动暂停。',
        side: 'bottom',
        align: 'end',
      },
    },
    {
      element: '[data-tour="settings"]',
      popover: {
        title: '音色与更多设置',
        description:
          '切换系统语音或离线 AI 音色、下载音色包；「新手引导」也能在这里随时重看。',
        side: 'bottom',
        align: 'end',
      },
    },
    {
      popover: {
        title: '开始听书吧',
        description:
          '引导随时可在「阅读设置 → 新手引导」重新打开。现在，让书声读给你听。',
        doneBtnText: '开始听书',
        align: 'center',
        onPopoverRender: (popover) => {
          renderChrome(popover)
          popover.nextButton.textContent = isPlaying() ? '继续听书' : '开始听书'
        },
      },
    },
  ]
}

type TourOptions = {
  storageKey: string
  steps: DriveStep[]
  onFinish?: () => void
}

function runTour({ storageKey, steps, onFinish }: TourOptions): void {
  stopTour()
  // driver.js skips onDestroyed when the tour is closed mid-transition, so
  // mark as seen up front; only a full finish upgrades the flag to 'done'.
  markTour(storageKey, 'skipped')

  const instance = driver({
    animate: true,
    duration: 360,
    allowClose: true,
    overlayClickBehavior: 'close',
    overlayColor: '#191207',
    overlayOpacity: 0.55,
    smoothScroll: false,
    stagePadding: 7,
    stageRadius: 14,
    popoverOffset: 12,
    popoverClass: 'ss-tour',
    showProgress: true,
    progressText: '{{current}} / {{total}}',
    nextBtnText: '下一步',
    prevBtnText: '上一步',
    doneBtnText: '完成',
    closeBtnLabel: '跳过引导',
    disableActiveInteraction: true,
    showButtons: ['next', 'previous', 'close'],
    steps,
    onPopoverRender: renderChrome,
    onDestroyed: (_element, _step, opts) => {
      if (active === instance) active = null
      if (opts.reason === 'done') {
        markTour(storageKey, 'done')
        onFinish?.()
      }
    },
  })

  active = instance
  instance.drive()
}

export function startLibraryTour(options: {
  hasStats: boolean
  hasBooks: boolean
  onFinish: () => void
}): void {
  runTour({
    storageKey: LIBRARY_TOUR_KEY,
    steps: buildLibrarySteps(options),
    onFinish: options.onFinish,
  })
}

export function startReaderTour(hooks: {
  isPlaying: () => boolean
  onFinish: () => void
}): void {
  runTour({
    storageKey: READER_TOUR_KEY,
    steps: buildReaderSteps(hooks.isPlaying),
    onFinish: hooks.onFinish,
  })
}