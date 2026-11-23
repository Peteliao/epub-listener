import { describe, expect, it } from 'vitest'

async function loadEnvelope(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/envelope.mjs')
}

const RATE = 22050

function tone(ms: number, amplitude = 0.2, frequency = 220): Float32Array {
  const length = Math.round((RATE * ms) / 1000)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / RATE) * amplitude
  }
  return samples
}

function quiet(ms: number): Float32Array {
  return new Float32Array(Math.round((RATE * ms) / 1000))
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

describe('2026-11-23 第十一轮：整句包络分析', () => {
  it('识别两个正常音节 burst', async () => {
    const { analyzeEnvelope, evaluateTarget } = await loadEnvelope()
    const input = concat(quiet(100), tone(200), quiet(100), tone(200))
    const envelope = analyzeEnvelope(input, RATE)
    expect(envelope.runs.length).toBe(2)
    const target = evaluateTarget(envelope, 0)
    expect(target.verdict).toBe('ok')
    expect(target.second?.ms).toBeGreaterThanOrEqual(150)
  })

  it('第二音节太短时标为 weak-second', async () => {
    const { analyzeEnvelope, evaluateTarget } = await loadEnvelope()
    const input = concat(quiet(100), tone(200), quiet(100), tone(30, 0.06))
    const target = evaluateTarget(analyzeEnvelope(input, RATE), 0)
    expect(target.verdict).toBe('weak-second')
  })

  it('两音节粘连、没有第二个 burst 时标为 merged', async () => {
    const { analyzeEnvelope, evaluateTarget } = await loadEnvelope()
    const input = concat(quiet(100), tone(380), quiet(100))
    const target = evaluateTarget(analyzeEnvelope(input, RATE), 0)
    expect(target.verdict).toBe('merged')
  })

  it('前缀静音边界可用于估算目标词起点', async () => {
    const { voicedBounds } = await loadEnvelope()
    const prefix = concat(quiet(50), tone(100), quiet(300))
    const bounds = voicedBounds(prefix, RATE)
    expect(bounds.endMs).toBeGreaterThanOrEqual(140)
    expect(bounds.endMs).toBeLessThanOrEqual(170)
  })
})
