import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lab = resolve(process.argv[2] ?? join(repo, '..', 'epub-tts-lab'))
const srcDir = join(lab, 'hojo')
const ortDir = join(lab, 'node_modules', 'onnxruntime-web', 'dist')
const modelDir = join(repo, 'public', 'models', 'hojo')
const runtimeDir = join(repo, 'public', 'hojo', 'runtime')
const chunkSize = 64 * 1024 * 1024

function fail(message) {
  console.error(`prepare-hojo-assets: ${message}`)
  process.exit(1)
}

for (const path of [srcDir, ortDir]) {
  if (!existsSync(path)) fail(`missing source directory: ${path}`)
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function copyHashed(source, target, url) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  return {
    name: target.slice(modelDir.length + 1).replaceAll('\\', '/'),
    url,
    bytes: statSync(target).size,
    sha256: await sha256File(target),
  }
}

async function chunkHashed(source, baseName, urlBase) {
  const handle = createReadStream(source, { highWaterMark: chunkSize })
  const whole = createHash('sha256')
  const parts = []
  let index = 0
  let total = 0

  for await (const chunk of handle) {
    whole.update(chunk)
    index += 1
    const partName = `${baseName}.part${index}`
    const partPath = join(modelDir, partName)
    const partHash = createHash('sha256').update(chunk).digest('hex')
    writeFileSync(partPath, chunk)
    const bytes = statSync(partPath).size
    parts.push({
      name: partName,
      url: `${urlBase}.part${index}`,
      bytes,
      sha256: partHash,
    })
    total += bytes
  }

  if (parts.length <= 1) {
    const part = parts[0]
    if (!part) fail(`no bytes read from ${source}`)
    return {
      name: baseName,
      url: urlBase,
      bytes: part.bytes,
      sha256: part.sha256,
    }
  }

  return {
    name: baseName,
    url: urlBase,
    bytes: total,
    sha256: whole.digest('hex'),
    parts,
  }
}

async function prepareModelFile(sourceName, { chunk = false } = {}) {
  const source = join(srcDir, sourceName)
  if (!existsSync(source)) fail(`missing model file: ${source}`)
  const url = `models/hojo/${sourceName}`
  if (chunk) {
    for (const name of [sourceName, `${sourceName}.part1`]) {
      try {
        rmSync(join(modelDir, name), { force: true })
      } catch {
        // Generated files are best-effort when absent.
      }
    }
    return chunkHashed(source, sourceName, url)
  }
  return copyHashed(source, join(modelDir, sourceName), url)
}

async function prepareRuntimeFile(name, sourceDir = ortDir, { keepExisting = false } = {}) {
  const target = join(runtimeDir, name)
  const source = join(sourceDir, name)
  if (keepExisting && existsSync(target)) {
    return {
      name,
      url: `hojo/runtime/${name}`,
      bytes: statSync(target).size,
      sha256: await sha256File(target),
    }
  }
  if (!existsSync(source)) fail(`missing runtime file: ${source}`)
  mkdirSync(runtimeDir, { recursive: true })
  copyFileSync(source, target)
  return {
    name,
    url: `hojo/runtime/${name}`,
    bytes: statSync(target).size,
    sha256: await sha256File(target),
  }
}

async function main() {
  rmSync(modelDir, { recursive: true, force: true })
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  const runtimeFiles = []
  for (const name of [
    'ort.wasm.min.js',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ]) {
    runtimeFiles.push(await prepareRuntimeFile(name))
  }
  // These two are edited in the repo; keep them across regenerations.
  for (const name of ['hojo-core.js', 'hojo-tok.js']) {
    runtimeFiles.push(await prepareRuntimeFile(name, srcDir, { keepExisting: true }))
  }

  const fullShared = [
    await prepareModelFile('fine_local.onnx'),
    await prepareModelFile('decoder.onnx', { chunk: true }),
    await prepareModelFile('token_embedding.f16'),
    await prepareModelFile('voices.json'),
    await prepareModelFile('tok.json'),
  ]
  const fullFiles = [
    await prepareModelFile('llm.onnx', { chunk: true }),
    ...fullShared,
  ]
  const int8Files = [
    await prepareModelFile('llm-int8.onnx'),
    ...fullShared,
  ]

  const sum = (files) => files.reduce((total, file) => total + file.bytes, 0)
  const fullBytes = sum(fullFiles)
  const int8Bytes = sum(int8Files)
  const runtimeBytes = sum(runtimeFiles)

  const voicesJson = JSON.parse(readFileSync(join(srcDir, 'voices.json'), 'utf8'))
  const voiceIds = voicesJson.voice_ids
  const zhLabels = ['岚一', '岚二']
  const zhDescriptions = [
    'Hojo 中文女声，声线清亮，适合叙事',
    'Hojo 中文女声，语调柔和，适合长时间听书',
  ]

  const voices = voiceIds.map((voiceId, speakerId) => {
    const match = /^hojo_(zh|en)_([fmu])_(\d+)$/.exec(voiceId)
    if (!match) fail(`unexpected voice id: ${voiceId}`)
    const [, lang, kind, number] = match
    if (lang === 'zh') {
      const index = Number(number) - 1
      return {
        id: `hojo-zh-${kind}-${number}`,
        lang: 'zh',
        speakerId,
        sampleRate: 24000,
        label: zhLabels[index] ?? `中文音色 ${number}`,
        description: zhDescriptions[index] ?? 'Hojo 中文音色',
      }
    }
    const kindLabel = kind === 'f' ? '女声' : kind === 'm' ? '男声' : '中性声'
    return {
      id: `hojo-en-${kind}-${number}`,
      lang: 'en',
      speakerId,
      sampleRate: 24000,
      label: `英文${kindLabel} ${number}`,
      description: `Hojo 英文${kindLabel}，适合中英混排与英文朗读`,
    }
  })

  const manifestPath = join(repo, 'public', 'models', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.schemaVersion = 4
  for (const pack of manifest.packs) {
    pack.engine = 'sherpa'
  }
  manifest.hojoRuntime = {
    version: 'hojo-web-2026.11.06-2',
    baseUrl: 'hojo/runtime/',
    bytes: runtimeBytes,
    files: runtimeFiles,
  }
  const hojoPack = {
    id: 'hojo-light',
    engine: 'hojo',
    lang: 'bi',
    name: 'Hojo 双语',
    version: '2026.11.06',
    description:
      '40M 参数中英双语模型，中英混读自然；桌面端使用完整版，移动端自动使用 int8 轻量版',
    license: {
      label: 'Apache-2.0',
      commercialUse: true,
      url: 'https://huggingface.co/HojoAI/Hojo-TTS-Light-40M',
      notice:
        'Hojo-TTS-Light-40M 以 Apache-2.0 释出；移动版 LM 采用社区 int8 量化，解码器与 FineLocal 保持 fp32 以保护音质。',
    },
    baseUrl: 'models/hojo/',
    model: {
      type: 'hojo',
      config: {
        temperature: 0.8,
        topP: 0.95,
        seed: 42,
      },
    },
    voices,
    totalBytes: Math.max(fullBytes, int8Bytes),
    variants: [
      {
        id: 'full',
        label: '桌面完整版',
        description: '完整 LM，音质与稳定性优先',
        totalBytes: fullBytes,
        files: fullFiles,
      },
      {
        id: 'int8',
        label: '移动轻量版',
        description: 'int8 LM，下载与内存更小；解码器保持 fp32',
        totalBytes: int8Bytes,
        files: int8Files,
      },
    ],
  }
  manifest.packs = manifest.packs.filter((pack) => pack.id !== hojoPack.id)
  manifest.packs.push(hojoPack)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const mb = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`
  console.log(`runtime ${mb(runtimeBytes)}`)
  console.log(`full ${mb(fullBytes)} (${fullFiles.length} files)`)
  console.log(`int8 ${mb(int8Bytes)} (${int8Files.length} files)`)
  console.log(`voices ${voices.length} · zh ${voices.filter((v) => v.lang === 'zh').length}`)
  console.log(`manifest ${manifestPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
