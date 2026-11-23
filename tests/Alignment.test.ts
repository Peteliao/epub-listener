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

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((RATE * ms) / 1000))
}

/** Two-level tone: a flat RMS envelope cannot disambiguate the offset. */
function stepTone(lowMs = 120, highMs = 180): Float32Array {
  return concat(tone(lowMs, 220, 0.15), tone(highMs, 220, 0.45))
}

function tail(ms = 400): Float32Array {
  return tone(ms, 330, 0.2)
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

  it('前缀开头 0 / 20 / 100ms 静音都不会把结束时间算多', async () => {
    const { alignPrefix } = await loadAlignment()
    const body = stepTone()
    const bodyMs = (body.length / RATE) * 1000
    for (const leadMs of [0, 20, 100]) {
      const prefix = concat(silence(leadMs), body)
      const full = concat(silence(500), body, tail())
      const result = alignPrefix(prefix, full, RATE, {
        expectedMs: 500 + bodyMs,
      })
      expect(result.confidence, `lead ${leadMs}ms`).toBe('high')
      expect(result.offsetMs).toBeGreaterThanOrEqual(490)
      expect(result.offsetMs).toBeLessThanOrEqual(510)
      expect(result.endMs).toBeGreaterThanOrEqual(790)
      expect(result.endMs).toBeLessThanOrEqual(810)
    }
  })

  it('前缀中间多个低能量区仍按整段模板对齐', async () => {
    const { alignPrefix } = await loadAlignment()
    const prefix = concat(
      tone(150, 220, 0.4),
      tone(60, 220, 0.02),
      tone(120, 220, 0.15),
      tone(40, 220, 0.02),
      tone(180, 220, 0.45),
    )
    const full = concat(silence(300), prefix, tail(300))
    const prefixMs = (prefix.length / RATE) * 1000
    const result = alignPrefix(prefix, full, RATE, { expectedMs: 300 + prefixMs })
    expect(result.confidence).toBe('high')
    expect(result.offsetMs).toBeGreaterThanOrEqual(280)
    expect(result.offsetMs).toBeLessThanOrEqual(320)
    expect(result.endMs).toBeGreaterThanOrEqual(300 + prefixMs - 20)
    expect(result.endMs).toBeLessThanOrEqual(300 + prefixMs + 20)
  })

  it('重复出现时 expected 窗口选中第二次，整段搜索保持低置信度', async () => {
    const { alignPrefix } = await loadAlignment()
    const prefix = stepTone()
    const prefixMs = (prefix.length / RATE) * 1000
    const full = concat(prefix, silence(600), prefix, tail(300))
    const secondStart = 300 + 600
    const picked = alignPrefix(prefix, full, RATE, {
      expectedMs: secondStart + prefixMs,
    })
    expect(picked.confidence).toBe('high')
    expect(picked.offsetMs).toBeGreaterThanOrEqual(secondStart - 10)
    expect(picked.offsetMs).toBeLessThanOrEqual(secondStart + 10)
    expect(picked.endMs).toBeGreaterThanOrEqual(secondStart + prefixMs - 10)
    expect(picked.endMs).toBeLessThanOrEqual(secondStart + prefixMs + 10)

    // Without an expected window both copies correlate equally: the honest
    // answer is NEEDS_LISTENING, not an arbitrary pick.
    const ambiguous = alignPrefix(prefix, full, RATE)
    expect(ambiguous.confidence).toBe('low')
  })

  it('长前缀仍能找到句首位置（expectedMs 按前缀结束时间居中）', async () => {
    const { alignPrefix } = await loadAlignment()
    const prefix = concat(tone(900, 220, 0.15), tone(300, 220, 0.45))
    const prefixMs = (prefix.length / RATE) * 1000
    const full = concat(silence(200), prefix, tail(300))
    const result = alignPrefix(prefix, full, RATE, { expectedMs: 200 + prefixMs })
    expect(result.confidence).toBe('high')
    expect(result.offsetMs).toBeGreaterThanOrEqual(190)
    expect(result.offsetMs).toBeLessThanOrEqual(210)
    expect(result.endMs).toBeGreaterThanOrEqual(200 + prefixMs - 10)
    expect(result.endMs).toBeLessThanOrEqual(200 + prefixMs + 10)
  })

  it('目标词在句首 / 句尾时边界仍可确定', async () => {
    const { alignPrefix } = await loadAlignment()
    const prefix = stepTone()
    const prefixMs = (prefix.length / RATE) * 1000

    const atStart = concat(prefix, tail(500))
    const start = alignPrefix(prefix, atStart, RATE, { expectedMs: prefixMs })
    expect(start.confidence).toBe('high')
    expect(start.offsetMs).toBeLessThanOrEqual(10)
    expect(start.endMs).toBeGreaterThanOrEqual(prefixMs - 10)
    expect(start.endMs).toBeLessThanOrEqual(prefixMs + 10)

    const atEnd = concat(silence(800), prefix)
    const end = alignPrefix(prefix, atEnd, RATE, { expectedMs: 800 + prefixMs })
    expect(end.confidence).toBe('high')
    expect(end.offsetMs).toBeGreaterThanOrEqual(790)
    expect(end.offsetMs).toBeLessThanOrEqual(810)
    expect(end.endMs).toBeGreaterThanOrEqual(800 + prefixMs - 10)
    expect(end.endMs).toBeLessThanOrEqual(800 + prefixMs + 10)
  })

  it('没有 expectedMs 时搜索整段音频，而不是只看前 800ms', async () => {
    const { alignPrefix } = await loadAlignment()
    const prefix = stepTone()
    const full = concat(silence(1500), prefix, tail(300))
    const result = alignPrefix(prefix, full, RATE)
    expect(result.offsetMs).toBeGreaterThanOrEqual(1490)
    expect(result.offsetMs).toBeLessThanOrEqual(1510)
  })
})
