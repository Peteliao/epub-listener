#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './lib/reading.mjs'
import { buildQualityReport, formatQualityReport } from './lib/qualityReport.mjs'

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

function blindReveals() {
  if (!existsSync(BLIND)) return []
  return readdirSync(BLIND)
    .filter((name) => name.endsWith('.key.json'))
    .map((name) => readJson(resolve(BLIND, name.replace(/\.key\.json$/, '.reveal.json')))
      ?? readJson(resolve(BLIND, name.replace(/\.key\.json$/, ''), 'reveal.json')))
    .filter(Boolean)
}

function main() {
  const gates = readJson(resolve(OUT, 'gate-results.json'))?.gates ?? []
  const envelope = readJson(resolve(OUT, 'envelope-report.json'))?.results ?? []
  const oovFile = resolve(OUT, 'oov-recall.jsonl')
  const oovSample = existsSync(oovFile)
    ? readFileSync(oovFile, 'utf8').split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
    : []
  const report = buildQualityReport({
    gates,
    envelope,
    oovRecall: Array.isArray(oovSample) ? { sample: oovSample } : oovSample,
    blindReveals: blindReveals(),
    selfIteration: readJson(resolve(OUT, 'self-iteration-verify.json')),
  })
  writeFileSync(resolve(OUT, 'quality-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(resolve(OUT, 'quality-report.md'), `${formatQualityReport(report)}\n`, 'utf8')
  console.log(`质量状态：${report.status}`)
  console.log(`报告 ${resolve(OUT, 'quality-report.md')}`)
}

main()
