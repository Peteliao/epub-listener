/**
 * Experiment provenance for dev reports.
 *
 * A quality verdict is only meaningful when every input belongs to the same
 * code / voice pack / lexicon / corpus. These fingerprints are cheap hashes of
 * the checked-in inputs, not cryptographic attestations; they exist to stop
 * yesterday's envelope report from being mixed with today's gate results.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MATCHA_PACK_ID, ROOT } from './reading.mjs'

export const QUALITY_SUITE_VERSION = 'qe-18'

const LEXICON_FILES = [
  'src/core/tts/polyphones.v1.txt',
  'src/core/tts/phraseReadings.v1.txt',
  'src/core/tts/trainedNeutrals.v1.txt',
  'src/core/tts/approvedOverrides.v1.ts',
  'src/core/tts/utteranceResets.v1.txt',
  'src/core/tts/seamlessUtteranceResets.v1.txt',
  'src/core/tts/protectedWords.v1.txt',
  'src/core/tts/readingRules.v1.jsonl',
  'src/core/tts/acousticExceptions.v1.jsonl',
]

const CORPUS_FILES = [
  'tests/fixtures/blind-listening.v1.jsonl',
  'tests/fixtures/pronunciation-golden.jsonl',
  'tests/fixtures/pronunciation-regression.jsonl',
  'src/core/tts/omissionCases.v1.jsonl',
  'public/sample.epub',
]

/** Fields that must match across measurement reports. */
export const PROVENANCE_FIELDS = Object.freeze([
  'commit', 'packageVersion', 'suiteVersion', 'voicePack', 'lexicon', 'corpus',
  'experimentId',
])

/** Blind A/B intentionally spans versions; only the model and corpus must match. */
export const BLIND_PROVENANCE_FIELDS = Object.freeze([
  'suiteVersion', 'voicePack', 'corpus',
])

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

function hashFileList(files) {
  const hash = createHash('sha256')
  for (const relative of files) {
    hash.update(relative)
    try {
      hash.update(readFileSync(join(ROOT, relative)))
    } catch {
      hash.update('missing')
    }
  }
  return hash.digest('hex').slice(0, 16)
}

export function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    return null
  }
}

export function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** Voice-pack identity from the checked-in model manifest hashes. */
export function voicePackFingerprint() {
  try {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'public', 'models', 'manifest.json'), 'utf8'),
    )
    const pack = manifest.packs?.find((item) => item.id === MATCHA_PACK_ID)
    if (!pack) return null
    const files = [...(pack.files ?? [])].sort((left, right) => left.name.localeCompare(right.name))
    return sha256Text([
      pack.id,
      pack.version ?? '',
      ...files.map((file) => `${file.name}:${file.sha256 ?? ''}`),
    ].join('\n')).slice(0, 16)
  } catch {
    return null
  }
}

export function lexiconFingerprint() {
  return hashFileList(LEXICON_FILES)
}

export function corpusFingerprint() {
  return hashFileList(CORPUS_FILES)
}

export function currentProvenance({ experimentId } = {}) {
  return {
    schemaVersion: 1,
    commit: gitCommit(),
    packageVersion: packageVersion(),
    suiteVersion: QUALITY_SUITE_VERSION,
    voicePack: voicePackFingerprint(),
    lexicon: lexiconFingerprint(),
    corpus: corpusFingerprint(),
    experimentId: experimentId ?? process.env.SHANLAN_EXPERIMENT_ID ?? null,
    generatedAt: new Date().toISOString(),
  }
}

export function compareProvenance(expected, actual, fields = PROVENANCE_FIELDS) {
  const mismatches = []
  if (!expected || !actual) return mismatches
  for (const field of fields) {
    if (expected[field] == null || actual[field] == null) continue
    if (expected[field] !== actual[field]) {
      mismatches.push(`${field}: 期望 ${expected[field]}，实际 ${actual[field]}`)
    }
  }
  return mismatches
}

/**
 * `sources` entries are `{ name, kind?: 'blind', provenance }`.
 * An absent provenance is not silently trusted: it forces UNVERIFIED.
 */
export function checkProvenance(expected, sources = []) {
  if (!expected) {
    return { status: 'UNVERIFIED', ok: false, checked: 0, mismatches: [], unverified: ['expected'] }
  }
  if (!sources.length) {
    return { status: 'UNVERIFIED', ok: false, checked: 0, mismatches: [], unverified: ['no-sources'] }
  }
  const mismatches = []
  const unverified = []
  let checked = 0
  for (const source of sources) {
    const name = source?.name ?? 'unknown'
    if (!source?.provenance) {
      unverified.push(name)
      continue
    }
    checked += 1
    const fields = source.kind === 'blind' ? BLIND_PROVENANCE_FIELDS : PROVENANCE_FIELDS
    const actual = source.provenance
    const missing = fields.filter((field) =>
      expected[field] != null && actual[field] == null)
    if (missing.length) {
      unverified.push(`${name}: ${missing.join(', ')}`)
      continue
    }
    for (const mismatch of compareProvenance(expected, actual, fields)) {
      mismatches.push(`${name}: ${mismatch}`)
    }
  }
  if (mismatches.length) {
    return { status: 'MISMATCH', ok: false, checked, mismatches, unverified }
  }
  if (unverified.length) {
    return { status: 'UNVERIFIED', ok: false, checked, mismatches, unverified }
  }
  return { status: 'OK', ok: true, checked, mismatches, unverified }
}