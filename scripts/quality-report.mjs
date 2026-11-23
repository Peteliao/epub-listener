#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import { buildQualityReport, formatQualityReport } from './lib/qualityReport.mjs'
import { currentProvenance } from './lib/provenance.mjs'

const OUT = resolve(ROOT, 'scripts/out')
const BLIND = resolve(OUT, 'blind')

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readOov(file) {
  if (!existsSync(file)) return { exists: false, sample: [], provenance: null }
  let provenance = null
  const sample = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('# provenance ')) {
        try {
          provenance = JSON.parse(trimmed.slice('# provenance '.length))
        } catch {
          provenance = null
        }
      }
      continue
    }
    sample.push(JSON.parse(trimmed))
  }
  return { exists: true, sample, provenance }
}

function blindReveals() {
  if (!existsSync(BLIND)) return []
  return readdirSync(BLIND)
    .filter((name) => name.endsWith('.reveal.json'))
    .map((name) => readJson(resolve(BLIND, name)))
    .filter(Boolean)
}

function main() {
  const gateData = readJson(resolve(OUT, 'gate-results.json'))
  const envelopeData = readJson(resolve(OUT, 'envelope-report.json'))
  // Prefer the audit-run sample so every input shares one experiment id;
  // fall back to a manually produced recall file.
  const gateOov = resolve(OUT, 'gate-oov-recall.jsonl')
  const oov = readOov(existsSync(gateOov) ? gateOov : resolve(OUT, 'oov-recall.jsonl'))
  const selfIteration = readJson(resolve(OUT, 'self-iteration-verify.json'))
  const reveals = blindReveals()
  const experimentId = gateData?.provenance?.experimentId ?? undefined

  const sources = []
  if (gateData) sources.push({ name: 'gate-results', provenance: gateData.provenance })
  if (envelopeData) sources.push({ name: 'envelope-report', provenance: envelopeData.provenance })
  if (oov.exists) sources.push({ name: 'oov-recall', provenance: oov.provenance })
  if (selfIteration) sources.push({ name: 'self-iteration', provenance: selfIteration.provenance })
  for (const reveal of reveals) {
    const name = `blind-${reveal.experimentId ?? 'unknown'}`
    sources.push({ name, kind: 'blind', provenance: reveal.provenance })
    for (const [tag, provenance] of Object.entries(reveal.sources ?? {})) {
      if (provenance) sources.push({ name: `${name}-audio:${tag}`, kind: 'blind', provenance })
    }
  }

  const report = buildQualityReport({
    gates: gateData?.gates ?? [],
    envelope: envelopeData?.results ?? [],
    oovRecall: { sample: oov.sample },
    blindReveals: reveals,
    selfIteration,
    provenance: {
      expected: currentProvenance({ experimentId }),
      sources,
    },
  })
  writeFileSync(resolve(OUT, 'quality-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(resolve(OUT, 'quality-report.md'), `${formatQualityReport(report)}\n`, 'utf8')
  console.log(`质量状态：${report.status}`)
  console.log(`数据版本：${report.provenance.status}`)
  for (const reason of report.reasons) console.log(`  - ${reason}`)
  console.log(`报告 ${resolve(OUT, 'quality-report.md')}`)
}

main()
