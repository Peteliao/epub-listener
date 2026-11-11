import { beforeEach, describe, expect, it } from 'vitest'
import type { PopoverDOM } from 'driver.js'
import {
  LIBRARY_TOUR_KEY,
  READER_TOUR_KEY,
  buildLibrarySteps,
  buildReaderSteps,
  resetTour,
  stopTour,
  tourSeen,
} from '@/ui/tour'

beforeEach(() => {
  window.localStorage.clear()
})

describe('tourSeen', () => {
  it('is false before the tour has been shown', () => {
    expect(tourSeen(LIBRARY_TOUR_KEY)).toBe(false)
    expect(tourSeen(READER_TOUR_KEY)).toBe(false)
  })

  it('is true once a status is stored, whether done or skipped', () => {
    window.localStorage.setItem(LIBRARY_TOUR_KEY, 'skipped')
    window.localStorage.setItem(READER_TOUR_KEY, 'done')
    expect(tourSeen(LIBRARY_TOUR_KEY)).toBe(true)
    expect(tourSeen(READER_TOUR_KEY)).toBe(true)
  })
})

describe('buildLibrarySteps', () => {
  it('starts with a centered welcome and ends with a centered finish', () => {
    const steps = buildLibrarySteps({ hasStats: false, hasBooks: false })
    expect(steps[0]!.element).toBeUndefined()
    expect(steps[0]!.popover?.nextBtnText).toBe('开始引导')
    expect(steps.at(-1)!.element).toBeUndefined()
    expect(steps.at(-1)!.popover?.doneBtnText).toBe('打开样书试试')
  })

  it('offers the latest book when the shelf is not empty', () => {
    const steps = buildLibrarySteps({ hasStats: false, hasBooks: true })
    expect(steps.at(-1)!.popover?.doneBtnText).toBe('打开最近的书')
  })

  it('includes the stats step only when listening stats exist', () => {
    const without = buildLibrarySteps({ hasStats: false, hasBooks: false })
    const withStats = buildLibrarySteps({ hasStats: true, hasBooks: false })
    expect(without.some((step) => step.element === '[data-tour="stats"]')).toBe(false)
    const statsStep = withStats.find((step) => step.element === '[data-tour="stats"]')
    expect(statsStep?.skipMissingElement).toBe(true)
    expect(withStats.length).toBe(without.length + 1)
  })

  it('anchors every element step to a data-tour hook and keeps the help entry', () => {
    const steps = buildLibrarySteps({ hasStats: true, hasBooks: true })
    const anchors = steps
      .filter((step) => step.element !== undefined)
      .map((step) => step.element)
    expect(anchors).toEqual([
      '[data-tour="import"]',
      '[data-tour="sample"]',
      '[data-tour="shelf"]',
      '[data-tour="stats"]',
      '[data-tour="help"]',
    ])
  })
})

describe('buildReaderSteps', () => {
  it('covers the player, stage, appearance, pace, tools and a centered finish', () => {
    const steps = buildReaderSteps(() => false)
    expect(steps.map((step) => step.element)).toEqual([
      '[data-tour="play"]',
      '[data-tour="stage"]',
      '[data-tour="appearance"]',
      '[data-tour="pace"]',
      '[data-tour="toc"]',
      '[data-tour="sleep"]',
      '[data-tour="settings"]',
      undefined,
    ])
  })

  it('lets the learner start playback by clicking the highlighted play button', () => {
    const steps = buildReaderSteps(() => false)
    const play = steps[0]!
    expect(play.advanceOnClick).toBe(true)
    expect(play.disableActiveInteraction).toBe(false)
    for (const step of steps.slice(1)) {
      expect(step.advanceOnClick).toBeUndefined()
    }
  })

  it('renders the finish button label from the live playback state', () => {
    for (const playing of [false, true]) {
      const steps = buildReaderSteps(() => playing)
      const finish = steps.at(-1)!
      const footer = document.createElement('div')
      const closeButton = document.createElement('button')
      const nextButton = document.createElement('button')
      footer.appendChild(nextButton)
      const popover = { footer, closeButton, nextButton } as unknown as PopoverDOM
      finish.popover!.onPopoverRender!(popover, {} as never)
      expect(nextButton.textContent).toBe(playing ? '继续听书' : '开始听书')
      expect(closeButton.textContent).toBe('跳过')
      expect(footer.lastChild).toBe(closeButton)
    }
  })

  it('tells readers the header help button replays the tour', () => {
    const steps = buildReaderSteps(() => false)
    const settings = steps.find((step) => step.element === '[data-tour="settings"]')
    expect(settings?.popover?.description).toContain('问号')
    expect(steps.at(-1)!.popover?.description).toContain('问号')
  })
})

describe('resetTour', () => {
  it('clears one tour status without touching the other', () => {
    window.localStorage.setItem(LIBRARY_TOUR_KEY, 'skipped')
    window.localStorage.setItem(READER_TOUR_KEY, 'done')
    resetTour(READER_TOUR_KEY)
    expect(tourSeen(READER_TOUR_KEY)).toBe(false)
    expect(tourSeen(LIBRARY_TOUR_KEY)).toBe(true)
  })

  it('is a no-op when the key was never stored', () => {
    expect(() => resetTour(READER_TOUR_KEY)).not.toThrow()
    expect(tourSeen(READER_TOUR_KEY)).toBe(false)
  })
})

describe('stopTour', () => {
  it('is a no-op when no tour is running', () => {
    expect(() => stopTour()).not.toThrow()
  })
})