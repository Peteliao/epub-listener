// Dev-only /i/-final vowel reduction detector for audit-acoustics.mjs.
//
// The peak-envelope method mirrors scratch/analyze-round11.py, but a numerical
// F2 is not enough: silence, noise and a lone harmonic have no credible vowel
// formants. Those cases are reported as unmeasurable, never as reduction risk.
import { alignPrefix } from './alignment.mjs'
import { analyzeEnvelope, voicedBounds } from './envelope.mjs'

export const I_FINAL_F2_RISK_HZ = 1700
const FFT_SIZE = 2048
const TARGET_RATE = 11025

export function isIFinalPhone(phone) {
  const base = String(phone ?? '').toLowerCase().replace(/[0-5]$/, '')
  // Plain /i/ finals only. Diphthongs such as ai/ei/ui end in an /i/ off-glide,
  // not the vowel targeted here (zui4 must not be treated like di4).
  return /^(?:i|yi|bi|pi|mi|di|ti|ni|li|ji|qi|xi|zhi|chi|shi|ri|zi|ci|si)$/.test(base)
}

function downsample(samples, rate) {
  if (rate <= TARGET_RATE) return { samples, rate }
  const factor = Math.max(1, Math.round(rate / TARGET_RATE))
  const length = Math.floor(samples.length / factor)
  const output = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    let sum = 0
    const offset = index * factor
    for (let i = 0; i < factor; i += 1) sum += samples[offset + i] ?? 0
    output[index] = sum / factor
  }
  return { samples: output, rate: rate / factor }
}

/** In-place iterative radix-2 FFT. */
function fft(real, imaginary) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[real[i], real[j]] = [real[j], real[i]]
      ;[imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < n; start += size) {
      let wr = 1
      let wi = 0
      const half = size >> 1
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset
        const odd = even + half
        const tr = wr * real[odd] - wi * imaginary[odd]
        const ti = wr * imaginary[odd] + wi * real[odd]
        real[odd] = real[even] - tr
        imaginary[odd] = imaginary[even] - ti
        real[even] += tr
        imaginary[even] += ti
        const nextWr = wr * stepReal - wi * stepImaginary
        wi = wr * stepImaginary + wi * stepReal
        wr = nextWr
      }
    }
  }
}

function spectrum(frame) {
  const real = new Float64Array(FFT_SIZE)
  const imaginary = new Float64Array(FFT_SIZE)
  const padded = frame.length < FFT_SIZE
    ? [...frame, ...new Array(FFT_SIZE - frame.length).fill(0)]
    : frame
  const centre = padded.length > FFT_SIZE ? Math.floor((padded.length - FFT_SIZE) / 2) : 0
  const count = Math.min(FFT_SIZE, padded.length - centre)
  let mean = 0
  for (let i = 0; i < count; i += 1) mean += padded[centre + i]
  mean /= Math.max(1, count)
  for (let i = 0; i < count; i += 1) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))
    real[i] = (padded[centre + i] - mean) * window
  }
  fft(real, imaginary)
  return Array.from({ length: FFT_SIZE / 2 }, (_, i) =>
    Math.hypot(real[i], imaginary[i]))
}

function smooth(values, radius = 12) {
  return values.map((_, index) => {
    const lo = Math.max(0, index - radius)
    const hi = Math.min(values.length, index + radius + 1)
    let sum = 0
    for (let i = lo; i < hi; i += 1) sum += values[i]
    return sum / (hi - lo)
  })
}

function normalizedAutocorrelation(frame, rate) {
  let mean = 0
  for (const value of frame) mean += value
  mean /= Math.max(1, frame.length)
  let energy = 0
  for (const value of frame) {
    const centred = value - mean
    energy += centred * centred
  }
  if (energy <= 1e-8) return 0
  let best = 0
  const from = Math.max(1, Math.floor(rate / 400))
  const to = Math.min(frame.length - 2, Math.ceil(rate / 70))
  for (let lag = from; lag <= to; lag += 1) {
    let correlation = 0
    for (let index = 0; index < frame.length - lag; index += 1) {
      correlation += (frame[index] - mean) * (frame[index + lag] - mean)
    }
    best = Math.max(best, correlation / energy)
  }
  return best
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function crediblePeak(magnitude, rate, loHz, hiHz, globalPeak) {
  const binHz = rate / FFT_SIZE
  const lo = Math.max(1, Math.ceil(loHz / binHz))
  const hi = Math.min(magnitude.length - 2, Math.floor(hiHz / binHz))
  if (lo >= hi) return null
  let best = lo
  for (let i = lo + 1; i <= hi; i += 1) {
    if (magnitude[i] > magnitude[best]) best = i
  }
  // A boundary maximum is a search-range artefact, not a observed formant.
  if (best <= lo + 1 || best >= hi - 1) return null
  const shoulders = []
  for (let distance = 18; distance <= 36; distance += 1) {
    if (best - distance >= 0) shoulders.push(magnitude[best - distance])
    if (best + distance < magnitude.length) shoulders.push(magnitude[best + distance])
  }
  const baseline = median(shoulders)
  const prominence = best > 0 && baseline > 0 ? magnitude[best] / baseline : 0
  if (magnitude[best] < globalPeak * 0.002 || prominence < 1.12) return null
  return { hz: best * binHz, prominence }
}

/**
 * Estimate F1/F2 from the middle three frames of a time range. The returned
 * confidence is about formant evidence only; temporal alignment is checked by
 * auditIFinalSyllables before this function is allowed to flag a risk.
 */
export function estimateFormants(input, sampleRate, startMs = 0, endMs = input.length / sampleRate * 1000) {
  const empty = {
    f1: null, f2: null, confidence: 'none', credible: false,
    frameCount: 0, reason: '无声或时间范围无效',
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !input?.length ||
    !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 40) {
    return empty
  }
  const prepared = downsample(input, sampleRate)
  const from = Math.max(0, Math.round(startMs / 1000 * prepared.rate))
  const to = Math.min(prepared.samples.length, Math.round(endMs / 1000 * prepared.rate))
  const samples = prepared.samples.subarray(from, to)
  if (samples.length < Math.round(prepared.rate * 0.04)) return empty

  const magnitudes = []
  const voicing = []
  const half = Math.round(prepared.rate * 0.02)
  const span = samples.length
  let peakRms = 0
  for (const fraction of [0.4, 0.5, 0.6]) {
    const centre = Math.round(span * fraction)
    const frame = samples.subarray(Math.max(0, centre - half), Math.min(span, centre + half))
    if (frame.length < 64) continue
    let energy = 0
    for (const value of frame) energy += value * value
    const rms = Math.sqrt(energy / frame.length)
    peakRms = Math.max(peakRms, rms)
    if (rms < 1e-5) continue
    const periodicity = normalizedAutocorrelation(frame, prepared.rate)
    if (periodicity < 0.35) continue
    voicing.push(periodicity)
    magnitudes.push(spectrum(frame))
  }
  if (magnitudes.length < 2) {
    return { ...empty, frameCount: magnitudes.length, peakRms, reason: '目标区间无足够可信浊音帧' }
  }

  const averaged = magnitudes[0].map((_, index) =>
    magnitudes.reduce((sum, item) => sum + item[index], 0) / magnitudes.length)
  const envelope = smooth(averaged)
  const globalPeak = Math.max(...averaged)
  const f1Peak = crediblePeak(envelope, prepared.rate, 200, 1000, globalPeak)
  const f2Peak = f1Peak && crediblePeak(
    envelope, prepared.rate, Math.max(900, f1Peak.hz + 250), 3200, globalPeak,
  )
  const frameCount = magnitudes.length
  if (!f1Peak || !f2Peak) {
    return {
      f1: f1Peak ? Math.round(f1Peak.hz) : null,
      f2: f2Peak ? Math.round(f2Peak.hz) : null,
      confidence: 'none', credible: false, frameCount, peakRms, voicing,
      reason: !f1Peak ? 'F1 无可信峰值' : 'F2 无可信峰值',
    }
  }
  return {
    f1: Math.round(f1Peak.hz),
    f2: Math.round(f2Peak.hz),
    confidence: 'high',
    credible: true,
    frameCount,
    peakRms,
    voicing,
    reason: 'F1/F2 峰值清晰且浊音周期稳定',
  }
}

export function classifyFormants(formants) {
  if (!formants?.credible || !Number.isFinite(formants.f2)) {
    return { status: 'unmeasurable', risk: false, reason: formants?.reason ?? '无可信共振峰' }
  }
  if (formants.f2 < I_FINAL_F2_RISK_HZ) {
    return {
      status: 'risk', risk: true,
      reason: `可信 F2 ${formants.f2}Hz < ${I_FINAL_F2_RISK_HZ}Hz，/i/ 元音弱化风险`,
    }
  }
  return { status: 'normal', risk: false, reason: `可信 F2 ${formants.f2}Hz ≥ ${I_FINAL_F2_RISK_HZ}Hz` }
}

function voicedIslandInterval(samples, rate, startMs, endMs) {
  const envelope = analyzeEnvelope(samples, rate, { frameMs: 10, thresholdRatio: 0.1 })
  const runs = []
  for (const run of envelope.runs) {
    const previous = runs[runs.length - 1]
    if (previous && run.startMs - previous.endMs <= 30) previous.endMs = run.endMs
    else runs.push({ startMs: run.startMs, endMs: run.endMs })
  }
  const centre = (startMs + endMs) / 2
  const island = runs.find((run) => run.startMs <= centre && run.endMs >= centre)
  if (!island || island.endMs - Math.max(startMs, island.startMs) < 40) {
    return { startMs, endMs, method: 'prefix-alignment' }
  }
  return {
    startMs: Math.max(startMs, island.startMs),
    endMs: island.endMs,
    method: 'voiced-island',
  }
}

function phoneIndices(tokens, start, count) {
  const nonPhone = new Set(['"', ',', '.', '!', '?', ';', ':', '_'])
  const indices = []
  for (let index = start; index < tokens.length && indices.length < count; index += 1) {
    if (!nonPhone.has(tokens[index])) indices.push(index)
  }
  return indices
}

function unknownCheck(item, tokenIndex, phone, syllableIndex, reason) {
  const formants = { f1: null, f2: null, confidence: 'none', credible: false, frameCount: 0, reason }
  return {
    word: item.word,
    sentence: item.sentence ?? null,
    contextSource: item.contextSource ?? 'unknown',
    syllableIndex,
    tokenIndex,
    phone,
    variant: item.vowelVariant ?? 'current',
    startMs: null,
    endMs: null,
    alignedStartMs: null,
    alignedEndMs: null,
    intervalMethod: 'unavailable',
    alignment: { confidence: 'low', method: 'unavailable' },
    ...formants,
    ...classifyFormants(formants),
  }
}

/**
 * Locate each /i/-final phone in the CURRENT rendered token stream by aligning
 * separately rendered prefixes to that stream. Low-confidence alignment and
 * missing formants remain explicit unknowns and can never become a risk row.
 */
export async function auditIFinalSyllables(synth, item) {
  const tokens = item.tokens?.current ?? item.tokens ?? []
  const indices = phoneIndices(tokens, item.start ?? 0, item.count ?? 0)
  const targets = indices.map((tokenIndex, syllableIndex) => ({ tokenIndex, syllableIndex, phone: tokens[tokenIndex] }))
    .filter((target) => isIFinalPhone(target.phone))
  if (!targets.length) return []

  let audio
  try {
    audio = synth.generate(tokens)
  } catch (error) {
    return targets.map((target) => unknownCheck(
      item, target.tokenIndex, target.phone, target.syllableIndex,
      `当前 token 序列渲染失败：${error instanceof Error ? error.message : String(error)}`,
    ))
  }
  const rate = audio.sampleRate || synth.sampleRate
  const prefixCache = new Map()
  const renderPrefix = (end) => {
    if (!prefixCache.has(end)) prefixCache.set(end, synth.generate(tokens.slice(0, end)))
    return prefixCache.get(end)
  }
  const checks = []
  for (const target of targets) {
    try {
      const prefix = target.tokenIndex === 0 ? null : renderPrefix(target.tokenIndex)
      const through = renderPrefix(target.tokenIndex + 1)
      const startAlignment = prefix
        ? alignPrefix(prefix.samples, audio.samples, rate, {
          expectedMs: voicedBounds(prefix.samples, rate).endMs,
          windowMs: 500,
        })
        : {
          offsetMs: 0, endMs: 0, correlation: 1, margin: 1,
          confidence: 'high', method: 'sentence-start',
        }
      const endAlignment = alignPrefix(through.samples, audio.samples, rate, {
        expectedMs: voicedBounds(through.samples, rate).endMs,
        windowMs: 500,
      })
      if (startAlignment.confidence === 'low' || endAlignment.confidence === 'low') {
        checks.push(unknownCheck(
          item, target.tokenIndex, target.phone, target.syllableIndex,
          `前后缀对齐置信不足（${startAlignment.confidence}/${endAlignment.confidence}）`,
        ))
        continue
      }
      const interval = voicedIslandInterval(
        audio.samples, rate, startAlignment.endMs, endAlignment.endMs,
      )
      const formants = estimateFormants(
        audio.samples, rate, interval.startMs, interval.endMs,
      )
      checks.push({
        word: item.word,
        sentence: item.sentence ?? null,
        contextSource: item.contextSource ?? 'unknown',
        syllableIndex: target.syllableIndex,
        tokenIndex: target.tokenIndex,
        phone: target.phone,
        variant: item.vowelVariant ?? 'current',
        startMs: Math.round(interval.startMs),
        endMs: Math.round(interval.endMs),
        alignedStartMs: Math.round(startAlignment.endMs),
        alignedEndMs: Math.round(endAlignment.endMs),
        intervalMethod: interval.method,
        alignment: {
          start: startAlignment,
          end: endAlignment,
          confidence: startAlignment.confidence === 'high' && endAlignment.confidence === 'high'
            ? 'high' : 'medium',
          method: 'prefix-envelope-correlation',
        },
        ...formants,
        ...classifyFormants(formants),
      })
    } catch (error) {
      checks.push(unknownCheck(
        item, target.tokenIndex, target.phone, target.syllableIndex,
        `共振峰分析失败：${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }
  return checks
}

/** Deterministic gate used by audit-acoustics.mjs --verify (no WASM variance). */
export function verifyFormantDetector() {
  const rate = 22050
  const vowel = (f2) => {
    const samples = new Float32Array(Math.round(rate * 0.24))
    for (let index = 0; index < samples.length; index += 1) {
      const time = index / rate
      samples[index] = 0.2 * (
        Math.sin(2 * Math.PI * 350 * time) +
        0.8 * Math.sin(2 * Math.PI * f2 * time) +
        0.5 * Math.sin(2 * Math.PI * 2900 * time)
      )
    }
    return samples
  }
  const noise = new Float32Array(Math.round(rate * 0.2))
  let seed = 1
  for (let index = 0; index < noise.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    noise[index] = (seed / 4294967296 - 0.5) * 0.4
  }
  const low = classifyFormants(estimateFormants(vowel(1200), rate))
  const high = classifyFormants(estimateFormants(vowel(2200), rate))
  const silent = classifyFormants(estimateFormants(new Float32Array(rate * 0.2), rate))
  const noisy = classifyFormants(estimateFormants(noise, rate))
  const failures = []
  if (!isIFinalPhone('di4') || isIFinalPhone('zui4')) failures.push('/i/ 尾音节识别口径错误')
  if (!low.risk || low.status !== 'risk') failures.push('可信低 F2 未判为弱化')
  if (high.risk || high.status !== 'normal') failures.push('可信高 F2 未判为正常')
  if (silent.risk || silent.status !== 'unmeasurable') failures.push('无声被误报为弱化')
  if (noisy.risk || noisy.status !== 'unmeasurable') failures.push('无周期噪声被误报为弱化')
  if (classifyFormants({ credible: true, f2: I_FINAL_F2_RISK_HZ }).risk) {
    failures.push('F2 阈值边界错误（1700 不应判弱化）')
  }
  return failures
}
