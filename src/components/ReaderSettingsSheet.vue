<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AiModelStatus, AiPackStatus } from '@/core/tts/AiModel'
import type { BookLexiconStatus } from '@/core/tts/BookLexiconService'
import { isIOSDevice } from '@/core/tts/systemVoice'
import type { ReaderDiagnostics } from '@/core/player/ReaderController'
import type { MediaSinkDiagnostics } from '@/core/tts/MediaAudioSink'
import type {
  PausePreset,
  ReaderSettings,
  TtsEngine,
  VoiceOption,
} from '@/types'
import { PAUSE_PRESET_SCALES } from '@/types'
import AppIcon from './AppIcon.vue'
import LockScreenProbePanel from './LockScreenProbePanel.vue'
import Sheet from './Sheet.vue'
import VoicePackCard from './VoicePackCard.vue'

const props = defineProps<{
  open: boolean
  settings: ReaderSettings
  voices: VoiceOption[]
  englishVoices: VoiceOption[]
  ai: AiModelStatus | null
  bookLexicon: BookLexiconStatus | null
  isPlaying: boolean
  diagnostics: ReaderDiagnostics | null
  buildId: string
}>()

const emit = defineEmits<{
  close: []
  patch: [value: Partial<ReaderSettings>]
  reset: []
  notice: [message: string]
  previewVoice: [voiceURI: string | null]
  previewEnglishVoice: [voiceURI: string | null]
  refreshVoices: []
  downloadAi: [packId: string, voiceId?: string]
  removeAi: [packId: string]
}>()

const isIos = isIOSDevice()

const LAB_KEY = 'shusheng:lab'

function resolveLabMode(): boolean {
  if (import.meta.env.DEV) return true
  try {
    const param = new URLSearchParams(window.location.search).get('lab')
    if (param === '1') {
      window.localStorage.setItem(LAB_KEY, '1')
      return true
    }
    if (param === '0') {
      window.localStorage.removeItem(LAB_KEY)
      return false
    }
    // The home-screen PWA usually opens without a query string; remember the
    // flag so the probe can be reached there as well.
    return window.localStorage.getItem(LAB_KEY) === '1'
  } catch {
    return false
  }
}

const labMode = resolveLabMode()
const showDiagnostics = ref(labMode)

const PAUSE_PRESETS: Array<{ value: PausePreset; label: string; hint: string }> = [
  { value: 'compact', label: '紧凑', hint: `${PAUSE_PRESET_SCALES.compact}×` },
  { value: 'standard', label: '自然', hint: `${PAUSE_PRESET_SCALES.standard}×` },
  { value: 'relaxed', label: '舒缓', hint: `${PAUSE_PRESET_SCALES.relaxed}×` },
]

const AI_PHASE_LABELS: Record<AiModelStatus['phase'], string> = {
  unsupported: '不支持',
  loading: '读取中',
  missing: '未下载',
  downloading: '下载中',
  ready: '已就绪',
  error: '出错',
}

const confirmRemoveId = ref<string | null>(null)
const pendingVoice = ref<{ packId: string; voiceId: string } | null>(null)

const selectedSystemVoice = computed(
  () =>
    props.voices.find((voice) => voice.uri === props.settings.voiceURI) ?? null,
)
const systemVoiceSummary = computed(() => {
  const selected = selectedSystemVoice.value
  if (selected) {
    return `${selected.name}${selected.quality === 'enhanced' ? ' · 增强' : ''}`
  }
  if (props.voices.length) return `自动选择（${props.voices.length} 个中文音色可用）`
  return '使用设备自带中文语音'
})

const selectedPack = computed<AiPackStatus | null>(() => {
  const ai = props.ai
  if (!ai?.selectedVoice) return null
  return (
    ai.packs.find((pack) => pack.id === ai.selectedVoice?.packId) ?? null
  )
})
const aiReady = computed(() => selectedPack.value?.phase === 'ready')
const englishPack = computed<AiPackStatus | null>(
  () => props.ai?.englishPack ?? null,
)
const englishPackReady = computed(() => englishPack.value?.phase === 'ready')
const aiDownloading = computed(
  () =>
    selectedPack.value?.phase === 'downloading' ||
    englishPack.value?.phase === 'downloading',
)
const aiVoiceLabel = computed(() => props.ai?.selectedVoice?.label || '山岚')
const englishVoiceLabel = computed(
  () => englishPack.value?.voices[0]?.label ?? '英文音色',
)
// 山岚 stays above the English settings so the two favourite voices sit together.
const primaryPacks = computed<AiPackStatus[]>(() =>
  props.ai?.supported ? props.ai.packs.slice(0, 1) : [],
)
const morePacks = computed<AiPackStatus[]>(() =>
  props.ai?.supported ? props.ai.packs.slice(1) : [],
)
const selectedVoiceId = computed(() => props.ai?.selectedVoiceId ?? null)
const englishAiActive = computed(
  () => props.settings.englishAi && englishPackReady.value,
)
const aiUsable = computed(() => aiReady.value || englishPackReady.value)
const packBusy = computed(
  () =>
    props.isPlaying ||
    Boolean(props.ai?.packs.some((pack) => pack.phase === 'downloading')) ||
    englishPack.value?.phase === 'downloading',
)
const bookLexiconNote = computed(() => {
  if (!props.settings.autoBookPolyphones) return '已关闭。重新打开后生效。'
  const status = props.bookLexicon
  if (!status || status.phase === 'idle') return '使用开源音色时自动生成'
  if (status.phase === 'generating') return '正在分析本书，可先直接朗读'
  if (status.phase === 'ready') {
    return status.entries
      ? `已补充 ${status.entries} 条读音`
      : '本书暂无需补充的词'
  }
  if (status.phase === 'error') return status.message || '生成失败'
  return ''
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    confirmRemoveId.value = null
    pendingVoice.value = null
  },
)

watch(
  () => props.ai?.packs.map((pack) => `${pack.id}:${pack.phase}`).join('|') ?? '',
  () => {
    const pending = pendingVoice.value
    if (!pending) return
    const pack = props.ai?.packs.find((item) => item.id === pending.packId)
    if (!pack || pack.phase === 'ready') pendingVoice.value = null
  },
)

watch(
  () => [props.voices.length, props.settings.voiceURI] as const,
  () => {
    const uri = props.settings.voiceURI
    if (!uri || !props.voices.length) return
    if (!props.voices.some((voice) => voice.uri === uri)) {
      emit('patch', { voiceURI: null })
    }
  },
  { immediate: true },
)

watch(
  () => [props.englishVoices.length, props.settings.englishVoiceURI] as const,
  () => {
    const uri = props.settings.englishVoiceURI
    if (!uri || !props.englishVoices.length) return
    if (!props.englishVoices.some((voice) => voice.uri === uri)) {
      emit('patch', { englishVoiceURI: null })
    }
  },
  { immediate: true },
)

const noiseValue = computed(
  () =>
    props.settings.labNoiseScale ??
    props.diagnostics?.stats?.noiseScale ??
    0.667,
)

const diagnosticRows = computed<Array<{ label: string; value: string }>>(() => {
  const diag = props.diagnostics
  const rows: Array<{ label: string; value: string }> = []
  if (diag) {
    const activeEngine = diag.activeEngine ?? diag.engine
    rows.push(
      { label: '引擎', value: engineLabel(activeEngine) },
      {
        label: '音色',
        value:
          activeEngine === 'sherpa'
            ? diag.activeLang === 'en'
              ? englishVoiceLabel.value
              : diag.voiceLabel
            : selectedSystemVoice.value?.name ?? '自动选择',
      },
      { label: '句组', value: `${diag.units} 组 / ${diag.sentences} 句` },
    )
    const stats = diag.stats
    if (stats) {
      rows.push(
        {
          label: '采样率',
          value: `${(stats.sampleRate / 1000).toFixed(2)} kHz`,
        },
        {
          label: '初始化',
          value: `${formatMs(stats.initMs)} · 预热 ${formatMs(stats.warmupMs)}`,
        },
        {
          label: '合成',
          value: `${stats.synthCount} 次 · 平均 ${formatMs(stats.averageSynthMs)}`,
        },
        { label: '实时率', value: formatRtf(stats.lastRtf) },
        {
          label: '缓存',
          value: `命中 ${stats.cacheHits} · 未命中 ${stats.cacheMisses}`,
        },
        {
          label: '队列',
          value: `等待 ${stats.pending} · 取消 ${stats.cancelled}`,
        },
        { label: '模型内存', value: formatBytes(stats.heapBytes) },
        {
          label: '参数',
          value: `noise ${formatScale(diag.noiseScale)} · silence ${formatScale(
            diag.silenceScale,
          )}`,
        },
      )
    } else {
      rows.push({ label: '音色包', value: AI_PHASE_LABELS[diag.aiPhase] })
    }
    const englishStats = diag.englishStats
    if (englishStats) {
      rows.push(
        {
          label: '英文音色',
          value: `${(englishStats.sampleRate / 1000).toFixed(2)} kHz · RTF ${formatRtf(
            englishStats.lastRtf,
          )}`,
        },
        {
          label: '英文合成',
          value: `${englishStats.synthCount} 次 · 平均 ${formatMs(
            englishStats.averageSynthMs,
          )}`,
        },
      )
    }
    rows.push({ label: '播放通道', value: sinkLabel(diag.sink) })
  }
  rows.push({ label: '构建', value: props.buildId })
  return rows
})

const SINK_STATES: Record<string, string> = {
  idle: '空闲',
  keepalive: '保活',
  playing: '播放中',
  gap: '停顿',
}

function sinkLabel(sink: MediaSinkDiagnostics): string {
  const mode = sink.mode === 'media' ? '媒体元素' : 'WebAudio 备用'
  const state = SINK_STATES[sink.state] ?? sink.state
  const recoveries = sink.recoveries > 0 ? ` · 自愈 ${sink.recoveries}` : ''
  return sink.lastError
    ? `${mode} · ${state}${recoveries} · ${sink.lastError}`
    : `${mode} · ${state}${recoveries}`
}

function engineLabel(engine: TtsEngine | null): string {
  if (!engine) return '待命'
  return engine === 'sherpa' ? '离线 AI' : '系统语音'
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`
  return `${Math.round(value)} ms`
}

function formatRtf(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(2)
}

function formatScale(value: number | null): string {
  return value === null ? '默认' : value.toFixed(2)
}

function isPackSelected(pack: AiPackStatus): boolean {
  return props.ai?.selectedVoice?.packId === pack.id
}

function pendingLabel(pack: AiPackStatus): string | null {
  if (pendingVoice.value?.packId !== pack.id) return null
  return (
    pack.voices.find((voice) => voice.id === pendingVoice.value?.voiceId)
      ?.label ?? null
  )
}

function pendingVoiceId(pack: AiPackStatus): string | undefined {
  return pendingVoice.value?.packId === pack.id
    ? pendingVoice.value.voiceId
    : undefined
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}

function changeVoice(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  emit('patch', { voiceURI: value || null })
}

function chooseSystemVoice(voiceURI: string | null): void {
  if (props.settings.voiceURI !== voiceURI) emit('patch', { voiceURI })
}

function previewSystemVoice(voiceURI: string | null): void {
  if (props.isPlaying) {
    emit('notice', '请先暂停朗读，再试听系统音色。')
    return
  }
  emit('previewVoice', voiceURI)
}

function refreshSystemVoices(): void {
  emit('refreshVoices')
}

function changeEnglishVoice(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  emit('patch', { englishVoiceURI: value || null })
}

function previewEnglishSystemVoice(): void {
  if (props.isPlaying) {
    emit('notice', '请先暂停朗读，再试听英文音色。')
    return
  }
  emit('previewEnglishVoice', props.settings.englishVoiceURI)
}

function changeEnglishVolume(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('patch', { englishVolume: value })
}

function changeEnglishRate(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('patch', { englishRate: value })
}

function changeNoiseScale(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('patch', { labNoiseScale: value })
}

function changeSilenceScale(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('patch', { labSilenceScale: value })
}

function voiceQualityLabel(voice: VoiceOption): string {
  if (voice.quality === 'enhanced') return '增强'
  if (voice.quality === 'standard') return '标准'
  return ''
}

function selectEngine(engine: TtsEngine): void {
  if (engine === props.settings.engine) return
  if (engine === 'sherpa' && !aiUsable.value) {
    if (!props.ai) emit('notice', '正在读取音色包信息，请稍候。')
    else if (!props.ai.supported)
      emit('notice', '当前浏览器不支持离线 AI 音色。')
    else if (aiDownloading.value)
      emit('notice', '音色包正在下载，完成后即可启用。')
    else emit('notice', '请先下载一个离线音色包，再启用离线 AI 朗读。')
    return
  }
  emit('patch', { engine })
}

function selectVoice(voiceId: string, pack: AiPackStatus): void {
  if (pack.phase !== 'ready') {
    const voice = pack.voices.find((item) => item.id === voiceId)
    if (pack.phase === 'downloading') {
      emit(
        'notice',
        `「${pack.name}」正在下载，完成后即可切换到「${voice?.label ?? '该音色'}」。`,
      )
      return
    }
    if (props.isPlaying) {
      emit('notice', '请先暂停朗读，再下载音色包。')
      return
    }
    pendingVoice.value = { packId: pack.id, voiceId }
    emit(
      'notice',
      `「${voice?.label ?? '该音色'}」需要先下载音色包，请确认下方按钮。`,
    )
    return
  }

  pendingVoice.value = null
  if (props.settings.aiVoiceId !== voiceId) {
    emit('patch', { aiVoiceId: voiceId, engine: 'sherpa' })
    return
  }
  if (props.settings.engine !== 'sherpa') emit('patch', { engine: 'sherpa' })
}

function requestDownload(packId: string, voiceId?: string): void {
  if (props.isPlaying) {
    emit('notice', '请先暂停朗读再下载音色包。')
    return
  }
  const downloading =
    props.ai?.packs.find((pack) => pack.phase === 'downloading') ??
    (englishPack.value?.phase === 'downloading' ? englishPack.value : null)
  if (downloading && downloading.id !== packId) {
    emit('notice', `「${downloading.name}」正在下载，请稍候。`)
    return
  }
  pendingVoice.value = null
  emit('downloadAi', packId, voiceId)
}

function requestRemove(packId: string): void {
  if (props.isPlaying) {
    emit('notice', '请先暂停朗读再删除音色包。')
    return
  }
  if (packBusy.value && !props.isPlaying) {
    emit('notice', '音色包下载进行中，暂不能删除。')
    return
  }
  if (confirmRemoveId.value !== packId) {
    confirmRemoveId.value = packId
    return
  }
  confirmRemoveId.value = null
  emit('removeAi', packId)
}

function downloadEnglishPack(voiceId?: string): void {
  const pack = englishPack.value
  if (pack) requestDownload(pack.id, voiceId)
}

function removeEnglishPack(): void {
  const pack = englishPack.value
  if (pack) requestRemove(pack.id)
}
</script>

<template>
  <Sheet :open="open" title="阅读与朗读" @close="emit('close')">
    <p class="group-label">音色</p>
    <section class="setting">
      <h3 class="setting__title">朗读引擎</h3>
      <div class="engines">
        <button
          type="button"
          class="engine"
          :class="{ 'is-active': settings.engine === 'system' }"
          @click="selectEngine('system')"
        >
          <span class="engine__icon"><AppIcon name="volume" :size="18" /></span>
          <span class="engine__copy">
            <strong>{{ isIos ? 'iOS 自带音色' : '系统语音' }}</strong>
            <small>{{ isIos ? `调用系统朗读音色 · ${systemVoiceSummary}` : systemVoiceSummary }}</small>
          </span>
          <span v-if="settings.engine === 'system'" class="engine__check">
            <AppIcon name="check" :size="12" />
          </span>
          <span v-else-if="isIos" class="engine__tag">系统</span>
        </button>

        <button
          type="button"
          class="engine"
          :class="{
            'is-active': settings.engine === 'sherpa',
            'is-unavailable': !aiUsable,
          }"
          @click="selectEngine('sherpa')"
        >
          <span class="engine__icon engine__icon--ai">
            <AppIcon name="spark" :size="18" />
          </span>
          <span class="engine__copy">
            <strong>离线 AI · {{ aiVoiceLabel }}</strong>
            <small>{{
              aiReady
                ? '离线合成，支持多种开源音色'
                : englishPackReady
                  ? '英文音色已就绪；中文仍需下载'
                  : '需先下载所选音色包'
            }}</small>
          </span>
          <span v-if="settings.engine === 'sherpa'" class="engine__check">
            <AppIcon name="check" :size="12" />
          </span>
          <span v-else-if="aiDownloading" class="engine__tag">下载中</span>
          <span v-else-if="aiUsable" class="engine__tag">已就绪</span>
          <span v-else-if="ai && !ai.supported" class="engine__tag">不支持</span>
          <span v-else-if="ai?.phase === 'error'" class="engine__tag">出错</span>
          <span v-else-if="!ai || !ai.packs.length" class="engine__tag">读取中</span>
          <span v-else class="engine__tag">未下载</span>
        </button>
      </div>
    </section>

    <section class="setting">
      <div class="pack-head">
        <div>
          <h3 class="setting__title">开源音色库</h3>
          <p class="pack-sub">下载后离线可用，文字全程不离开本机</p>
        </div>
        <span v-if="ai?.runtimeBytes" class="runtime-tip">
          共享运行时 {{ formatBytes(ai.runtimeBytes) }}
        </span>
      </div>

      <p v-if="!ai" class="setting__note">正在读取音色包信息…</p>

      <template v-else-if="!ai.supported">
        <p class="setting__note">
          当前浏览器不支持离线 AI 音色，需要 WebAssembly、Cache Storage 和
          AudioContext。你仍然可以使用系统语音。
        </p>
      </template>

      <template v-else>
        <p v-if="!ai.packs.length && ai.phase === 'error'" class="pack-error-text">
          {{ ai.error || '无法读取音色清单，请检查网络后刷新页面。' }}
        </p>
        <p v-else-if="!ai.packs.length" class="setting__note">
          正在读取音色包信息…
        </p>
        <p v-else class="pack-desc">
          包含可商用与仅限非商业音色，下载前请查看许可说明。
        </p>

        <VoicePackCard
          v-for="pack in primaryPacks"
          :key="pack.id"
          :pack="pack"
          :selected="isPackSelected(pack)"
          :selected-voice-id="selectedVoiceId"
          :pending-voice-id="pendingVoiceId(pack)"
          :pending-voice-label="pendingLabel(pack)"
          :busy="packBusy"
          :confirm-remove="confirmRemoveId === pack.id"
          @select="(voiceId) => selectVoice(voiceId, pack)"
          @download="(voiceId) => requestDownload(pack.id, voiceId)"
          @remove="requestRemove(pack.id)"
          @cancel-remove="confirmRemoveId = null"
          @cancel-pending="pendingVoice = null"
        />
      </template>
    </section>

    <section class="setting">
      <div class="voice-head">
        <div>
          <h3 class="setting__title">英文朗读</h3>
          <p class="voice-sub">
            英文段落可单独使用离线音色；未下载或启动失败时自动改用系统英文语音
          </p>
        </div>
        <button
          type="button"
          class="voice-refresh"
          @click="refreshSystemVoices"
        >
          重新检测
        </button>
      </div>

      <VoicePackCard
        v-if="englishPack"
        variant="en"
        :pack="englishPack"
        :selected="englishAiActive"
        :busy="packBusy"
        :confirm-remove="englishPack ? confirmRemoveId === englishPack.id : false"
        removable-when-selected
        @download="downloadEnglishPack"
        @remove="removeEnglishPack"
        @cancel-remove="confirmRemoveId = null"
      />

      <div v-if="englishPack && ai?.supported" class="switch-row english-ai-row">
        <div class="switch-copy">
          <h3 class="setting__title">英文使用离线音色</h3>
          <p>
            离线 AI 朗读时，英文段落也由本机合成，锁屏后可继续；未下载或启动失败时自动改用系统英文语音
          </p>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="settings.englishAi"
          :class="{ 'is-on': settings.englishAi }"
          @click="emit('patch', { englishAi: !settings.englishAi })"
        >
          <span></span>
        </button>
      </div>

      <div v-if="settings.engine === 'sherpa'" class="switch-row english-lock-row">
        <div class="switch-copy">
          <h3 class="setting__title">锁屏跳过英文</h3>
          <p>
            仅锁屏且英文走系统语音时生效：跳过后解锁自动恢复，并提示跳过段数；离线英文音色不受影响
          </p>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="settings.skipEnglishWhenLocked"
          :class="{ 'is-on': settings.skipEnglishWhenLocked }"
          @click="
            emit('patch', {
              skipEnglishWhenLocked: !settings.skipEnglishWhenLocked,
            })
          "
        >
          <span></span>
        </button>
      </div>

      <h3 class="setting__title preset-title">系统英文音色（备用）</h3>
      <div class="english-row">
        <div class="select-wrap english-select">
          <select
            :value="settings.englishVoiceURI ?? ''"
            aria-label="英文朗读音色"
            @change="changeEnglishVoice"
          >
            <option value="">自动选择英文语音</option>
            <option
              v-for="voice in englishVoices"
              :key="voice.uri"
              :value="voice.uri"
            >
              {{ voice.name }} · {{ voice.lang }}{{ voice.local ? ' · 本地' : '' }}
            </option>
          </select>
          <span class="select-caret" aria-hidden="true">⌄</span>
        </div>
        <button
          type="button"
          class="voice-preview-btn"
          :disabled="isPlaying"
          @click="previewEnglishSystemVoice"
        >
          试听
        </button>
      </div>

      <div class="english-tone">
        <div class="lab-head">
          <span>英文音量</span>
          <span class="lab-value">
            {{ Math.round(settings.englishVolume * 100) }}%
          </span>
        </div>
        <input
          class="lab-range"
          type="range"
          min="0.6"
          max="1.2"
          step="0.05"
          :value="settings.englishVolume"
          aria-label="英文音量"
          @change="changeEnglishVolume"
        />
        <div class="lab-head">
          <span>英文语速</span>
          <span class="lab-value">{{ settings.englishRate.toFixed(1) }}×</span>
        </div>
        <input
          class="lab-range"
          type="range"
          min="0.6"
          max="1.4"
          step="0.1"
          :value="settings.englishRate"
          aria-label="英文语速"
          @change="changeEnglishRate"
        />
        <p class="english-tone__hint">
          英文语速在总语速上叠加，离线英文音色同样应用这两项设置；系统语音音量最高 100%。
        </p>
      </div>

      <p v-if="!englishVoices.length" class="setting__note">
        尚未检测到英文系统语音；离线英文音色未开启时，英文段落可能无声或音色异常。
      </p>
      <p v-else-if="isPlaying" class="setting__note">
        朗读中暂不能试听音色，可先暂停。
      </p>
      <p v-else-if="isIos" class="setting__note">
        安装更多英文音色：设置 → 辅助功能 → 朗读内容 → 声音 → 英语。
      </p>
      <p v-else class="setting__note">
        离线英文音色开启时优先使用本机合成，关闭后英文部分由系统英文语音朗读。
      </p>
    </section>

    <section v-if="ai?.supported" class="setting">
      <h3 v-if="morePacks.length" class="setting__title">更多中文音色</h3>
      <VoicePackCard
        v-for="pack in morePacks"
        :key="pack.id"
        :pack="pack"
        :selected="isPackSelected(pack)"
        :selected-voice-id="selectedVoiceId"
        :pending-voice-id="pendingVoiceId(pack)"
        :pending-voice-label="pendingLabel(pack)"
        :busy="packBusy"
        :confirm-remove="confirmRemoveId === pack.id"
        @select="(voiceId) => selectVoice(voiceId, pack)"
        @download="(voiceId) => requestDownload(pack.id, voiceId)"
        @remove="requestRemove(pack.id)"
        @cancel-remove="confirmRemoveId = null"
        @cancel-pending="pendingVoice = null"
      />

      <p v-if="isPlaying" class="setting__note">
        朗读时暂不能下载或删除音色包，可切换已缓存的音色。
      </p>
      <p v-else class="setting__note">
        音色包仅保存在本机，可随时单独删除；建议在 Wi-Fi 环境下载。
      </p>

      <div class="switch-row book-lexicon-row">
        <div class="switch-copy">
          <h3 class="setting__title">本书自动补充读音</h3>
          <p>为词库未收录的词按上下文补充读音，不改动词库和人工表</p>
          <p class="book-lexicon-state">{{ bookLexiconNote }}</p>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="settings.autoBookPolyphones"
          :class="{ 'is-on': settings.autoBookPolyphones }"
          @click="
            emit('patch', {
              autoBookPolyphones: !settings.autoBookPolyphones,
            })
          "
        >
          <span></span>
        </button>
      </div>
    </section>

    <section v-if="settings.engine === 'system'" class="setting">
      <div class="voice-head">
        <div>
          <h3 class="setting__title">{{ isIos ? 'iOS 自带音色' : '朗读音色' }}</h3>
          <p v-if="isIos" class="voice-sub">
            无需下载，直接调用 iPhone / iPad 的系统朗读音色
          </p>
        </div>
        <button
          v-if="isIos"
          type="button"
          class="voice-refresh"
          @click="refreshSystemVoices"
        >
          重新检测
        </button>
      </div>

      <template v-if="isIos">
        <div
          v-if="voices.length"
          class="ios-voice-list"
          role="radiogroup"
          aria-label="iOS 自带音色"
        >
          <div class="ios-voice" :class="{ 'is-active': !settings.voiceURI }">
            <button
              type="button"
              class="ios-voice__main"
              role="radio"
              :aria-checked="!settings.voiceURI"
              @click="chooseSystemVoice(null)"
            >
              <span class="ios-voice__copy">
                <span class="ios-voice__name">自动选择</span>
                <span class="ios-voice__meta">按系统默认与音质自动挑选中文音色</span>
              </span>
              <span
                v-if="!settings.voiceURI"
                class="ios-voice__check"
                aria-hidden="true"
              >
                <AppIcon name="check" :size="10" />
              </span>
            </button>
            <button
              type="button"
              class="ios-voice__preview"
              :disabled="isPlaying"
              aria-label="试听自动选择的系统音色"
              @click="previewSystemVoice(null)"
            >
              试听
            </button>
          </div>

          <div
            v-for="voice in voices"
            :key="voice.uri"
            class="ios-voice"
            :class="{ 'is-active': settings.voiceURI === voice.uri }"
          >
            <button
              type="button"
              class="ios-voice__main"
              role="radio"
              :aria-checked="settings.voiceURI === voice.uri"
              @click="chooseSystemVoice(voice.uri)"
            >
              <span class="ios-voice__copy">
                <span class="ios-voice__name">{{ voice.name }}</span>
                <span class="ios-voice__meta">
                  <span
                    v-if="voice.isDefault"
                    class="ios-voice__tag ios-voice__tag--default"
                  >
                    系统默认
                  </span>
                  <span
                    v-if="voiceQualityLabel(voice)"
                    class="ios-voice__tag"
                    :class="{
                      'ios-voice__tag--enhanced': voice.quality === 'enhanced',
                    }"
                  >
                    {{ voiceQualityLabel(voice) }}
                  </span>
                  <span>{{ voice.lang }}</span>
                  <span>{{ voice.local ? '本地' : '联网' }}</span>
                </span>
              </span>
              <span
                v-if="settings.voiceURI === voice.uri"
                class="ios-voice__check"
                aria-hidden="true"
              >
                <AppIcon name="check" :size="10" />
              </span>
            </button>
            <button
              type="button"
              class="ios-voice__preview"
              :disabled="isPlaying"
              :aria-label="`试听 ${voice.name}`"
              @click="previewSystemVoice(voice.uri)"
            >
              试听
            </button>
          </div>
        </div>

        <div v-else class="ios-voice-empty">
          <p>还没有检测到中文系统音色。</p>
          <button
            type="button"
            class="voice-refresh"
            @click="refreshSystemVoices"
          >
            重新检测
          </button>
        </div>

        <p v-if="isPlaying" class="setting__note">
          朗读中暂不能试听音色，可先暂停。
        </p>
        <p v-else class="setting__note">
          点按「试听」调用系统朗读；音色列表来自 iOS 已安装的中文语音。
        </p>
        <p class="setting__note ios-voice-hint">
          安装更多音色：设置 → 辅助功能 → 朗读内容 → 声音 → 中文。下载「增强」音色后回到这里点「重新检测」。Siri 音色通常不向网页开放。
        </p>
        <p class="setting__note ios-voice-hint">
          锁屏后 iOS 会暂停系统语音；需要锁屏续读时，请在「朗读引擎」中选择离线 AI 音色。
        </p>
      </template>

      <template v-else>
        <div class="select-wrap">
          <select :value="settings.voiceURI ?? ''" @change="changeVoice">
            <option value="">自动选择中文语音</option>
            <option v-for="voice in voices" :key="voice.uri" :value="voice.uri">
              {{ voice.name }} · {{ voice.lang }}{{ voice.local ? ' · 本地' : '' }}
            </option>
          </select>
          <span class="select-caret" aria-hidden="true">⌄</span>
        </div>
        <p v-if="!voices.length" class="setting__note">
          未检测到中文系统语音，将使用浏览器默认语音。可以在系统设置中安装中文语音后刷新页面。
        </p>
        <p v-else class="setting__note">
          音色由当前设备的系统语音提供，不同设备听起来会有所差异。
        </p>
      </template>
    </section>

    <p class="group-label">朗读</p>
    <section class="setting">
      <div class="switch-row">
        <div class="switch-copy">
          <h3 class="setting__title">连读模式</h3>
          <p>同段落 2–3 句合成一组朗读，句间不再额外停顿，只在组与段之间换气</p>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="settings.groupSentences"
          :class="{ 'is-on': settings.groupSentences }"
          @click="emit('patch', { groupSentences: !settings.groupSentences })"
        >
          <span></span>
        </button>
      </div>

      <h3 class="setting__title preset-title">停顿节奏</h3>
      <div class="preset-grid" role="radiogroup" aria-label="停顿节奏">
        <button
          v-for="preset in PAUSE_PRESETS"
          :key="preset.value"
          type="button"
          class="preset"
          role="radio"
          :aria-checked="settings.pausePreset === preset.value"
          :class="{ 'is-active': settings.pausePreset === preset.value }"
          @click="emit('patch', { pausePreset: preset.value })"
        >
          <span class="preset__label">{{ preset.label }}</span>
          <span class="preset__hint">{{ preset.hint }}</span>
        </button>
      </div>
      <p class="setting__note">
        停顿会随语速自动缩短；连读关闭时同样作用于句间停顿。
      </p>

      <div class="switch-row setting-sub-row">
        <div class="switch-copy">
          <h3 class="setting__title">自动滚动</h3>
          <p>朗读时让当前句子保持在视野中</p>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-checked="settings.autoScroll"
          :class="{ 'is-on': settings.autoScroll }"
          @click="emit('patch', { autoScroll: !settings.autoScroll })"
        >
          <span></span>
        </button>
      </div>
    </section>

    <section class="setting">
      <div class="voice-head">
        <div>
          <h3 class="setting__title">朗读诊断</h3>
          <p class="voice-sub">构建 {{ buildId }} · 合成耗时、缓存与队列状态</p>
        </div>
        <button
          type="button"
          class="voice-refresh"
          @click="showDiagnostics = !showDiagnostics"
        >
          {{ showDiagnostics ? '收起' : '展开' }}
        </button>
      </div>

      <div v-if="showDiagnostics" class="diag-panel">
        <div v-for="row in diagnosticRows" :key="row.label" class="diag-row">
          <span class="diag-row__label">{{ row.label }}</span>
          <span class="diag-row__value">{{ row.value }}</span>
        </div>
        <p v-if="!diagnostics" class="setting__note">
          开始朗读后这里会显示实时数据。
        </p>
      </div>

      <template v-if="labMode && showDiagnostics">
        <div class="lab-block">
          <div class="lab-head">
            <span>noiseScale · 音色随机度</span>
            <span class="lab-value">
              {{
                settings.labNoiseScale === null
                  ? `默认 ${noiseValue.toFixed(2)}`
                  : settings.labNoiseScale.toFixed(2)
              }}
            </span>
          </div>
          <input
            class="lab-range"
            type="range"
            min="0.3"
            max="1.2"
            step="0.01"
            :value="noiseValue"
            aria-label="noiseScale"
            @change="changeNoiseScale"
          />
          <div class="lab-foot">
            <small>越低越稳，越高起伏越大；改动后下一句会重建引擎。</small>
            <button
              v-if="settings.labNoiseScale !== null"
              type="button"
              class="pack-link"
              @click="emit('patch', { labNoiseScale: null })"
            >
              跟随音色包
            </button>
          </div>
        </div>

        <div class="lab-block">
          <div class="lab-head">
            <span>silenceScale · 模型停顿</span>
            <span class="lab-value">
              {{ settings.labSilenceScale.toFixed(2) }}
            </span>
          </div>
          <input
            class="lab-range"
            type="range"
            min="0.5"
            max="1.5"
            step="0.05"
            :value="settings.labSilenceScale"
            aria-label="silenceScale"
            @change="changeSilenceScale"
          />
          <div class="lab-foot">
            <small>控制模型自身的停顿时长；改动后当前句会重新合成。</small>
            <button
              v-if="settings.labSilenceScale !== 1"
              type="button"
              class="pack-link"
              @click="emit('patch', { labSilenceScale: 1 })"
            >
              重置为 1
            </button>
          </div>
        </div>
      </template>

      <LockScreenProbePanel
        v-if="showDiagnostics"
        :is-playing="isPlaying"
        :build-id="buildId"
        @notice="emit('notice', $event)"
      />
    </section>

    <div class="setting-footer">
      <button type="button" class="reset" @click="emit('reset')">恢复默认设置</button>
    </div>
  </Sheet>
</template>

<style scoped>
.setting {
  padding: 18px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
}

.setting:last-of-type {
  border-bottom: none;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 0;
  font-family: var(--font-serif);
  font-size: 13px;
  letter-spacing: 0.24em;
  color: var(--app-muted);
}

.group-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: color-mix(in srgb, var(--app-fg) 10%, transparent);
}

.group-label + .setting {
  padding-top: 12px;
}

.setting-sub-row,
.english-lock-row {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.setting__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--app-muted);
}

.engines {
  display: grid;
  gap: 9px;
  margin-top: 12px;
}

.engine {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 62px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 11%, transparent);
  border-radius: 14px;
  background: var(--app-bg);
  text-align: left;
  color: var(--app-fg);
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.engine.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 52%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-bg));
}

.engine.is-unavailable {
  opacity: 0.62;
}

.engine__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--app-fg) 6%, transparent);
  color: var(--app-muted);
}

.engine.is-active .engine__icon {
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-accent);
}

.engine__icon--ai {
  background:
    radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--app-accent) 20%, transparent), transparent 68%),
    color-mix(in srgb, var(--app-accent) 7%, transparent);
  color: var(--app-accent);
}

.engine__copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.engine__copy strong {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.engine__copy small {
  font-size: 11px;
  line-height: 1.45;
  color: var(--app-muted);
}

.engine__check {
  flex: none;
  display: grid;
  place-items: center;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: var(--app-accent);
  color: var(--app-bg);
}

.engine__tag {
  flex: none;
  padding: 3px 8px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--app-muted);
}

.voice-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.voice-sub {
  margin: 5px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--app-muted);
}

.voice-refresh {
  flex: none;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  background: var(--app-bg);
  font-size: 11px;
  letter-spacing: 0.03em;
  color: var(--app-muted);
}

.voice-refresh:active {
  color: var(--app-accent);
  border-color: color-mix(in srgb, var(--app-accent) 40%, transparent);
}

.ios-voice-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.ios-voice {
  display: flex;
  align-items: stretch;
  border: 1px solid color-mix(in srgb, var(--app-fg) 11%, transparent);
  border-radius: 14px;
  background: var(--app-bg);
  overflow: hidden;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.ios-voice.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 52%, transparent);
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-bg));
}

.ios-voice__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px 10px 13px;
  color: var(--app-fg);
  text-align: left;
}

.ios-voice__copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ios-voice__name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ios-voice__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--app-muted);
}

.ios-voice__tag {
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.04em;
}

.ios-voice__tag--default {
  color: var(--app-muted);
}

.ios-voice__tag--enhanced {
  border-color: color-mix(in srgb, var(--app-accent) 32%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, transparent);
  color: var(--app-accent);
}

.ios-voice__check {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--app-accent);
  color: var(--app-bg);
}

.ios-voice__preview {
  flex: none;
  width: 56px;
  border-left: 1px solid color-mix(in srgb, var(--app-fg) 9%, transparent);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--app-accent);
}

.ios-voice__preview:active:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
}

.ios-voice__preview:disabled {
  opacity: 0.35;
}

.ios-voice-empty {
  margin-top: 12px;
  padding: 16px;
  border: 1px dashed color-mix(in srgb, var(--app-fg) 15%, transparent);
  border-radius: 14px;
  text-align: center;
}

.ios-voice-empty p {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted);
}

.ios-voice-hint {
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 5%, transparent);
}

.pack-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.pack-sub {
  margin: 5px 0 0;
  font-size: 12px;
  color: var(--app-fg);
  font-family: var(--font-serif);
  letter-spacing: 0.02em;
}

.pack-desc {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--app-muted);
}

.pack-error-text {
  margin: 0 0 10px;
  font-size: 11.5px;
  line-height: 1.65;
  color: color-mix(in srgb, #a3412c 84%, var(--app-fg));
}

.runtime-tip {
  flex: none;
  padding: 4px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 5%, transparent);
  font-size: 9.5px;
  letter-spacing: 0.03em;
  color: var(--app-muted);
  white-space: nowrap;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.switch-row + .switch-row {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.book-lexicon-row {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.switch-copy p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted);
}

.switch-copy .book-lexicon-state {
  margin-top: 7px;
  font-size: 11.5px;
  color: color-mix(in srgb, var(--app-accent) 72%, var(--app-muted));
}

.switch {
  flex: none;
  width: 50px;
  height: 30px;
  padding: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 16%, transparent);
  transition: background-color 0.2s ease;
}

.switch span {
  display: block;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--app-ui);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.18);
  transition: transform 0.2s ease;
}

.switch.is-on {
  background: var(--app-accent);
}

.switch.is-on span {
  transform: translateX(20px);
  background: var(--app-bg);
}

.select-wrap {
  position: relative;
  margin-top: 12px;
}

.select-wrap select {
  width: 100%;
  height: 46px;
  padding: 0 38px 0 14px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 14%, transparent);
  border-radius: 12px;
  background: var(--app-bg);
  color: var(--app-fg);
  font-size: 13px;
  appearance: none;
  -webkit-appearance: none;
}

.select-caret {
  position: absolute;
  top: 50%;
  right: 15px;
  transform: translateY(-55%);
  font-size: 15px;
  color: var(--app-muted);
  pointer-events: none;
}

.english-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin-top: 12px;
}

.english-select {
  flex: 1;
  min-width: 0;
  margin-top: 0;
}

.english-tone {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.english-tone__hint {
  margin: 2px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--app-muted);
}

.voice-preview-btn {
  flex: none;
  min-width: 64px;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 34%, transparent);
  border-radius: 12px;
  font-size: 12.5px;
  letter-spacing: 0.04em;
  color: var(--app-accent);
  background: var(--app-bg);
}

.voice-preview-btn:active:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
}

.voice-preview-btn:disabled {
  opacity: 0.35;
}

.preset-title {
  margin-top: 18px;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 10px;
}

.preset {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 10px 6px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 12px;
  background: var(--app-bg);
  color: var(--app-fg);
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.preset.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 54%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-bg));
  color: var(--app-accent);
}

.preset__label {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.preset__hint {
  font-size: 10px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}

.preset.is-active .preset__hint {
  color: inherit;
  opacity: 0.75;
}

.diag-panel {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-fg) 4%, transparent);
}

.diag-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  font-size: 11.5px;
  line-height: 1.55;
}

.diag-row__label {
  flex: none;
  color: var(--app-muted);
}

.diag-row__value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.lab-block {
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.lab-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  color: var(--app-muted);
}

.lab-value {
  flex: none;
  color: var(--app-accent);
  font-variant-numeric: tabular-nums;
}

.lab-range {
  width: 100%;
  margin: 10px 0 4px;
  accent-color: var(--app-accent);
}

.lab-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lab-foot small {
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--app-muted);
}

.lab-foot .pack-link {
  flex: none;
  padding: 7px 2px;
  font-size: 11.5px;
  color: var(--app-muted);
}

.setting__note {
  margin: 9px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--app-muted);
}

.setting-footer {
  display: flex;
  justify-content: center;
  padding-top: 6px;
}

.reset {
  padding: 10px 18px;
  font-size: 12px;
  color: var(--app-muted);
  border-radius: 999px;
}

.reset:active {
  background: color-mix(in srgb, var(--app-fg) 6%, transparent);
}
</style>
