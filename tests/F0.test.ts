import { describe, expect, it } from 'vitest'

async function loadF0(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/f0.mjs')
}

const RATE = 22050

function tone(ms: number, frequency: number, amplitude = 0.25): Float32Array {
  const length = Math.round((RATE * ms) / 1000)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / RATE) * amplitude
  }
  return samples
}

function sweep(ms: number, from: number, to: number, amplitude = 0.25): Float32Array {
  const length = Math.round((RATE * ms) / 1000)
  const samples = new Float32Array(length)
  let phase = 0
  for (let i = 0; i < length; i += 1) {
    const frequency = from + ((to - from) * i) / length
    phase += (2 * Math.PI * frequency) / RATE
    samples[i] = Math.sin(phase) * amplitude
  }
  return samples
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    samples.set(part, offset)
    offset += part.length
  }
  return samples
}

describe('2026-11-23 第十四轮：基频连续性', () => {
  it('稳定音高：voiced 比例高、平均 F0 接近 220Hz', async () => {
    const { analyzeF0 } = await loadF0()
    const result = analyzeF0(tone(1000, 220), RATE)
    expect(result.voicedRatio).toBeGreaterThan(0.7)
    expect(result.meanF0).toBeGreaterThan(205)
    expect(result.meanF0).toBeLessThan(235)
    expect(result.jumpRatio).toBeLessThan(0.1)
  })

  it('音高突跳能被 maxJump 标记', async () => {
    const { analyzeF0 } = await loadF0()
    const result = analyzeF0(concat(tone(500, 220), tone(500, 330)), RATE)
    expect(result.maxJump).toBeGreaterThan(0.3)
  })

  it('句末上扬/下降斜率符号正确', async () => {
    const { analyzeF0 } = await loadF0()
    const rising = analyzeF0(sweep(900, 180, 280), RATE)
    const falling = analyzeF0(sweep(900, 280, 180), RATE)
    expect(rising.finalSlopeHzPerSec).toBeGreaterThan(0)
    expect(falling.finalSlopeHzPerSec).toBeLessThan(0)
  })

  it('静音没有 voiced 帧', async () => {
    const { analyzeF0 } = await loadF0()
    const result = analyzeF0(new Float32Array(RATE), RATE)
    expect(result.voicedFrames).toBe(0)
    expect(result.voicedRatio).toBe(0)
  })
})
