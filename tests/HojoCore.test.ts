import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

const N = 1920
const HOP = 480
const K = N / 2 + 1
const PAD = (N - HOP) / 2

type Istft = (mag: Float32Array, phase: Float32Array, frames: number) => Float32Array
type Spectrum = { mag: Float32Array; phase: Float32Array; frames: number }
type HojoApi = { istft: Istft; SR: number }

const coreScript = new Script(readFileSync(resolve(process.cwd(), 'public/hojo/runtime/hojo-core.js'), 'utf8'))

function loadCore() {
  const context = {} as { Hojo: HojoApi }
  coreScript.runInNewContext(context)
  return context.Hojo
}

// Keep the pre-FFT implementation in the same VM realm setup for fair timings.
const legacyScript = new Script(`
  const N_FFT = 1920, HOP = 480;
  let cosT = null, sinT = null, win = null;
  function tables() {
    if (cosT) return; cosT = new Float32Array(N_FFT); sinT = new Float32Array(N_FFT); win = new Float32Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N_FFT); sinT[i] = Math.sin(2 * Math.PI * i / N_FFT); win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT); }
  }
  function istft(mag, phase, T) {
    tables(); const K = N_FFT / 2 + 1, pad = (N_FFT - HOP) / 2;
    const outLen = (T - 1) * HOP + N_FFT, y = new Float32Array(outLen), env = new Float32Array(outLen);
    const re = new Float32Array(K), im = new Float32Array(K), frame = new Float32Array(N_FFT);
    for (let t = 0; t < T; t++) {
      for (let k = 0; k < K; k++) {
        let m = mag[k * T + t]; m = Math.min(Math.max(m, 1e-12), 100); const p = phase[k * T + t];
        re[k] = m * Math.cos(p); im[k] = m * Math.sin(p);
      }
      for (let n = 0; n < N_FFT; n++) {
        let s = re[0] + re[K - 1] * (n % 2 ? -1 : 1), acc = 0, idx = n;
        for (let k = 1; k < K - 1; k++) { acc += re[k] * cosT[idx] - im[k] * sinT[idx]; idx += n; if (idx >= N_FFT) idx %= N_FFT; }
        frame[n] = (s + 2 * acc) / N_FFT * win[n];
      }
      const st = t * HOP;
      for (let n = 0; n < N_FFT; n++) { y[st + n] += frame[n]; env[st + n] += win[n] * win[n]; }
    }
    const L = outLen - 2 * pad, out = new Float32Array(L);
    for (let i = 0; i < L; i++) out[i] = y[i + pad] / env[i + pad];
    return out;
  }
  globalThis.istft = istft;
`)

function loadLegacy(): Istft {
  const context = {} as { istft: Istft }
  legacyScript.runInNewContext(context)
  return context.istft
}

const cos = Float64Array.from({ length: N }, (_, k) => Math.cos(2 * Math.PI * k / N))
const sin = Float64Array.from({ length: N }, (_, k) => Math.sin(2 * Math.PI * k / N))
const window = Float32Array.from({ length: N }, (_, n) => 0.5 * (1 - Math.cos(2 * Math.PI * n / N)))

function directIstft({ mag, phase, frames }: Spectrum) {
  const length = (frames - 1) * HOP + N
  const samples = new Float32Array(length)
  const envelope = new Float32Array(length)
  const real = new Float32Array(N)
  const imaginary = new Float32Array(N)
  for (let t = 0; t < frames; t += 1) {
    for (let k = 0; k < N; k += 1) {
      const source = k <= N / 2 ? k : N - k
      const index = source * frames + t
      const magnitude = Math.max(1e-12, Math.min(100, mag[index]))
      real[k] = magnitude * Math.cos(phase[index])
      imaginary[k] = k === 0 || k === N / 2 ? 0 : magnitude * Math.sin(phase[index]) * (k < N / 2 ? 1 : -1)
    }
    for (let n = 0; n < N; n += 1) {
      let value = 0
      for (let k = 0; k < N; k += 1) {
        const angle = (n * k) % N
        value += real[k] * cos[angle] - imaginary[k] * sin[angle]
      }
      const index = t * HOP + n
      samples[index] += Math.fround(value / N * window[n])
      envelope[index] += window[n] * window[n]
    }
  }
  return Float32Array.from({ length: length - 2 * PAD }, (_, i) => samples[i + PAD] / envelope[i + PAD])
}

function randomSpectrum(frames: number, seed: number): Spectrum {
  let state = seed >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  const mag = Float32Array.from({ length: K * frames }, () => 4 * random())
  const phase = Float32Array.from({ length: K * frames }, () => (2 * random() - 1) * Math.PI)
  return { mag, phase, frames }
}

function sinusoidalSpectrum(frames: number): Spectrum {
  const mag = new Float32Array(K * frames)
  const phase = new Float32Array(K * frames)
  for (let k = 0; k < K; k += 1) {
    for (let t = 0; t < frames; t += 1) {
      mag[k * frames + t] = 1.25 + Math.sin(2 * Math.PI * (7 * k / N + t / 11))
      phase[k * frames + t] = Math.PI * Math.sin(2 * Math.PI * (13 * k / N - t / 7))
    }
  }
  return { mag, phase, frames }
}

function errors(actual: Float32Array, expected: Float32Array) {
  let max = 0
  let sum = 0
  let peak = 0
  for (let i = 0; i < expected.length; i += 1) {
    const error = Math.abs(actual[i] - expected[i])
    max = Math.max(max, error)
    sum += error * error
    peak = Math.max(peak, Math.abs(expected[i]))
  }
  return { max, rms: Math.sqrt(sum / Math.max(1, expected.length)), peak }
}

function expectClose(actual: Float32Array, expected: Float32Array, absoluteTolerance = 1e-9) {
  expect(actual.length).toBe(expected.length)
  expect(Object.prototype.toString.call(actual)).toBe('[object Float32Array]')
  expect(actual.every(Number.isFinite)).toBe(true)
  const result = errors(actual, expected)
  expect(result.max).toBeLessThanOrEqual(absoluteTolerance + 2e-7 * result.peak)
  expect(result.rms).toBeLessThanOrEqual(absoluteTolerance / 10 + 5e-8 * result.peak)
  return result
}

const cases = [
  { name: 'random seed 1, one frame', spectrum: randomSpectrum(1, 1) },
  { name: 'random seed 12648430, two frames', spectrum: randomSpectrum(2, 0xc0ffee) },
  { name: 'random seed 11256099, seven frames', spectrum: randomSpectrum(7, 0xabc123) },
  { name: 'sinusoidal full-bin spectrum, one frame', spectrum: sinusoidalSpectrum(1) },
  { name: 'sinusoidal full-bin spectrum, five frames', spectrum: sinusoidalSpectrum(5) },
]

const core = loadCore()
const legacy = loadLegacy()

describe('Hojo mixed-radix ISTFT', () => {
  it.each(cases)('matches a full complex direct DFT: $name', ({ name, spectrum }) => {
    const { mag, phase, frames } = spectrum
    const originalMag = mag.slice()
    const originalPhase = phase.slice()
    const expected = directIstft(spectrum)
    const actual = core.istft(mag, phase, frames)
    const referenceError = expectClose(actual, expected)
    // Float32 legacy twiddles leave a small noise floor where bins cancel.
    const legacyError = expectClose(actual, legacy(mag, phase, frames), 1e-8)
    expect(actual.length).toBe(frames * HOP)
    expect(mag).toEqual(originalMag)
    expect(phase).toEqual(originalPhase)
    console.info(`[Hojo ISTFT] ${name}: DFT max=${referenceError.max.toExponential(3)}, RMS=${referenceError.rms.toExponential(3)}; legacy max=${legacyError.max.toExponential(3)}`)
  })

  it.each([0, 1, 3, 5, 128, 384, 640, 959, 960])('preserves scale, phase, symmetry and endpoint handling for bin %i', (bin) => {
    const mag = new Float32Array(K)
    const phase = new Float32Array(K)
    mag[bin] = 3.25
    phase[bin] = 0.7
    const actual = core.istft(mag, phase, 1)
    const real = Math.fround(mag[bin] * Math.cos(phase[bin]))
    const imaginary = Math.fround(mag[bin] * Math.sin(phase[bin]))
    const expected = Float32Array.from({ length: HOP }, (_, index) => {
      const n = index + PAD
      const value = bin === 0 ? real : bin === N / 2 ? real * (n % 2 ? -1 : 1)
        : 2 * (real * Math.cos(2 * Math.PI * bin * n / N) - imaginary * Math.sin(2 * Math.PI * bin * n / N))
      return Math.fround(value / N * window[n]) / Math.fround(window[n] * window[n])
    })
    expectClose(actual, expected)
  })

  it('preserves magnitude clamping with overlapping high-dynamic-range frames', () => {
    const spectrum = randomSpectrum(4, 42)
    const values = [-Infinity, -10, 0, 1e-20, 1e-12, 1e-7, 0.4, 100, 200, Infinity]
    for (let i = 0; i < spectrum.mag.length; i += 1) spectrum.mag[i] = values[i % values.length]
    const actual = core.istft(spectrum.mag, spectrum.phase, spectrum.frames)
    const referenceError = expectClose(actual, directIstft(spectrum))
    const legacyError = expectClose(actual, legacy(spectrum.mag, spectrum.phase, spectrum.frames))
    console.info(`[Hojo ISTFT] clamped: DFT max=${referenceError.max.toExponential(3)}, RMS=${referenceError.rms.toExponential(3)}; legacy max=${legacyError.max.toExponential(3)}`)
  })

  it('reuses scratch safely across calls, preserves earlier output and keeps 24 kHz', () => {
    const first = randomSpectrum(3, 2026)
    const output = core.istft(first.mag, first.phase, first.frames)
    const saved = output.slice()
    const next = sinusoidalSpectrum(9)
    core.istft(next.mag, next.phase, next.frames)
    const silent = core.istft(new Float32Array(K * 2), new Float32Array(K * 2), 2)
    expectClose(silent, directIstft({ mag: new Float32Array(K * 2), phase: new Float32Array(K * 2), frames: 2 }))
    expect(output).toEqual(saved)
    expect(core.istft(first.mag, first.phase, first.frames)).toEqual(saved)
    expect(core.istft(new Float32Array(0), new Float32Array(0), 0).length).toBe(0)
    expect(core.SR).toBe(24000)
  })

  it('reports cold and warm legacy/FFT timings without timing assertions', () => {
    const { mag, phase, frames } = randomSpectrum(32, 2026)
    const oldIstft = loadLegacy()
    const newIstft = loadCore().istft
    const measure = (fn: Istft) => {
      const start = performance.now()
      const output = fn(mag, phase, frames)
      return { milliseconds: performance.now() - start, output }
    }
    const coldOld = measure(oldIstft)
    const coldNew = measure(newIstft)
    expectClose(coldNew.output, coldOld.output)
    for (let i = 0; i < 3; i += 1) { measure(oldIstft); measure(newIstft) }
    const oldTimes: number[] = []
    const newTimes: number[] = []
    for (let i = 0; i < 5; i += 1) {
      oldTimes.push(measure(oldIstft).milliseconds)
      newTimes.push(measure(newIstft).milliseconds)
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const oldMs = median(oldTimes)
    const newMs = median(newTimes)
    console.info(`[Hojo ISTFT benchmark] ${frames} frames / ${coldNew.output.length} samples; cold old=${coldOld.milliseconds.toFixed(2)} ms, FFT=${coldNew.milliseconds.toFixed(2)} ms; warm median old=${oldMs.toFixed(2)} ms, FFT=${newMs.toFixed(2)} ms, speedup=${(oldMs / newMs).toFixed(2)}x`)
  }, 30000)
})
