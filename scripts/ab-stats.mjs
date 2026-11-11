#!/usr/bin/env node
// Statistical analysis for the 山岚 A/B harness.
//
// A single mean per parameter is not a conclusion: WASM timing drifts and the
// first worker used to pay for cold start. This computes a 95% CI per group,
// one-way ANOVA (F and eta-squared) and a distribution-free permutation p
// value, so "0.667 is best" can only be claimed if the groups really differ.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IN_FILE = join(ROOT, 'scripts', 'out', 'ab-results.json')
const OUT_FILE = join(ROOT, 'scripts', 'out', 'ab-stats.json')
const PERMUTATIONS = 10_000

function rng(seed) {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length
}

function anovaF(groups) {
  const all = groups.flatMap((group) => group.values)
  const grand = mean(all)
  const ssb = groups.reduce(
    (sum, group) => sum + group.values.length * (mean(group.values) - grand) ** 2,
    0,
  )
  const ssw = groups.reduce(
    (sum, group) =>
      sum +
      group.values.reduce((acc, value) => acc + (value - mean(group.values)) ** 2, 0),
    0,
  )
  const dfBetween = groups.length - 1
  const dfWithin = all.length - groups.length
  if (dfWithin <= 0 || ssw === 0) return { F: 0, eta2: 0, ssb, ssw }
  return {
    F: (ssb / dfBetween) / (ssw / dfWithin),
    eta2: ssb + ssw > 0 ? ssb / (ssb + ssw) : 0,
    ssb,
    ssw,
  }
}

export function analyse(label, groups, seed = 20261107, direction = 'lower') {
  const pooled = groups.flatMap((group) => group.values)
  const sizes = groups.map((group) => group.values.length)
  const observed = anovaF(groups)
  const random = rng(seed)
  let atLeastAsExtreme = 0
  for (let trial = 0; trial < PERMUTATIONS; trial += 1) {
    const shuffled = [...pooled]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    let offset = 0
    const permuted = sizes.map((size) => {
      const values = shuffled.slice(offset, offset + size)
      offset += size
      return { values }
    })
    if (anovaF(permuted).F >= observed.F - 1e-12) atLeastAsExtreme += 1
  }
  const p = (atLeastAsExtreme + 1) / (PERMUTATIONS + 1)

  const summary = groups.map((group) => {
    const values = group.values
    const m = mean(values)
    const variance =
      values.length > 1
        ? values.reduce((acc, value) => acc + (value - m) ** 2, 0) /
          (values.length - 1)
        : 0
    const std = Math.sqrt(variance)
    return {
      label: group.label,
      n: values.length,
      mean: Number(m.toFixed(6)),
      std: Number(std.toFixed(6)),
      ci95: [
        Number((m - 1.96 * std / Math.sqrt(values.length)).toFixed(6)),
        Number((m + 1.96 * std / Math.sqrt(values.length)).toFixed(6)),
      ],
    }
  })

  const significant = p < 0.05
  // "Lowest" is only meaningful for cost metrics (RTF, latency). A silence
  // ratio is a taste choice: the numbers prove the knob works, not which
  // setting a listener prefers.
  const best =
    significant && direction === 'lower'
      ? summary.reduce((a, b) => (a.mean <= b.mean ? a : b)).label
      : null
  return {
    metric: label,
    direction,
    summary,
    F: Number(observed.F.toFixed(4)),
    etaSquared: Number(observed.eta2.toFixed(4)),
    permutationP: Number(p.toFixed(5)),
    permutations: PERMUTATIONS,
    significant,
    best,
    conclusion: !significant
      ? `组间差异不显著（p=${p.toFixed(5)}），不能宣称任何一组更优`
      : direction === 'lower'
        ? `组间差异显著（p=${p.toFixed(5)}），最低均值：${best}`
        : `组间差异显著（p=${p.toFixed(5)}），需按听感选择取值`,
  }
}

async function main() {
  const results = JSON.parse(await readFile(IN_FILE, 'utf8'))
  const samples = results.samples ?? {}
  const sets = [
    {
      metric: 'noiseScale → RTF',
      groups: [0.5, 0.667, 0.8].map((value) => ({
        label: String(value),
        values: samples[`noise-${value}`] ?? [],
      })),
    },
    {
      metric: 'silenceScale → silenceRatio',
      direction: 'none',
      groups: [0.8, 1, 1.2].map((value) => ({
        label: String(value),
        values: samples[`silence-${value}`] ?? [],
      })),
    },
    {
      metric: 'groupChars → synthMs',
      groups: [60, 90, 120].map((value) => ({
        label: String(value),
        values: samples[`group-${value}`] ?? [],
      })),
    },
  ]
  const report = {
    seed: results.grid?.seed ?? null,
    order: {
      noise: results.grid?.noiseOrder ?? null,
      silence: results.grid?.silenceOrder ?? null,
      group: results.grid?.groupOrder ?? null,
    },
    analyses: sets
      .filter((set) => set.groups.every((group) => group.values.length >= 2))
      .map((set) =>
        analyse(set.metric, set.groups, results.grid?.seed ?? 1, set.direction),
      ),
  }
  await writeFile(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`统计结果已写入 ${OUT_FILE}`)
  for (const item of report.analyses) {
    console.log(`\n${item.metric}`)
    for (const row of item.summary) {
      console.log(
        `  ${row.label.padEnd(6)} n=${row.n} mean=${row.mean} ` +
          `std=${row.std} CI95=[${row.ci95[0]}, ${row.ci95[1]}]`,
      )
    }
    console.log(`  F=${item.F} η²=${item.etaSquared} p=${item.permutationP}`)
    console.log(`  ${item.conclusion}`)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  })
}
