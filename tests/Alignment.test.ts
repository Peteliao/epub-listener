import { describe, expect, it } from 'vitest'

async function loadAlignment(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/alignment.mjs')
}

const RATE = 22050

function tone(ms: number, frequency = 220, amplitude = 0.3): Float32Array {
  const length = Math.round((RATE * ms) / 1000)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / RATE) * amplitude
  }
  return samples
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  for (const part of parts) samples.set(part, offset), offset += part.length
  return samples
}

describe('2026-11-23 第十七轮：整句包络时间对齐', () => {
  it('用包络相关性找到前缀在完整句里的真实偏移', async () => {
    const { alignPrefix } = await loadAlignment()
    // A flat RMS template is ambiguous; use a two-level envelope so correlation
    // can distinguish the true offset from any other voiced stretch.
    const prefix = concat(
      tone(200, 220, 0.1),
      new Float32Array(Math.round(RATE * 0.1)),
      tone(300, 220, 0.5),
    )
    const full = concat(
      new Float32Array(Math.round(RATE * 0.45)),
      prefix,
      tone(600, 330, 0.2),
    )
    const result = alignPrefix(prefix, full, RATE, { expectedMs: 600 })
    expect(result.confidence).toBe('high')
    expect(result.offsetMs).toBeGreaterThan(430)
    expect(result.offsetMs).toBeLessThan(470)
    expect(result.endMs).toBeGreaterThan(1030)
    expect(result.endMs).toBeLessThan(1070)
  })

  it('模糊或过短的前缀标记为低置信度', async () => {
    const { alignPrefix } = await loadAlignment()
    const prefix = tone(40, 220)
    const full = tone(1200, 220)
    const result = alignPrefix(prefix, full, RATE, { expectedMs: 0 })
    expect(result.confidence).toBe('low')
  })

  it('Worker 分段的 120ms 拼接位置可精确计算', async () => {
    const { joinPcmParts, partStartsMs } = await loadAlignment()
    const results = [
      { samples: tone(200), sampleRate: RATE },
      { samples: tone(300), sampleRate: RATE },
      { samples: tone(100), sampleRate: RATE },
    ]
    const joined = joinPcmParts(results)
    expect(partStartsMs(results)).toEqual([0, 320, 740])
    expect(joined.length).toBe(
      results.reduce((sum, item) => sum + item.samples.length, 0) + 2 * Math.round(RATE * 0.12),
    )
  })

  it('低置信度只进入 NEEDS_LISTENING，不直接 FAIL', async () => {
    const { decisionFor } = await loadAlignment()
    expect(decisionFor('weak-second', { confidence: 'high' })).toBe('FAIL')
    expect(decisionFor('weak-second', { confidence: 'medium' })).toBe('NEEDS_LISTENING')
    expect(decisionFor('ok', { confidence: 'low' })).toBe('NEEDS_LISTENING')
    expect(decisionFor('ok', { confidence: 'high' })).toBe('PASS')
  })
})
