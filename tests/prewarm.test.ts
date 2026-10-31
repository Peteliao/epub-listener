import { describe, expect, it } from 'vitest'
import { canPrewarmAi, type PrewarmEnvironment } from '../src/core/tts/prewarm'

const desktop: PrewarmEnvironment = {
  saveData: false,
  connectionType: 'wifi',
  effectiveType: '4g',
  deviceMemory: 8,
}

describe('canPrewarmAi', () => {
  it('allows a cached pack on a capable desktop', () => {
    expect(canPrewarmAi(desktop)).toBe(true)
    expect(canPrewarmAi({})).toBe(true)
  })

  it('skips data-saver and cellular networks', () => {
    expect(canPrewarmAi({ ...desktop, saveData: true })).toBe(false)
    expect(canPrewarmAi({ ...desktop, connectionType: 'cellular' })).toBe(false)
    expect(canPrewarmAi({ ...desktop, effectiveType: '2g' })).toBe(false)
  })

  it('skips low-memory devices', () => {
    expect(canPrewarmAi({ ...desktop, deviceMemory: 2 })).toBe(false)
    expect(canPrewarmAi({ ...desktop, deviceMemory: 4 })).toBe(true)
  })

  it('skips backgrounded pages', () => {
    expect(canPrewarmAi({ ...desktop, hidden: true })).toBe(false)
  })
})
