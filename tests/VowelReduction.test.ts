import { describe, expect, it } from 'vitest'

async function loadDetector(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/vowelReduction.mjs')
}

const RATE = 22050

function quiet(ms: number): Float32Array {
  return new Float32Array(Math.round(RATE * ms / 1000))
}

function vowel(ms: number, f2: number, amplitude = 0.2): Float32Array {
  const samples = new Float32Array(Math.round(RATE * ms / 1000))
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / RATE
    samples[index] = amplitude * (
      Math.sin(2 * Math.PI * 350 * time) +
      0.8 * Math.sin(2 * Math.PI * f2 * time) +
      0.5 * Math.sin(2 * Math.PI * 2900 * time)
    )
  }
  return samples
}

function concat(parts: Float32Array[]): Float32Array {
  const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    samples.set(part, offset)
    offset += part.length
  }
  return samples
}

function noise(ms: number): Float32Array {
  const samples = new Float32Array(Math.round(RATE * ms / 1000))
  let seed = 1
  for (let index = 0; index < samples.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    samples[index] = (seed / 4294967296 - 0.5) * 0.4
  }
  return samples
}

describe('/i/-final vowel reduction detector', () => {
  it('targets plain /i/ phones, not an /i/ off-glide in zui4', async () => {
    const { isIFinalPhone } = await loadDetector()
    expect(['di4', 'ti', 'yi1', 'ji2', 'qi3', 'xi4', 'li3', 'mi4', 'ni2', 'pi1', 'bi3']
      .every(isIFinalPhone)).toBe(true)
    expect(['zui4', 'mei3', 'hai3', 'de', 'yuan2'].some(isIFinalPhone)).toBe(false)
  })

  it('flags only credible F2 below 1700Hz', async () => {
    const { estimateFormants, classifyFormants } = await loadDetector()
    const low = estimateFormants(vowel(240, 1200), RATE)
    const high = estimateFormants(vowel(240, 2200), RATE)
    expect(low.credible).toBe(true)
    expect(low.f2).toBeLessThan(1700)
    expect(classifyFormants(low)).toMatchObject({ status: 'risk', risk: true })
    expect(high.credible).toBe(true)
    expect(classifyFormants(high)).toMatchObject({ status: 'normal', risk: false })
    expect(classifyFormants({ credible: true, f2: 1700 }).risk).toBe(false)
  })

  it('never turns silence, aperiodic noise or a lone harmonic into a reduction risk', async () => {
    const { estimateFormants, classifyFormants } = await loadDetector()
    const loneTone = new Float32Array(Math.round(RATE * 0.24))
    for (let index = 0; index < loneTone.length; index += 1) {
      loneTone[index] = Math.sin(2 * Math.PI * 440 * index / RATE) * 0.2
    }
    for (const samples of [quiet(240), noise(240), loneTone]) {
      const result = classifyFormants(estimateFormants(samples, RATE))
      expect(result).toMatchObject({ status: 'unmeasurable', risk: false })
    }
  })

  it('locates a contextual di4 risk by word, sentence, phone and time', async () => {
    const { auditIFinalSyllables } = await loadDetector()
    const tones: Record<string, [number, number, number]> = {
      xie4: [2400, 150, 0.2],
      tian1: [1800, 210, 0.18],
      di4: [1200, 170, 0.21],
      de2: [1400, 240, 0.16],
      jiu4: [2200, 180, 0.19],
      le: [1800, 130, 0.2],
    }
    const synth = {
      sampleRate: RATE,
      generate(tokens: string[]) {
        const parts = [quiet(80)]
        for (const token of tokens) {
          const tone = tones[token]
          if (tone) parts.push(vowel(tone[1], tone[0], tone[2]), quiet(80))
        }
        parts.push(quiet(80))
        return { sampleRate: RATE, samples: concat(parts) }
      },
    }
    const tokens = ['xie4', 'tian1', 'xie4', 'di4', ',', 'de2', 'jiu4', 'le', '.']
    const checks = await auditIFinalSyllables(synth, {
      word: '谢天谢地', sentence: '“谢天谢地，得救了。”', contextSource: 'fixture',
      tokens: { current: tokens }, start: 0, count: 4,
    })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({
      word: '谢天谢地', sentence: '“谢天谢地，得救了。”', phone: 'di4',
      tokenIndex: 3, status: 'risk', risk: true,
    })
    expect(checks[0].f2).toBeLessThan(1700)
    expect(checks[0].endMs).toBeGreaterThan(checks[0].startMs)
  })

  it('passes the deterministic --verify self-test', async () => {
    const { verifyFormantDetector } = await loadDetector()
    expect(verifyFormantDetector()).toEqual([])
  })
})
