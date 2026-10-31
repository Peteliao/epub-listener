import polyphoneOverlay from './polyphones.v1.txt?raw'

export type AiPhase =
  | 'unsupported'
  | 'loading'
  | 'missing'
  | 'downloading'
  | 'ready'
  | 'error'

export type AiPackPhase = 'missing' | 'downloading' | 'ready' | 'error'

export type AiModelType = 'vits' | 'matcha' | 'kokoro'

export interface AiPackLicense {
  label: string
  commercialUse: boolean
  notice: string
  url: string | null
}

export type AiPackLang = 'zh' | 'en'

export interface AiVoiceStatus {
  id: string
  label: string
  description: string
  speakerId: number
  sampleRate: number
  packId: string
  packName: string
  lang: AiPackLang
  commercialUse: boolean
  licenseLabel: string
}

export interface AiPackStatus {
  id: string
  lang: AiPackLang
  name: string
  version: string
  description: string
  license: AiPackLicense
  phase: AiPackPhase
  modelBytes: number
  runtimeBytes: number
  totalBytes: number
  downloadedBytes: number
  persisted: boolean
  message: string | null
  error: string | null
  voices: AiVoiceStatus[]
}

export interface AiModelStatus {
  supported: boolean
  phase: AiPhase
  /** Chinese narration packs only; the English pack is exposed separately. */
  packs: AiPackStatus[]
  englishPack: AiPackStatus | null
  selectedVoiceId: string
  selectedVoice: AiVoiceStatus | null
  runtimeBytes: number
  persisted: boolean
  modelBytes: number
  totalBytes: number
  downloadedBytes: number
  voiceLabel: string
  voiceDescription: string
  voiceLicense: string
  commercialUse: boolean
  version: string
  message: string | null
  error: string | null
}

export interface AiModelDefinition {
  type: AiModelType
  config: Record<string, string | string[] | number>
  ruleFsts: string[]
  warmupText?: string
}

export interface AiRuntimeFile {
  name: string
  url: string
  bytes: number
  sha256: string
}

export interface AiRuntimeConfig {
  runtimeBaseUrl: string
  glueUrl: string
  apiUrl: string
  wasmUrl: string
  modelCacheName: string
  packId: string
  lang: AiPackLang
  voiceId: string
  speakerId: number
  sampleRate: number
  voiceLabel: string
  model: AiModelDefinition
  lexiconOverlay?: string
  files: AiRuntimeFile[]
}

export interface AiLexiconAssets {
  cacheName: string
  lexiconUrl: string
  tokensUrl: string
  lexiconName: string
  packId: string
  packVersion: string
}

interface ManifestFile {
  name: string
  url: string
  bytes: number
  sha256: string
}

interface ManifestLicense {
  label: string
  commercialUse: boolean
  notice: string
  url?: string
}

interface ManifestModel {
  type: AiModelType
  config: Record<string, string | string[] | number>
  ruleFsts?: string[]
  warmupText?: string
}

interface ManifestVoice {
  id: string
  speakerId: number
  sampleRate: number
  label: string
  description?: string
}

interface ManifestPack {
  id: string
  lang?: AiPackLang
  name: string
  version: string
  description: string
  license: ManifestLicense
  baseUrl: string
  model: ManifestModel
  voices: ManifestVoice[]
  totalBytes: number
  files: ManifestFile[]
}

interface ManifestRuntime {
  version: string
  baseUrl: string
  glue: string
  api: string
  wasm: string
  bytes: number
  glueBytes: number
  apiBytes: number
  wasmBytes: number
  glueSha256: string
  wasmSha256: string
  apiSha256: string
}

interface AiManifest {
  schemaVersion: number
  runtime: ManifestRuntime
  packs: ManifestPack[]
}

interface PackRuntimeState {
  phase: AiPackPhase
  downloadedBytes: number
  persisted: boolean
  message: string | null
  error: string | null
}

interface CacheInspection {
  present: boolean
  downloadedBytes: number
}

const MANIFEST_STORAGE_KEY = 'shusheng.ai.manifest.v3'
const LEGACY_MANIFEST_STORAGE_KEYS = ['shusheng.ai.manifest.v2']
const CACHE_PREFIX = 'shusheng-tts-'
const MODEL_CACHE_PREFIX = `${CACHE_PREFIX}model-`
const RUNTIME_CACHE_PREFIX = `${CACHE_PREFIX}runtime-`
const MODEL_TYPES: readonly AiModelType[] = ['vits', 'matcha', 'kokoro']

function resolveUrl(path: string): string {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI)
  return new URL(path, base).href
}

// importScripts and instantiateStreaming reject cached responses without
// a usable MIME type, so preserve one when re-wrapping downloaded bytes.
function contentTypeFor(url: string): string {
  const path = url.split('?')[0] ?? url
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.wasm')) return 'application/wasm'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}

function errorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '设备存储空间不足，请清理空间后重试。'
  }
  if (error instanceof Error && error.message) return error.message
  return '离线音色包准备失败，请重试。'
}

function hashToHex(buffer: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(''),
  )
}

function isModelConfig(
  value: unknown,
): value is Record<string, string | string[] | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(
    (item) =>
      typeof item === 'string' ||
      typeof item === 'number' ||
      (Array.isArray(item) && item.every((entry) => typeof entry === 'string')),
  )
}

function isHexHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function isManifestModel(value: unknown): value is ManifestModel {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<ManifestModel>
  return (
    MODEL_TYPES.includes(model.type as AiModelType) &&
    isModelConfig(model.config) &&
    (model.ruleFsts === undefined ||
      (Array.isArray(model.ruleFsts) &&
        model.ruleFsts.every((item) => typeof item === 'string'))) &&
    (model.warmupText === undefined || typeof model.warmupText === 'string')
  )
}

function isManifestFile(value: unknown): value is ManifestFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<ManifestFile>
  return (
    typeof file.name === 'string' &&
    file.name.length > 0 &&
    typeof file.url === 'string' &&
    file.url.length > 0 &&
    typeof file.bytes === 'number' &&
    file.bytes > 0 &&
    isHexHash(file.sha256)
  )
}

function isManifestLicense(value: unknown): value is ManifestLicense {
  if (!value || typeof value !== 'object') return false
  const license = value as Partial<ManifestLicense>
  return (
    typeof license.label === 'string' &&
    license.label.length > 0 &&
    typeof license.commercialUse === 'boolean' &&
    typeof license.notice === 'string' &&
    license.notice.length > 0 &&
    (license.url === undefined || typeof license.url === 'string')
  )
}

function isManifestVoice(value: unknown): value is ManifestVoice {
  if (!value || typeof value !== 'object') return false
  const voice = value as Partial<ManifestVoice>
  return (
    typeof voice.id === 'string' &&
    voice.id.length > 0 &&
    typeof voice.speakerId === 'number' &&
    Number.isInteger(voice.speakerId) &&
    voice.speakerId >= 0 &&
    typeof voice.sampleRate === 'number' &&
    voice.sampleRate > 0 &&
    typeof voice.label === 'string' &&
    voice.label.length > 0 &&
    (voice.description === undefined || typeof voice.description === 'string')
  )
}

function isManifestPack(value: unknown): value is ManifestPack {
  if (!value || typeof value !== 'object') return false
  const pack = value as Partial<ManifestPack>
  const files = pack.files
  const voices = pack.voices
  if (
    typeof pack.id !== 'string' ||
    pack.id.length === 0 ||
    typeof pack.name !== 'string' ||
    pack.name.length === 0 ||
    typeof pack.version !== 'string' ||
    pack.version.length === 0 ||
    typeof pack.description !== 'string' ||
    (pack.lang !== undefined && pack.lang !== 'zh' && pack.lang !== 'en') ||
    typeof pack.baseUrl !== 'string' ||
    pack.baseUrl.length === 0 ||
    !isManifestLicense(pack.license) ||
    !isManifestModel(pack.model) ||
    typeof pack.totalBytes !== 'number' ||
    pack.totalBytes <= 0 ||
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every(isManifestFile) ||
    new Set(files.map((file) => file.name)).size !== files.length ||
    !Array.isArray(voices) ||
    voices.length === 0 ||
    !voices.every(isManifestVoice) ||
    new Set(voices.map((voice) => voice.id)).size !== voices.length
  ) {
    return false
  }
  const fileBytes = files.reduce((total, file) => total + file.bytes, 0)
  return fileBytes === pack.totalBytes
}

function isManifestRuntime(value: unknown): value is ManifestRuntime {
  if (!value || typeof value !== 'object') return false
  const runtime = value as Partial<ManifestRuntime>
  return (
    typeof runtime.version === 'string' &&
    runtime.version.length > 0 &&
    typeof runtime.baseUrl === 'string' &&
    typeof runtime.glue === 'string' &&
    typeof runtime.api === 'string' &&
    typeof runtime.wasm === 'string' &&
    typeof runtime.bytes === 'number' &&
    runtime.bytes > 0 &&
    typeof runtime.glueBytes === 'number' &&
    runtime.glueBytes > 0 &&
    typeof runtime.apiBytes === 'number' &&
    runtime.apiBytes > 0 &&
    typeof runtime.wasmBytes === 'number' &&
    runtime.wasmBytes > 0 &&
    isHexHash(runtime.glueSha256) &&
    isHexHash(runtime.wasmSha256) &&
    isHexHash(runtime.apiSha256)
  )
}

function isManifest(value: unknown): value is AiManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<AiManifest>
  const packs = manifest.packs
  if (
    manifest.schemaVersion !== 3 ||
    !isManifestRuntime(manifest.runtime) ||
    !Array.isArray(packs) ||
    packs.length === 0 ||
    !packs.every(isManifestPack)
  ) {
    return false
  }
  const packIds = new Set(packs.map((pack) => pack.id))
  if (packIds.size !== packs.length) return false
  const voiceIds = new Set<string>()
  for (const pack of packs) {
    for (const voice of pack.voices) {
      if (voiceIds.has(voice.id)) return false
      voiceIds.add(voice.id)
    }
  }
  return true
}

function supportsAi(): boolean {
  const audio =
    'AudioContext' in window ||
    'webkitAudioContext' in (window as unknown as Record<string, unknown>)
  return (
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    'caches' in window &&
    Boolean(crypto?.subtle) &&
    audio
  )
}

function emptyPackState(): PackRuntimeState {
  return {
    phase: 'missing',
    downloadedBytes: 0,
    persisted: false,
    message: null,
    error: null,
  }
}

export class AiModelManager {
  private status: AiModelStatus = {
    supported: false,
    phase: 'unsupported',
    packs: [],
    englishPack: null,
    selectedVoiceId: '',
    selectedVoice: null,
    runtimeBytes: 0,
    persisted: false,
    modelBytes: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    voiceLabel: '离线 AI 音色',
    voiceDescription: '',
    voiceLicense: '',
    commercialUse: false,
    version: '',
    message: null,
    error: null,
  }

  private manifest: AiManifest | null = null
  private selectedVoiceId: string
  private readonly packStates = new Map<string, PackRuntimeState>()
  private readonly listeners = new Set<(status: AiModelStatus) => void>()
  private downloadTask: Promise<void> | null = null
  private persisted = false
  private lastProgressAt = 0

  constructor(selectedVoiceId = 'shanlan') {
    this.selectedVoiceId = selectedVoiceId
    this.status.supported = supportsAi()
    if (!this.status.supported) {
      this.status.phase = 'unsupported'
    } else {
      this.status.phase = 'loading'
      this.status.selectedVoiceId = selectedVoiceId
    }
  }

  getStatus(): AiModelStatus {
    return { ...this.status, packs: this.status.packs.slice() }
  }

  get isReady(): boolean {
    return this.status.phase === 'ready'
  }

  getVoice(voiceId: string): AiVoiceStatus | null {
    if (!this.manifest) return null
    return this.voiceStatus(voiceId)
  }

  getEnglishVoice(): AiVoiceStatus | null {
    return this.status.englishPack?.voices[0] ?? null
  }

  subscribe(listener: (status: AiModelStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  selectVoice(voiceId: string): boolean {
    const voice = this.voiceStatus(voiceId)
    if (!voice || voice.lang === 'en') return false
    if (this.selectedVoiceId !== voiceId) {
      this.selectedVoiceId = voiceId
      this.rebuildStatus()
    }
    return true
  }

  async refresh(): Promise<AiModelStatus> {
    if (!this.status.supported) return this.getStatus()
    if (this.downloadTask) return this.getStatus()

    try {
      const manifest = await this.loadManifest()
      this.manifest = manifest
      this.ensurePackStates(manifest)
      this.ensureSelectedVoice(manifest)

      const runtime = await this.inspectRuntime(manifest)
      const persisted = await this.isPersisted()
      this.persisted = persisted

      for (const pack of manifest.packs) {
        const model = await this.inspectPack(pack)
        const previous = this.packStates.get(pack.id) ?? emptyPackState()
        this.packStates.set(pack.id, {
          phase: model.present && runtime.present ? 'ready' : 'missing',
          downloadedBytes:
            model.downloadedBytes + (runtime.present ? manifest.runtime.bytes : 0),
          persisted,
          message: previous.phase === 'error' ? previous.message : null,
          error: previous.phase === 'error' ? previous.error : null,
        })
      }

      this.rebuildStatus()
    } catch (error) {
      this.fatalError(
        error instanceof Error && error.message
          ? error.message
          : '无法读取离线音色清单。',
      )
    }

    return this.getStatus()
  }

  async download(packId: string): Promise<void> {
    if (!this.status.supported) {
      throw new Error('当前浏览器不支持离线 AI 音色。')
    }
    if (this.downloadTask) {
      throw new Error('已有音色包正在下载，请稍候。')
    }

    this.downloadTask = this.runDownload(packId).finally(() => {
      this.downloadTask = null
    })
    return this.downloadTask
  }

  async remove(packId: string): Promise<void> {
    if (this.downloadTask) {
      throw new Error('音色包正在下载，请稍后再删除。')
    }
    const pack = this.packDefinition(packId)
    if (!pack) throw new Error('找不到要删除的音色包。')

    await caches.delete(this.modelCacheName(pack))
    this.packStates.set(pack.id, {
      ...emptyPackState(),
      phase: 'missing',
      persisted: this.persisted,
    })

    const remaining = await caches.keys()
    const hasOtherPack = remaining.some(
      (name) => name.startsWith(MODEL_CACHE_PREFIX) && name !== this.modelCacheName(pack),
    )
    if (!hasOtherPack && this.manifest) {
      await caches.delete(this.runtimeCacheName(this.manifest))
    }

    this.rebuildStatus()
  }

  async loadPack(voiceId: string, bookOverlay?: string): Promise<AiRuntimeConfig> {
    if (!this.manifest) {
      this.manifest = await this.loadManifest()
      this.ensurePackStates(this.manifest)
      this.ensureSelectedVoice(this.manifest)
    }
    const manifest = this.manifest
    const voice = this.voiceStatus(voiceId)
    const pack = voice ? this.packDefinition(voice.packId) : null
    if (!voice || !pack) {
      throw new Error('所选离线音色不存在，请重新选择。')
    }

    const modelCacheName = this.modelCacheName(pack)
    const model = await this.inspectPack(pack)
    if (!model.present) {
      this.markPackMissing(pack, model.downloadedBytes)
      throw new Error('离线音色包不完整，请重新下载。')
    }

    const runtime = await this.inspectRuntime(manifest)
    if (!runtime.present) {
      this.markPackMissing(
        pack,
        model.downloadedBytes + runtime.downloadedBytes,
      )
      throw new Error('离线语音运行时缺失，请重新下载音色包。')
    }

    this.packStates.set(pack.id, {
      phase: 'ready',
      downloadedBytes: model.downloadedBytes + runtime.downloadedBytes,
      persisted: this.persisted,
      message: null,
      error: null,
    })
    this.rebuildStatus()

    const runtimeRoot = new URL(manifest.runtime.baseUrl, resolveUrl(''))

    const lexiconOverlay =
      pack.model.type === 'matcha' &&
      typeof pack.model.config.lexicon === 'string'
        ? [polyphoneOverlay, bookOverlay?.trim()].filter(Boolean).join('\n')
        : undefined

    // The worker hashes each file while streaming it into MEMFS, so the main
    // thread never has to hold the whole (100 MB+) voice pack at once.
    return {
      runtimeBaseUrl: runtimeRoot.href,
      glueUrl: new URL(manifest.runtime.glue, runtimeRoot).href,
      apiUrl: new URL(manifest.runtime.api, runtimeRoot).href,
      wasmUrl: new URL(manifest.runtime.wasm, runtimeRoot).href,
      modelCacheName,
      packId: pack.id,
      lang: pack.lang === 'en' ? 'en' : 'zh',
      voiceId: voice.id,
      speakerId: voice.speakerId,
      sampleRate: voice.sampleRate,
      voiceLabel: voice.label,
      model: {
        type: pack.model.type,
        config: pack.model.config,
        ruleFsts: pack.model.ruleFsts ?? [],
        ...(pack.model.warmupText ? { warmupText: pack.model.warmupText } : {}),
      },
      ...(lexiconOverlay ? { lexiconOverlay } : {}),
      files: pack.files.map((file) => ({
        ...file,
        url: resolveUrl(file.url),
      })),
    }
  }

  async getLexiconAssets(voiceId: string): Promise<AiLexiconAssets | null> {
    if (!this.manifest) {
      this.manifest = await this.loadManifest()
      this.ensurePackStates(this.manifest)
      this.ensureSelectedVoice(this.manifest)
    }
    const voice = this.voiceStatus(voiceId)
    const pack = voice ? this.packDefinition(voice.packId) : null
    if (!voice || !pack || pack.model.type !== 'matcha') return null
    const lexiconName = pack.model.config.lexicon
    if (typeof lexiconName !== 'string') return null
    const lexiconFile = pack.files.find((file) => file.name === lexiconName)
    const tokensFile = pack.files.find((file) => file.name === 'tokens.txt')
    if (!lexiconFile || !tokensFile) return null
    return {
      cacheName: this.modelCacheName(pack),
      lexiconUrl: resolveUrl(lexiconFile.url),
      tokensUrl: resolveUrl(tokensFile.url),
      lexiconName,
      packId: pack.id,
      packVersion: pack.version,
    }
  }

  private async runDownload(packId: string): Promise<void> {
    let manifest: AiManifest
    try {
      manifest = await this.loadManifest(true)
    } catch (error) {
      this.fatalError(errorText(error))
      throw new Error(errorText(error))
    }

    this.manifest = manifest
    this.ensurePackStates(manifest)
    this.ensureSelectedVoice(manifest)
    const pack = manifest.packs.find((item) => item.id === packId)
    if (!pack) {
      throw new Error('音色清单中找不到这个音色包，请刷新页面后重试。')
    }
    this.packStates.set(pack.id, {
      ...(this.packStates.get(pack.id) ?? emptyPackState()),
      phase: 'downloading',
      downloadedBytes: 0,
      message: '正在读取音色清单…',
      error: null,
    })
    this.rebuildStatus()

    const modelCacheName = this.modelCacheName(pack)
    const runtimeCacheName = this.runtimeCacheName(manifest)
    const total = pack.totalBytes + manifest.runtime.bytes
    let downloaded = 0

    try {
      const modelCache = await caches.open(modelCacheName)
      const runtimeCache = await caches.open(runtimeCacheName)
      this.patchPackState(pack.id, {
        message: '正在准备模型文件…',
      })

      for (const file of pack.files) {
        const url = resolveUrl(file.url)
        const cached = await this.readVerified(modelCache, url, file.bytes, file.sha256)
        if (cached) {
          downloaded += file.bytes
          this.reportProgress(pack.id, downloaded, `正在检查 ${file.name}…`)
          continue
        }

        const buffer = await this.fetchFile(
          url,
          file.bytes,
          downloaded,
          `正在下载 ${file.name}`,
          pack.id,
        )
        this.patchPackState(pack.id, { message: `正在校验 ${file.name}…` })
        const digest = await hashToHex(buffer)
        if (digest !== file.sha256.toLowerCase()) {
          throw new Error(`${file.name} 校验失败，请重试。`)
        }
        await modelCache.put(
          url,
          new Response(buffer, { headers: { 'Content-Type': contentTypeFor(url) } }),
        )
        downloaded += file.bytes
        this.reportProgress(pack.id, downloaded, `已缓存 ${file.name}`)
      }

      for (const [name, url, bytes] of this.runtimeEntries(manifest)) {
        const absolute = resolveUrl(url)
        const expected = this.runtimeHash(manifest, name)
        const cached = await this.readVerified(runtimeCache, absolute, bytes, expected)
        if (cached) {
          downloaded += bytes
          this.reportProgress(pack.id, downloaded, '正在检查离线运行时…')
          continue
        }

        const buffer = await this.fetchFile(
          absolute,
          bytes,
          downloaded,
          '正在下载离线运行时',
          pack.id,
        )
        this.patchPackState(pack.id, { message: '正在校验离线运行时…' })
        const digest = await hashToHex(buffer)
        if (digest !== expected.toLowerCase()) {
          throw new Error('离线运行时校验失败，请重试。')
        }
        await runtimeCache.put(
          absolute,
          new Response(buffer, {
            headers: { 'Content-Type': contentTypeFor(absolute) },
          }),
        )
        downloaded += bytes
        this.reportProgress(pack.id, downloaded, '已缓存离线运行时')
      }

      this.persisted = await this.requestPersistence()
      await this.removeOldCaches(manifest)
      this.packStates.set(pack.id, {
        phase: 'ready',
        downloadedBytes: total,
        persisted: this.persisted,
        message: null,
        error: null,
      })
      this.rebuildStatus()
    } catch (error) {
      const message = errorText(error)
      this.packStates.set(pack.id, {
        ...(this.packStates.get(pack.id) ?? emptyPackState()),
        phase: 'error',
        message: null,
        error: message,
        persisted: this.persisted,
      })
      this.rebuildStatus()
      throw new Error(message)
    }
  }

  private async fetchFile(
    url: string,
    expectedBytes: number,
    baseBytes: number,
    label: string,
    packId: string,
  ): Promise<ArrayBuffer> {
    let response: Response
    try {
      response = await fetch(url, { cache: 'no-store' })
    } catch {
      throw new Error('下载失败，请检查网络连接后重试。')
    }
    if (!response.ok) {
      throw new Error(`下载失败（${response.status}），请稍后重试。`)
    }

    const total = Number(response.headers.get('content-length')) || expectedBytes
    if (!response.body) {
      const buffer = await response.arrayBuffer()
      this.reportProgress(
        packId,
        baseBytes + buffer.byteLength,
        `${label} · ${formatBytes(buffer.byteLength)}`,
      )
      return buffer
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      this.reportProgress(
        packId,
        baseBytes + loaded,
        `${label} · ${formatBytes(loaded)} / ${formatBytes(total)}`,
      )
    }

    const buffer = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.byteLength
    }
    return buffer.buffer
  }

  private async readVerified(
    cache: Cache,
    url: string,
    expectedBytes: number,
    expectedHash: string,
  ): Promise<boolean> {
    const response = await cache.match(url)
    if (!response) return false
    try {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== expectedBytes) return false
      return (await hashToHex(buffer)) === expectedHash.toLowerCase()
    } catch {
      return false
    }
  }

  private reportProgress(
    packId: string,
    downloaded: number,
    message: string,
  ): void {
    const state = this.packStates.get(packId)
    if (!state) return
    state.downloadedBytes = downloaded
    state.message = message
    const now = Date.now()
    if (now - this.lastProgressAt < 80) return
    this.lastProgressAt = now
    this.rebuildStatus()
  }

  private async loadManifest(forceNetwork = false): Promise<AiManifest> {
    const url = resolveUrl('models/manifest.json')
    let lastError: unknown = null

    try {
      const response = await fetch(url, { cache: forceNetwork ? 'no-store' : 'no-cache' })
      if (!response.ok) throw new Error(`音色清单读取失败（${response.status}）。`)
      const raw: unknown = await response.json()
      if (!isManifest(raw)) throw new Error('音色清单格式不正确。')
      try {
        localStorage.setItem(MANIFEST_STORAGE_KEY, JSON.stringify(raw))
        for (const key of LEGACY_MANIFEST_STORAGE_KEYS) {
          localStorage.removeItem(key)
        }
      } catch {
        // Storage may be unavailable; the cache still works this session.
      }
      return raw
    } catch (error) {
      lastError = error
    }

    try {
      const stored = localStorage.getItem(MANIFEST_STORAGE_KEY)
      if (stored) {
        const raw: unknown = JSON.parse(stored)
        if (isManifest(raw)) return raw
      }
    } catch {
      // Ignore a corrupted fallback and report the original error.
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('无法读取离线音色清单。')
  }

  private async inspectPack(pack: ManifestPack): Promise<CacheInspection> {
    return this.inspectCache(
      this.modelCacheName(pack),
      pack.files.map((file) => ({ url: resolveUrl(file.url), bytes: file.bytes })),
    )
  }

  private async inspectRuntime(manifest: AiManifest): Promise<CacheInspection> {
    return this.inspectCache(
      this.runtimeCacheName(manifest),
      this.runtimeEntries(manifest).map(([, url, bytes]) => ({
        url: resolveUrl(url),
        bytes,
      })),
    )
  }

  private async inspectCache(
    cacheName: string,
    entries: Array<{ url: string; bytes: number }>,
  ): Promise<CacheInspection> {
    if (!(await caches.has(cacheName))) {
      return { present: false, downloadedBytes: 0 }
    }
    const cache = await caches.open(cacheName)
    let downloadedBytes = 0
    let present = true
    for (const entry of entries) {
      const hit = await cache.match(entry.url)
      if (hit) downloadedBytes += entry.bytes
      else present = false
    }
    return { present, downloadedBytes }
  }

  private runtimeEntries(
    manifest: AiManifest,
  ): Array<[string, string, number]> {
    return [
      [
        'glue',
        `${manifest.runtime.baseUrl}${manifest.runtime.glue}`,
        manifest.runtime.glueBytes,
      ],
      [
        'api',
        `${manifest.runtime.baseUrl}${manifest.runtime.api}`,
        manifest.runtime.apiBytes,
      ],
      [
        'wasm',
        `${manifest.runtime.baseUrl}${manifest.runtime.wasm}`,
        manifest.runtime.wasmBytes,
      ],
    ]
  }

  private runtimeHash(manifest: AiManifest, name: string): string {
    if (name === 'glue') return manifest.runtime.glueSha256
    if (name === 'api') return manifest.runtime.apiSha256
    return manifest.runtime.wasmSha256
  }

  private modelCacheName(pack: ManifestPack): string {
    return `${MODEL_CACHE_PREFIX}${pack.id}-${pack.version}`
  }

  private runtimeCacheName(manifest: AiManifest): string {
    return `${RUNTIME_CACHE_PREFIX}${manifest.runtime.version}`
  }

  private packDefinition(packId: string): ManifestPack | null {
    return this.manifest?.packs.find((pack) => pack.id === packId) ?? null
  }

  private voiceStatus(voiceId: string): AiVoiceStatus | null {
    const manifest = this.manifest
    if (!manifest) return null
    for (const pack of manifest.packs) {
      const voice = pack.voices.find((item) => item.id === voiceId)
      if (voice) {
        return {
          id: voice.id,
          label: voice.label,
          description: voice.description ?? '',
          speakerId: voice.speakerId,
          sampleRate: voice.sampleRate,
          packId: pack.id,
          packName: pack.name,
          lang: pack.lang === 'en' ? 'en' : 'zh',
          commercialUse: pack.license.commercialUse,
          licenseLabel: pack.license.label,
        }
      }
    }
    return null
  }

  private ensurePackStates(manifest: AiManifest): void {
    for (const pack of manifest.packs) {
      if (!this.packStates.has(pack.id)) {
        this.packStates.set(pack.id, emptyPackState())
      }
    }
  }

  private ensureSelectedVoice(manifest: AiManifest): void {
    for (const pack of manifest.packs) {
      if (pack.lang === 'en') continue
      if (pack.voices.some((voice) => voice.id === this.selectedVoiceId)) return
    }
    const fallback = manifest.packs.find((pack) => pack.lang !== 'en')?.voices[0]?.id
    if (fallback) this.selectedVoiceId = fallback
  }

  private markPackMissing(pack: ManifestPack, downloadedBytes: number): void {
    this.packStates.set(pack.id, {
      ...(this.packStates.get(pack.id) ?? emptyPackState()),
      phase: 'missing',
      downloadedBytes,
      message: null,
      error: null,
    })
    this.rebuildStatus()
  }

  private async isPersisted(): Promise<boolean> {
    try {
      return (await navigator.storage?.persisted?.()) === true
    } catch {
      return false
    }
  }

  private async requestPersistence(): Promise<boolean> {
    try {
      if (await navigator.storage?.persisted?.()) return true
      return (await navigator.storage?.persist?.()) === true
    } catch {
      return false
    }
  }

  private async removeOldCaches(manifest: AiManifest): Promise<void> {
    const active = new Set<string>([
      this.runtimeCacheName(manifest),
      ...manifest.packs.map((pack) => this.modelCacheName(pack)),
    ])
    const names = await caches.keys()
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && !active.has(name))
        .map((name) => caches.delete(name)),
    )
  }

  private fatalError(message: string): void {
    if (!this.manifest) {
      this.status = {
        ...this.status,
        phase: 'error',
        packs: [],
        englishPack: null,
        selectedVoice: null,
        message: null,
        error: message,
      }
      this.emit()
      return
    }
    this.rebuildStatus()
  }

  private patchPackState(packId: string, partial: Partial<PackRuntimeState>): void {
    const state = this.packStates.get(packId) ?? emptyPackState()
    this.packStates.set(packId, { ...state, ...partial })
  }

  private rebuildStatus(): void {
    if (!this.status.supported) {
      this.status = {
        ...this.status,
        phase: 'unsupported',
        supported: false,
      }
      this.emit()
      return
    }

    const manifest = this.manifest
    if (!manifest) {
      this.status = {
        ...this.status,
        phase: 'loading',
        packs: [],
        selectedVoice: null,
      }
      this.emit()
      return
    }

    this.ensureSelectedVoice(manifest)
    const runtimeBytes = manifest.runtime.bytes
    const allPacks: AiPackStatus[] = manifest.packs.map((pack) => {
      const state = this.packStates.get(pack.id) ?? emptyPackState()
      return {
        id: pack.id,
        lang: pack.lang === 'en' ? 'en' : 'zh',
        name: pack.name,
        version: pack.version,
        description: pack.description,
        license: {
          label: pack.license.label,
          commercialUse: pack.license.commercialUse,
          notice: pack.license.notice,
          url: pack.license.url ?? null,
        },
        phase: state.phase,
        modelBytes: pack.totalBytes,
        runtimeBytes,
        totalBytes: pack.totalBytes + runtimeBytes,
        downloadedBytes: state.downloadedBytes,
        persisted: this.persisted,
        message: state.message,
        error: state.error,
        voices: pack.voices.map((voice) => ({
          id: voice.id,
          label: voice.label,
          description: voice.description ?? '',
          speakerId: voice.speakerId,
          sampleRate: voice.sampleRate,
          packId: pack.id,
          packName: pack.name,
          lang: pack.lang === 'en' ? 'en' : 'zh',
          commercialUse: pack.license.commercialUse,
          licenseLabel: pack.license.label,
        })),
      }
    })

    const packs = allPacks.filter((pack) => pack.lang !== 'en')
    const englishPack = allPacks.find((pack) => pack.lang === 'en') ?? null

    const selectedVoice =
      packs
        .flatMap((pack) => pack.voices)
        .find((voice) => voice.id === this.selectedVoiceId) ?? null
    const selectedPack = selectedVoice
      ? (packs.find((pack) => pack.id === selectedVoice.packId) ?? null)
      : null

    this.status = {
      supported: true,
      phase: selectedPack?.phase ?? 'error',
      packs,
      englishPack,
      selectedVoiceId: selectedVoice?.id ?? this.selectedVoiceId,
      selectedVoice,
      runtimeBytes,
      persisted: this.persisted,
      modelBytes: selectedPack?.modelBytes ?? 0,
      totalBytes: selectedPack?.totalBytes ?? 0,
      downloadedBytes: selectedPack?.downloadedBytes ?? 0,
      voiceLabel: selectedVoice?.label ?? '离线 AI 音色',
      voiceDescription: selectedVoice?.description ?? '',
      voiceLicense: selectedPack?.license.notice ?? '',
      commercialUse: selectedPack?.license.commercialUse ?? false,
      version: selectedPack?.version ?? '',
      message: selectedPack?.message ?? null,
      error:
        selectedPack?.error ??
        (selectedPack ? null : '离线音色清单尚未准备好，请稍后重试。'),
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.getStatus()
    for (const listener of this.listeners) listener(snapshot)
  }
}
