import polyphoneOverlay from './polyphones.v1.txt?raw'
import { normalizeOverlayText } from './pinyinTones'

export type AiPhase =
  | 'unsupported'
  | 'loading'
  | 'missing'
  | 'downloading'
  | 'ready'
  | 'error'

export type AiPackPhase = 'missing' | 'downloading' | 'ready' | 'error'

export type AiModelType = 'vits' | 'matcha' | 'kokoro' | 'hojo'

export type AiEngine = 'sherpa' | 'hojo'

export interface AiPackLicense {
  label: string
  commercialUse: boolean
  notice: string
  url: string | null
}

export type AiPackLang = 'zh' | 'en'

/** A bilingual pack exposes both Chinese and English voices. */
export type AiPackKind = AiPackLang | 'bi'

export interface AiVoiceStatus {
  id: string
  label: string
  description: string
  speakerId: number
  sampleRate: number
  packId: string
  packName: string
  lang: AiPackLang
  engine: AiEngine
  modelType: AiModelType
  commercialUse: boolean
  licenseLabel: string
}

export interface AiPackVariantStatus {
  id: string
  label: string
  description: string
  totalBytes: number
  selected: boolean
}

export interface AiPackStatus {
  id: string
  lang: AiPackKind
  engine: AiEngine
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
  variantId: string
  variantLabel: string
  variants: AiPackVariantStatus[]
  voices: AiVoiceStatus[]
}

export interface AiModelStatus {
  supported: boolean
  phase: AiPhase
  /** Chinese and bilingual packs; the English pack is exposed separately. */
  packs: AiPackStatus[]
  englishPack: AiPackStatus | null
  selectedVoiceId: string
  selectedVoice: AiVoiceStatus | null
  englishVoice: AiVoiceStatus | null
  variantPreference: AiVariantPreference
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

export interface AiRuntimeFilePart {
  name: string
  url: string
  bytes: number
  sha256: string
}

export interface AiRuntimeFile {
  name: string
  url: string
  bytes: number
  sha256: string
  parts?: AiRuntimeFilePart[]
}

export interface AiRuntimeConfig {
  engine: AiEngine
  runtimeBaseUrl: string
  glueUrl?: string
  apiUrl?: string
  wasmUrl?: string
  runtimeFiles?: AiRuntimeFile[]
  runtimeVersion: string
  modelCacheName: string
  packId: string
  packVersion: string
  variantId: string
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

interface ManifestFilePart {
  name: string
  url: string
  bytes: number
  sha256: string
}

interface ManifestFile {
  name: string
  url: string
  bytes: number
  sha256: string
  parts?: ManifestFilePart[]
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
  lang?: AiPackLang
}

interface ManifestVariant {
  id: string
  label: string
  description?: string
  totalBytes: number
  files: ManifestFile[]
}

interface ManifestPack {
  id: string
  engine?: AiEngine
  lang?: AiPackKind
  name: string
  version: string
  description: string
  license: ManifestLicense
  baseUrl: string
  model?: ManifestModel
  voices: ManifestVoice[]
  totalBytes: number
  files?: ManifestFile[]
  variants?: ManifestVariant[]
}

interface ManifestRuntimeFile {
  name: string
  url: string
  bytes: number
  sha256: string
}

interface ManifestRuntime {
  version: string
  baseUrl: string
  bytes: number
  glue?: string
  api?: string
  wasm?: string
  glueBytes?: number
  apiBytes?: number
  wasmBytes?: number
  glueSha256?: string
  wasmSha256?: string
  apiSha256?: string
  files?: ManifestRuntimeFile[]
}

interface AiManifest {
  schemaVersion: number
  runtime: ManifestRuntime
  hojoRuntime?: ManifestRuntime
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

export type AiVariantPreference = 'auto' | 'full' | 'int8'

const MANIFEST_STORAGE_KEY = 'shusheng.ai.manifest.v4'
const LEGACY_MANIFEST_STORAGE_KEYS = [
  'shusheng.ai.manifest.v3',
  'shusheng.ai.manifest.v2',
]
const CACHE_PREFIX = 'shusheng-tts-'
const MODEL_CACHE_PREFIX = `${CACHE_PREFIX}model-`
const RUNTIME_CACHE_PREFIX = `${CACHE_PREFIX}runtime-`
const MODEL_TYPES: readonly AiModelType[] = ['vits', 'matcha', 'kokoro', 'hojo']

function resolveUrl(path: string): string {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI)
  return new URL(path, base).href
}

// importScripts and instantiateStreaming reject cached responses without
// a usable MIME type, so preserve one when re-wrapping downloaded bytes.
function contentTypeFor(url: string): string {
  const path = url.split('?')[0] ?? url
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
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

function isManifestFilePart(value: unknown): value is ManifestFilePart {
  if (!value || typeof value !== 'object') return false
  const part = value as Partial<ManifestFilePart>
  return (
    typeof part.name === 'string' &&
    part.name.length > 0 &&
    typeof part.url === 'string' &&
    part.url.length > 0 &&
    typeof part.bytes === 'number' &&
    part.bytes > 0 &&
    isHexHash(part.sha256)
  )
}

function isManifestFile(value: unknown): value is ManifestFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<ManifestFile>
  if (
    typeof file.name !== 'string' ||
    file.name.length === 0 ||
    typeof file.url !== 'string' ||
    file.url.length === 0 ||
    typeof file.bytes !== 'number' ||
    file.bytes <= 0 ||
    !isHexHash(file.sha256)
  ) {
    return false
  }
  if (file.parts === undefined) return true
  return (
    Array.isArray(file.parts) &&
    file.parts.length > 1 &&
    file.parts.every(isManifestFilePart) &&
    new Set(file.parts.map((part) => part.name)).size === file.parts.length &&
    file.parts.reduce((total, part) => total + part.bytes, 0) === file.bytes
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
    (voice.description === undefined || typeof voice.description === 'string') &&
    (voice.lang === undefined || voice.lang === 'zh' || voice.lang === 'en')
  )
}

function isManifestVariant(value: unknown): value is ManifestVariant {
  if (!value || typeof value !== 'object') return false
  const variant = value as Partial<ManifestVariant>
  const files = variant.files
  return (
    typeof variant.id === 'string' &&
    variant.id.length > 0 &&
    typeof variant.label === 'string' &&
    variant.label.length > 0 &&
    (variant.description === undefined ||
      typeof variant.description === 'string') &&
    typeof variant.totalBytes === 'number' &&
    variant.totalBytes > 0 &&
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(isManifestFile) &&
    new Set(files.map((file) => file.name)).size === files.length &&
    files.reduce((total, file) => total + file.bytes, 0) === variant.totalBytes
  )
}

function isManifestPack(value: unknown): value is ManifestPack {
  if (!value || typeof value !== 'object') return false
  const pack = value as Partial<ManifestPack>
  const files = pack.files
  const voices = pack.voices
  const variants = pack.variants
  const engine = pack.engine ?? 'sherpa'
  if (
    typeof pack.id !== 'string' ||
    pack.id.length === 0 ||
    typeof pack.name !== 'string' ||
    pack.name.length === 0 ||
    typeof pack.version !== 'string' ||
    pack.version.length === 0 ||
    typeof pack.description !== 'string' ||
    (engine !== 'sherpa' && engine !== 'hojo') ||
    (pack.lang !== undefined &&
      pack.lang !== 'zh' &&
      pack.lang !== 'en' &&
      pack.lang !== 'bi') ||
    typeof pack.baseUrl !== 'string' ||
    pack.baseUrl.length === 0 ||
    !isManifestLicense(pack.license) ||
    !isManifestModel(pack.model) ||
    typeof pack.totalBytes !== 'number' ||
    pack.totalBytes <= 0 ||
    !Array.isArray(voices) ||
    voices.length === 0 ||
    !voices.every(isManifestVoice) ||
    new Set(voices.map((voice) => voice.id)).size !== voices.length
  ) {
    return false
  }
  if (engine === 'sherpa') {
    if (pack.lang === 'bi') return false
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every(isManifestFile) ||
      new Set(files.map((file) => file.name)).size !== files.length
    ) {
      return false
    }
    const fileBytes = files.reduce((total, file) => total + file.bytes, 0)
    return fileBytes === pack.totalBytes
  }
  if (pack.model.type !== 'hojo' || pack.lang !== 'bi') return false
  if (files !== undefined && (!Array.isArray(files) || files.length > 0)) {
    return false
  }
  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    !variants.every(isManifestVariant) ||
    new Set(variants.map((variant) => variant.id)).size !== variants.length
  ) {
    return false
  }
  if (!voices.every((voice) => voice.lang === 'zh' || voice.lang === 'en')) {
    return false
  }
  return (
    pack.totalBytes === Math.max(...variants.map((variant) => variant.totalBytes))
  )
}

function isManifestRuntime(value: unknown): value is ManifestRuntime {
  if (!value || typeof value !== 'object') return false
  const runtime = value as Partial<ManifestRuntime>
  if (
    typeof runtime.version !== 'string' ||
    runtime.version.length === 0 ||
    typeof runtime.baseUrl !== 'string' ||
    typeof runtime.bytes !== 'number' ||
    runtime.bytes <= 0
  ) {
    return false
  }
  if (runtime.files !== undefined) {
    const files = runtime.files
    return (
      Array.isArray(files) &&
      files.length > 0 &&
      files.every(
        (file) =>
          file &&
          typeof file.name === 'string' &&
          typeof file.url === 'string' &&
          typeof file.bytes === 'number' &&
          file.bytes > 0 &&
          isHexHash(file.sha256),
      ) &&
      new Set(files.map((file) => file.name)).size === files.length &&
      files.reduce((total, file) => total + file.bytes, 0) === runtime.bytes
    )
  }
  return (
    typeof runtime.glue === 'string' &&
    typeof runtime.api === 'string' &&
    typeof runtime.wasm === 'string' &&
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
    manifest.schemaVersion !== 4 ||
    !isManifestRuntime(manifest.runtime) ||
    !Array.isArray(packs) ||
    packs.length === 0 ||
    !packs.every(isManifestPack)
  ) {
    return false
  }
  const hasHojo = packs.some((pack) => (pack.engine ?? 'sherpa') === 'hojo')
  if (hasHojo) {
    if (!isManifestRuntime(manifest.hojoRuntime)) return false
    if (!manifest.hojoRuntime.files?.length) return false
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

function packEngine(pack: ManifestPack): AiEngine {
  return pack.engine ?? 'sherpa'
}

function packLangOf(pack: ManifestPack): AiPackKind {
  return pack.lang ?? 'zh'
}

function voiceLangOf(pack: ManifestPack, voice: ManifestVoice): AiPackLang {
  return voice.lang ?? (pack.lang === 'en' ? 'en' : 'zh')
}

function packVariants(pack: ManifestPack): ManifestVariant[] {
  if (pack.variants?.length) return pack.variants
  if (!pack.files?.length) return []
  return [
    {
      id: 'default',
      label: '默认',
      totalBytes: pack.totalBytes,
      files: pack.files,
    },
  ]
}

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true
  if ((navigator.maxTouchPoints ?? 0) > 1) {
    try {
      return window.matchMedia?.('(pointer: coarse)').matches ?? false
    } catch {
      return false
    }
  }
  return false
}

function runtimeFor(
  manifest: AiManifest,
  engine: AiEngine,
): ManifestRuntime | null {
  return engine === 'hojo' ? (manifest.hojoRuntime ?? null) : manifest.runtime
}

function runtimeFiles(runtime: ManifestRuntime): ManifestRuntimeFile[] {
  if (runtime.files?.length) return runtime.files
  return [
    { name: 'glue', url: `${runtime.baseUrl}${runtime.glue}`, bytes: runtime.glueBytes!, sha256: runtime.glueSha256! },
    { name: 'api', url: `${runtime.baseUrl}${runtime.api}`, bytes: runtime.apiBytes!, sha256: runtime.apiSha256! },
    { name: 'wasm', url: `${runtime.baseUrl}${runtime.wasm}`, bytes: runtime.wasmBytes!, sha256: runtime.wasmSha256! },
  ]
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
    englishVoice: null,
    variantPreference: 'auto',
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
  private selectedEnglishVoiceId: string
  private variantPreference: AiVariantPreference = 'auto'
  private readonly packStates = new Map<string, PackRuntimeState>()
  private readonly listeners = new Set<(status: AiModelStatus) => void>()
  private downloadTask: Promise<void> | null = null
  private persisted = false
  private lastProgressAt = 0

  constructor(selectedVoiceId = 'shanlan', selectedEnglishVoiceId = 'kristin') {
    this.selectedVoiceId = selectedVoiceId
    this.selectedEnglishVoiceId = selectedEnglishVoiceId
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
    if (!this.manifest) return null
    const selected = this.voiceStatus(this.selectedEnglishVoiceId)
    if (selected && selected.lang === 'en' && this.englishVoiceAllowed(selected)) {
      return selected
    }
    return this.defaultEnglishVoice()
  }

  subscribe(listener: (status: AiModelStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.getStatus())
    return () => this.listeners.delete(listener)
  }

  selectVoice(voiceId: string): boolean {
    const voice = this.voiceStatus(voiceId)
    if (!voice || voice.lang !== 'zh') return false
    if (this.selectedVoiceId !== voiceId) {
      this.selectedVoiceId = voiceId
      this.ensureSelectedEnglishVoice()
      this.rebuildStatus()
    }
    return true
  }

  selectEnglishVoice(voiceId: string): boolean {
    const voice = this.voiceStatus(voiceId)
    if (!voice || voice.lang !== 'en' || !this.englishVoiceAllowed(voice)) {
      return false
    }
    if (this.selectedEnglishVoiceId !== voiceId) {
      this.selectedEnglishVoiceId = voiceId
      this.rebuildStatus()
    }
    return true
  }

  /** `auto` picks the full pack on desktop and int8 on touch devices. */
  async setVariantPreference(
    preference: AiVariantPreference,
  ): Promise<AiModelStatus> {
    this.variantPreference = preference
    if (this.manifest && !this.downloadTask) {
      await this.refreshPackStates(this.manifest)
      this.rebuildStatus()
    }
    return this.getStatus()
  }

  async refresh(): Promise<AiModelStatus> {
    if (!this.status.supported) return this.getStatus()
    if (this.downloadTask) return this.getStatus()

    try {
      const manifest = await this.loadManifest()
      this.manifest = manifest
      this.ensurePackStates(manifest)
      this.ensureSelectedVoice(manifest)
      this.ensureSelectedEnglishVoice()

      this.persisted = await this.isPersisted()
      await this.refreshPackStates(manifest)
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

  private async refreshPackStates(manifest: AiManifest): Promise<void> {
    const runtimes = new Map<AiEngine, CacheInspection>()
    for (const pack of manifest.packs) {
      const engine = packEngine(pack)
      let runtime = runtimes.get(engine)
      if (!runtime) {
        runtime = await this.inspectRuntime(manifest, engine)
        runtimes.set(engine, runtime)
      }
      const model = await this.inspectPack(pack)
      const previous = this.packStates.get(pack.id) ?? emptyPackState()
      const runtimeBytes = runtimeFor(manifest, engine)?.bytes ?? 0
      this.packStates.set(pack.id, {
        phase: model.present && runtime.present ? 'ready' : 'missing',
        downloadedBytes:
          model.downloadedBytes + (runtime.present ? runtimeBytes : 0),
        persisted: this.persisted,
        message: previous.phase === 'error' ? previous.message : null,
        error: previous.phase === 'error' ? previous.error : null,
      })
    }
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

    if (this.manifest) {
      const engine = packEngine(pack)
      const hasSameEngine = this.manifest.packs.some(
        (item) => item.id !== pack.id && packEngine(item) === engine,
      )
      if (!hasSameEngine) {
        await caches.delete(this.runtimeCacheName(this.manifest, engine))
      }
    }

    this.rebuildStatus()
  }

  async loadPack(voiceId: string, bookOverlay?: string): Promise<AiRuntimeConfig> {
    if (!this.manifest) {
      this.manifest = await this.loadManifest()
      this.ensurePackStates(this.manifest)
      this.ensureSelectedVoice(this.manifest)
      this.ensureSelectedEnglishVoice()
    }
    const manifest = this.manifest
    const voice = this.voiceStatus(voiceId)
    const pack = voice ? this.packDefinition(voice.packId) : null
    if (!voice || !pack || !pack.model) {
      throw new Error('所选离线音色不存在，请重新选择。')
    }
    const engine = packEngine(pack)
    const runtime = runtimeFor(manifest, engine)
    if (!runtime) {
      throw new Error('离线语音运行时清单缺失，请刷新页面后重试。')
    }
    const variant = this.variantFor(pack)

    const modelCacheName = this.modelCacheName(pack)
    const model = await this.inspectPack(pack)
    if (!model.present) {
      this.markPackMissing(pack, model.downloadedBytes)
      throw new Error('离线音色包不完整，请重新下载。')
    }

    const runtimeState = await this.inspectRuntime(manifest, engine)
    if (!runtimeState.present) {
      this.markPackMissing(
        pack,
        model.downloadedBytes + runtimeState.downloadedBytes,
      )
      throw new Error('离线语音运行时缺失，请重新下载音色包。')
    }

    this.packStates.set(pack.id, {
      phase: 'ready',
      downloadedBytes: model.downloadedBytes + runtimeState.downloadedBytes,
      persisted: this.persisted,
      message: null,
      error: null,
    })
    this.rebuildStatus()

    const runtimeRoot = new URL(runtime.baseUrl, resolveUrl(''))

    const lexiconOverlay =
      pack.model.type === 'matcha' &&
      typeof pack.model.config.lexicon === 'string'
        ? normalizeOverlayText(
            [polyphoneOverlay, bookOverlay?.trim()].filter(Boolean).join('\n'),
          )
        : undefined

    const files = this.packFiles(pack).map((file) => ({
      ...file,
      url: resolveUrl(file.url),
      ...(file.parts
        ? {
            parts: file.parts.map((part) => ({
              ...part,
              url: resolveUrl(part.url),
            })),
          }
        : {}),
    }))

    const common = {
      engine,
      runtimeBaseUrl: runtimeRoot.href,
      runtimeVersion: runtime.version,
      modelCacheName,
      packId: pack.id,
      packVersion: pack.version,
      variantId: variant?.id ?? '',
      lang: voice.lang,
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
      files,
    }

    if (engine === 'hojo') {
      return {
        ...common,
        runtimeFiles: runtimeFiles(runtime).map((file) => ({
          ...file,
          url: resolveUrl(file.url),
        })),
      }
    }

    if (
      typeof runtime.glue !== 'string' ||
      typeof runtime.api !== 'string' ||
      typeof runtime.wasm !== 'string'
    ) {
      throw new Error('离线语音运行时清单不完整。')
    }

    return {
      ...common,
      glueUrl: new URL(runtime.glue, runtimeRoot).href,
      apiUrl: new URL(runtime.api, runtimeRoot).href,
      wasmUrl: new URL(runtime.wasm, runtimeRoot).href,
    }
  }

  async getLexiconAssets(voiceId: string): Promise<AiLexiconAssets | null> {
    if (!this.manifest) {
      this.manifest = await this.loadManifest()
      this.ensurePackStates(this.manifest)
      this.ensureSelectedVoice(this.manifest)
      this.ensureSelectedEnglishVoice()
    }
    const voice = this.voiceStatus(voiceId)
    const pack = voice ? this.packDefinition(voice.packId) : null
    if (!voice || !pack || !pack.model || pack.model.type !== 'matcha') return null
    const lexiconName = pack.model.config.lexicon
    if (typeof lexiconName !== 'string') return null
    const files = this.packFiles(pack)
    const lexiconFile = files.find((file) => file.name === lexiconName)
    const tokensFile = files.find((file) => file.name === 'tokens.txt')
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
    this.ensureSelectedEnglishVoice()
    const pack = manifest.packs.find((item) => item.id === packId)
    if (!pack) {
      throw new Error('音色清单中找不到这个音色包，请刷新页面后重试。')
    }
    const variant = this.variantFor(pack)
    if (!variant) {
      throw new Error('音色包清单不完整，请刷新页面后重试。')
    }
    const engine = packEngine(pack)
    const runtime = runtimeFor(manifest, engine)
    if (!runtime) {
      throw new Error('离线语音运行时清单缺失，请刷新页面后重试。')
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
    const runtimeCacheName = this.runtimeCacheName(manifest, engine)
    const total = variant.totalBytes + runtime.bytes
    let downloaded = 0

    try {
      const modelCache = await caches.open(modelCacheName)
      const runtimeCache = await caches.open(runtimeCacheName)
      this.patchPackState(pack.id, {
        message: '正在准备模型文件…',
      })

      for (const file of variant.files) {
        const entries = file.parts?.length ? file.parts : [file]
        for (const entry of entries) {
          const url = resolveUrl(entry.url)
          const cached = await this.readVerified(
            modelCache,
            url,
            entry.bytes,
            entry.sha256,
          )
          if (cached) {
            downloaded += entry.bytes
            this.reportProgress(pack.id, downloaded, `正在检查 ${file.name}…`)
            continue
          }

          const buffer = await this.fetchFile(
            url,
            entry.bytes,
            downloaded,
            `正在下载 ${file.name}`,
            pack.id,
          )
          this.patchPackState(pack.id, { message: `正在校验 ${file.name}…` })
          const digest = await hashToHex(buffer)
          if (digest !== entry.sha256.toLowerCase()) {
            throw new Error(`${file.name} 校验失败，请重试。`)
          }
          await modelCache.put(
            url,
            new Response(buffer, {
              headers: { 'Content-Type': contentTypeFor(url) },
            }),
          )
          downloaded += entry.bytes
          this.reportProgress(pack.id, downloaded, `已缓存 ${file.name}`)
        }
      }

      for (const entry of runtimeFiles(runtime)) {
        const absolute = resolveUrl(entry.url)
        const cached = await this.readVerified(
          runtimeCache,
          absolute,
          entry.bytes,
          entry.sha256,
        )
        if (cached) {
          downloaded += entry.bytes
          this.reportProgress(pack.id, downloaded, '正在检查离线运行时…')
          continue
        }

        const buffer = await this.fetchFile(
          absolute,
          entry.bytes,
          downloaded,
          '正在下载离线运行时',
          pack.id,
        )
        this.patchPackState(pack.id, { message: '正在校验离线运行时…' })
        const digest = await hashToHex(buffer)
        if (digest !== entry.sha256.toLowerCase()) {
          throw new Error('离线运行时校验失败，请重试。')
        }
        await runtimeCache.put(
          absolute,
          new Response(buffer, {
            headers: { 'Content-Type': contentTypeFor(absolute) },
          }),
        )
        downloaded += entry.bytes
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
    const variant = this.variantFor(pack)
    if (!variant) return { present: false, downloadedBytes: 0 }
    return this.inspectCache(
      this.modelCacheName(pack),
      variant.files.flatMap((file) =>
        (file.parts?.length ? file.parts : [file]).map((entry) => ({
          url: resolveUrl(entry.url),
          bytes: entry.bytes,
        })),
      ),
    )
  }

  private async inspectRuntime(
    manifest: AiManifest,
    engine: AiEngine,
  ): Promise<CacheInspection> {
    const runtime = runtimeFor(manifest, engine)
    if (!runtime) return { present: false, downloadedBytes: 0 }
    return this.inspectCache(
      this.runtimeCacheName(manifest, engine),
      runtimeFiles(runtime).map((file) => ({
        url: resolveUrl(file.url),
        bytes: file.bytes,
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

  private modelCacheName(pack: ManifestPack): string {
    return `${MODEL_CACHE_PREFIX}${pack.id}-${pack.version}`
  }

  private runtimeCacheName(manifest: AiManifest, engine: AiEngine): string {
    const runtime = runtimeFor(manifest, engine)
    return `${RUNTIME_CACHE_PREFIX}${runtime?.version ?? 'unknown'}`
  }

  /** `full` and `int8` are Hojo variants; sherpa packs have one default. */
  private variantFor(pack: ManifestPack): ManifestVariant | null {
    const variants = packVariants(pack)
    if (!variants.length) return null
    if (packEngine(pack) !== 'hojo') return variants[0]
    const wanted =
      this.variantPreference === 'auto'
        ? isMobileDevice()
          ? 'int8'
          : 'full'
        : this.variantPreference
    return variants.find((variant) => variant.id === wanted) ?? variants[0]
  }

  private packFiles(pack: ManifestPack): ManifestFile[] {
    return this.variantFor(pack)?.files ?? []
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
          lang: voiceLangOf(pack, voice),
          engine: packEngine(pack),
          modelType: pack.model!.type,
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
      if (packLangOf(pack) === 'en') continue
      if (
        pack.voices.some(
          (voice) =>
            voice.id === this.selectedVoiceId &&
            voiceLangOf(pack, voice) === 'zh',
        )
      ) {
        return
      }
    }
    for (const pack of manifest.packs) {
      if (packLangOf(pack) === 'en') continue
      const fallback = pack.voices.find(
        (voice) => voiceLangOf(pack, voice) === 'zh',
      )
      if (fallback) {
        this.selectedVoiceId = fallback.id
        return
      }
    }
  }

  /** English voices must use the same engine as the Chinese voice. */
  private englishVoiceAllowed(voice: AiVoiceStatus): boolean {
    if (voice.lang !== 'en') return false
    const current = this.voiceStatus(this.selectedVoiceId)
    return !current || voice.engine === current.engine
  }

  private defaultEnglishVoice(): AiVoiceStatus | null {
    const manifest = this.manifest
    if (!manifest) return null
    const current = this.voiceStatus(this.selectedVoiceId)
    const currentPack = current ? this.packDefinition(current.packId) : null
    if (currentPack) {
      const paired = currentPack.voices.find(
        (voice) => voiceLangOf(currentPack, voice) === 'en',
      )
      if (paired) return this.voiceStatus(paired.id)
    }
    for (const pack of manifest.packs) {
      if (packLangOf(pack) !== 'en') continue
      if (current && packEngine(pack) !== current.engine) continue
      const voice = pack.voices.find(
        (item) => voiceLangOf(pack, item) === 'en',
      )
      if (voice) return this.voiceStatus(voice.id)
    }
    return null
  }

  private ensureSelectedEnglishVoice(): void {
    const selected = this.voiceStatus(this.selectedEnglishVoiceId)
    if (selected && this.englishVoiceAllowed(selected)) return
    this.selectedEnglishVoiceId = this.defaultEnglishVoice()?.id ?? ''
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
    const active = new Set<string>(
      manifest.packs.map((pack) => this.modelCacheName(pack)),
    )
    for (const pack of manifest.packs) {
      const engine = packEngine(pack)
      if (runtimeFor(manifest, engine)) {
        active.add(this.runtimeCacheName(manifest, engine))
      }
    }
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
        englishVoice: null,
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
    this.ensureSelectedEnglishVoice()
    const allPacks: AiPackStatus[] = manifest.packs.map((pack) => {
      const state = this.packStates.get(pack.id) ?? emptyPackState()
      const engine = packEngine(pack)
      const runtime = runtimeFor(manifest, engine)
      const runtimeBytes = runtime?.bytes ?? 0
      const variant = this.variantFor(pack)
      const variants = packVariants(pack)
      const modelBytes = variant?.totalBytes ?? pack.totalBytes
      return {
        id: pack.id,
        lang: packLangOf(pack),
        engine,
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
        modelBytes,
        runtimeBytes,
        totalBytes: modelBytes + runtimeBytes,
        downloadedBytes: state.downloadedBytes,
        persisted: this.persisted,
        message: state.message,
        error: state.error,
        variantId: variant?.id ?? '',
        variantLabel: variant?.label ?? '',
        variants: variants.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description ?? '',
          totalBytes: item.totalBytes,
          selected: item.id === variant?.id,
        })),
        voices: pack.voices.map((voice) => ({
          id: voice.id,
          label: voice.label,
          description: voice.description ?? '',
          speakerId: voice.speakerId,
          sampleRate: voice.sampleRate,
          packId: pack.id,
          packName: pack.name,
          lang: voiceLangOf(pack, voice),
          engine,
          modelType: pack.model!.type,
          commercialUse: pack.license.commercialUse,
          licenseLabel: pack.license.label,
        })),
      }
    })

    const packs = allPacks.filter((pack) => pack.lang !== 'en')
    const englishPack = allPacks.find((pack) => pack.lang === 'en') ?? null
    const englishVoice = this.getEnglishVoice()

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
      englishVoice,
      variantPreference: this.variantPreference,
      runtimeBytes: selectedPack?.runtimeBytes ?? 0,
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
