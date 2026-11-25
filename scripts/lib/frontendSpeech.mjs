// Execute the actual production TypeScript text functions in Node. These two
// modules have no browser dependencies; pronunciationGuard's ?raw imports are
// replaced with the same checked-in text assets before TypeScript transpilation.
// No text rule is copied here, so C1 changes cannot silently drift from audits.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { ROOT } from './reading.mjs'

const SOURCES = [
  'src/core/text/TextNormalizer.ts',
  'src/core/text/SpeechPhrasing.ts',
  'src/core/tts/pronunciationGuard.ts',
  'src/core/tts/protectedWords.v1.txt',
  'src/core/tts/utteranceResets.v1.txt',
]

const cache = new Map()

function hash(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function loadProductionModule(relative) {
  const path = join(ROOT, relative)
  let source = readFileSync(path, 'utf8')
  source = source.replace(
    /import\s+(\w+)\s+from\s+['"]([^'"]+)\?raw['"]/g,
    (_match, binding, asset) => `const ${binding} = ${JSON.stringify(
      readFileSync(join(ROOT, 'src/core/tts', asset), 'utf8'),
    )}`,
  )
  if (source.includes('?raw')) throw new Error(`未处理的 ?raw 导入：${relative}`)
  const { outputText } = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
  })
  const digest = hash(outputText)
  if (!cache.has(digest)) {
    cache.set(digest, import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}#${digest}`))
  }
  return cache.get(digest)
}

export const FRONTEND_SPEECH_VERSION = 'frontend-speech-source-sha256-v1'

export async function loadFrontendSpeech() {
  const [normalizer, phrasing, guard] = await Promise.all(
    SOURCES.slice(0, 3).map(loadProductionModule),
  )
  const versions = Object.fromEntries(SOURCES.map((relative) => [
    relative,
    hash(readFileSync(join(ROOT, relative))),
  ]))
  return {
    ...normalizer,
    ...phrasing,
    ...guard,
    version: {
      id: FRONTEND_SPEECH_VERSION,
      typescript: ts.version,
      sources: versions,
    },
  }
}

/** normalizeSpeechText -> planSpeechPhrasing -> dynamic overlay guard. */
export function prepareFrontendSpeechText(text, overlayText, frontend) {
  const normalizedText = frontend.normalizeSpeechText(String(text))
  const plannedText = frontend.planSpeechPhrasing(normalizedText)
  const protectedWords = frontend.overlayProtectedWords(overlayText)
  const speechText = frontend.preparePronunciationText(plannedText, protectedWords)
  return { normalizedText, plannedText, protectedWords, speechText }
}
