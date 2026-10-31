<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import {
  READER_THEME_LABELS,
  type ChapterInfo,
  type ReaderSettings,
  type ReaderTuneKind,
  type StoredBook,
  type VoiceOption,
} from '@/types'
import type { AiModelStatus } from '@/core/tts/AiModel'
import type { BookLexiconStatus } from '@/core/tts/BookLexiconService'
import { getBook, getProgress, touchBook } from '@/core/db/LibraryDB'
import {
  ReaderController,
  type ReaderDiagnostics,
  type ReaderState,
} from '@/core/player/ReaderController'
import AppIcon from '@/components/AppIcon.vue'
import PocketOverlay from '@/components/PocketOverlay.vue'
import ReaderSettingsSheet from '@/components/ReaderSettingsSheet.vue'
import ReaderTuneSheet from '@/components/ReaderTuneSheet.vue'
import SleepTimerSheet from '@/components/SleepTimerSheet.vue'
import TocSheet from '@/components/TocSheet.vue'
import { useSettingsStore } from '@/stores/settings'
import { appBuildId } from '@/ui/pwa'
import { showToast } from '@/ui/toast'
import { navigateToLibrary } from '@/ui/nav'
import {
  formatClock,
  formatRemaining,
  formatRemainingShort,
  formatTargetDay,
  useSleepTimer,
} from '@/ui/sleepTimer'

const props = defineProps<{ bookId: string }>()

const settingsStore = useSettingsStore()

const epubHost = ref<HTMLElement | null>(null)
const controller = shallowRef<ReaderController | null>(null)
const book = ref<StoredBook | null>(null)
const chapters = ref<ChapterInfo[]>([])
const voices = ref<VoiceOption[]>([])
const englishVoices = ref<VoiceOption[]>([])
const diagnostics = ref<ReaderDiagnostics | null>(null)
const aiStatus = ref<AiModelStatus | null>(null)
const bookLexiconStatus = ref<BookLexiconStatus | null>(null)
const ready = ref(false)
const loading = ref(true)
const loadError = ref('')
const tocOpen = ref(false)
const settingsOpen = ref(false)
const tuneOpen = ref(false)
const tuneKind = ref<ReaderTuneKind | null>(null)
const sleepOpen = ref(false)
const pocketActive = ref(false)
const pageTurnRevealed = ref(false)

const state = ref<ReaderState>({
  isPlaying: false,
  isLoading: true,
  sentenceIndex: 0,
  sentenceEndIndex: 0,
  sentenceCount: 0,
  remainingMs: null,
  chapterIndex: 0,
  chapterLabel: '',
  chapterCount: 0,
  canSpeak: true,
  activeEngine: null,
  activeLang: null,
})

const {
  endsAt: sleepEndsAt,
  mode: sleepMode,
  active: sleepActive,
  remainingMs: sleepRemainingMs,
  startIn: startSleepIn,
  startAt: startSleepAt,
  cancel: cancelSleepTimer,
} = useSleepTimer(() => {
  if (!state.value.isPlaying) return
  controller.value?.pause()
  showToast('定时已到，朗读已暂停。')
})

let booting = false
let unmounted = false
let diagnosticsTimer: number | null = null

const rateLabel = computed(() => `${settingsStore.settings.rate.toFixed(1)}×`)

const themeLabel = computed(
  () => READER_THEME_LABELS[settingsStore.settings.theme],
)

const fontLabel = computed(() => `${settingsStore.settings.fontSize} px`)

const sentenceLabel = computed(() => {
  const current = state.value
  if (!current.sentenceCount) return ''
  const start = current.sentenceIndex + 1
  const end = current.sentenceEndIndex + 1
  return end > start
    ? `${start}–${end} / ${current.sentenceCount} 句`
    : `${start} / ${current.sentenceCount} 句`
})

const remainingLabel = computed(() => {
  const current = state.value
  const ms = current.remainingMs
  if (!current.sentenceCount || ms === null) return ''
  if (ms < 45_000) return '本章不到 1 分钟'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `本章剩约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest
    ? `本章剩约 ${hours} 小时 ${rest} 分`
    : `本章剩约 ${hours} 小时`
})

const buildLabel = computed(() => appBuildId.value || '开发版')

function refreshDiagnostics(): void {
  diagnostics.value = controller.value?.getDiagnostics() ?? null
}

function stopDiagnostics(): void {
  if (diagnosticsTimer === null) return
  window.clearInterval(diagnosticsTimer)
  diagnosticsTimer = null
}

function startDiagnostics(): void {
  stopDiagnostics()
  refreshDiagnostics()
  diagnosticsTimer = window.setInterval(refreshDiagnostics, 800)
}

watch(settingsOpen, (open) => {
  if (open) startDiagnostics()
  else {
    stopDiagnostics()
    diagnostics.value = null
  }
})

const aiVoiceLabel = computed(
  () => aiStatus.value?.selectedVoice?.label || '山岚',
)
const englishVoiceLabel = computed(
  () => aiStatus.value?.englishPack?.voices[0]?.label || '英文音色',
)

const playBusy = computed(() => state.value.isPlaying && state.value.isLoading)

const pageTurnsVisible = computed(() => ready.value && !state.value.isPlaying)

const sleepLabel = computed(() => {
  if (!sleepEndsAt.value) return ''
  return sleepMode.value === 'clock'
    ? formatClock(sleepEndsAt.value)
    : formatRemainingShort(sleepRemainingMs.value)
})

const sleepAriaLabel = computed(() => {
  const endsAt = sleepEndsAt.value
  if (!endsAt) return '定时关闭'
  return sleepMode.value === 'clock'
    ? `定时关闭，将在 ${formatTargetDay(endsAt)} 停止`
    : `定时关闭，还剩 ${formatRemaining(sleepRemainingMs.value)}`
})

const bookPercent = computed(() => {
  const current = state.value
  if (!current.chapterCount) return 0
  const sentencePart = current.sentenceCount
    ? (current.sentenceEndIndex + 1) / current.sentenceCount
    : 0
  const ratio = (current.chapterIndex + sentencePart) / current.chapterCount
  return Math.min(100, Math.max(0, Math.round(ratio * 100)))
})

const showUnsupported = computed(() => ready.value && !state.value.canSpeak)

async function boot(): Promise<void> {
  if (booting) return
  booting = true
  loading.value = true
  loadError.value = ''
  ready.value = false

  controller.value?.destroy()
  controller.value = null
  chapters.value = []
  voices.value = []
  englishVoices.value = []
  diagnostics.value = null
  aiStatus.value = null
  bookLexiconStatus.value = null
  pocketActive.value = false
  pageTurnRevealed.value = false
  tocOpen.value = false
  settingsOpen.value = false
  sleepOpen.value = false
  cancelSleepTimer()
  state.value = {
    isPlaying: false,
    isLoading: true,
    sentenceIndex: 0,
    sentenceEndIndex: 0,
    sentenceCount: 0,
    remainingMs: null,
    chapterIndex: 0,
    chapterLabel: '',
    chapterCount: 0,
    canSpeak: true,
    activeEngine: null,
    activeLang: null,
  }

  try {
    const stored = await getBook(props.bookId)
    if (unmounted) return
    if (!stored) {
      showToast('这本书不在书架上了。', 'error')
      navigateToLibrary()
      return
    }

    book.value = stored
    document.title = `${stored.title} · 书声`

    const [saved] = await Promise.all([
      getProgress(stored.id),
      touchBook(stored.id).catch(() => undefined),
    ])
    if (unmounted) return

    await nextTick()
    if (!epubHost.value) throw new Error('阅读器未能初始化，请重试。')

    const nextController = new ReaderController({
      book: stored,
      container: epubHost.value,
      settings: { ...settingsStore.settings },
      progress: saved,
      onState: (next) => {
        state.value = next
      },
      onToast: (message) => showToast(message),
      onVoicesChanged: (nextVoices) => {
        voices.value = nextVoices
      },
      onEnglishVoicesChanged: (nextVoices) => {
        englishVoices.value = nextVoices
      },
      onAiStatus: (status) => {
        aiStatus.value = status
      },
      onBookLexiconStatus: (status) => {
        bookLexiconStatus.value = status
      },
      onContentTap: () => {
        pageTurnRevealed.value = true
      },
      onExternalLink: (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
    })
    controller.value = nextController

    if (unmounted) {
      nextController.destroy()
      return
    }

    const chapterList = await nextController.init()
    if (unmounted) {
      nextController.destroy()
      return
    }

    chapters.value = chapterList
    voices.value = nextController.getVoices()
    englishVoices.value = nextController.getEnglishVoices()
    aiStatus.value = nextController.getAiStatus()
    bookLexiconStatus.value = nextController.getBookLexiconStatus()
    ready.value = true
  } catch (error) {
    if (unmounted) return
    controller.value?.destroy()
    controller.value = null
    loadError.value =
      error instanceof Error ? error.message : '这本书暂时打不开，请稍后重试。'
  } finally {
    if (!unmounted) loading.value = false
    booting = false
  }
}

watch(
  () => settingsStore.settings,
  (value) => {
    controller.value?.setSettings({ ...value })
  },
  { deep: true },
)

function togglePlayback(): void {
  controller.value?.toggle()
}

function previousSentence(): void {
  controller.value?.previousSentence()
}

function nextSentence(): void {
  controller.value?.nextSentence()
}

function turnPage(direction: 'next' | 'previous'): void {
  pageTurnRevealed.value = true
  controller.value?.turnPage(direction)
}

function openToc(): void {
  if (!ready.value) return
  closeSettings()
  tuneOpen.value = false
  tocOpen.value = true
}

function openSettings(): void {
  if (!ready.value) return
  tocOpen.value = false
  tuneOpen.value = false
  settingsOpen.value = true
  const current = controller.value
  if (!current) return
  voices.value = current.refreshSystemVoices()
  englishVoices.value = current.refreshEnglishVoices()
}

function closeSettings(): void {
  settingsOpen.value = false
  controller.value?.cancelVoicePreview()
}

function openTune(kind: ReaderTuneKind): void {
  if (!ready.value) return
  tocOpen.value = false
  settingsOpen.value = false
  tuneKind.value = kind
  tuneOpen.value = true
}

function closeTune(): void {
  tuneOpen.value = false
}

function openSleepTimer(): void {
  if (!ready.value) return
  tocOpen.value = false
  closeSettings()
  tuneOpen.value = false
  sleepOpen.value = true
}

function closeSleepTimer(): void {
  sleepOpen.value = false
}

function applySleepCountdown(minutes: number): void {
  startSleepIn(minutes)
  if (sleepEndsAt.value) {
    showToast(`将在 ${formatClock(sleepEndsAt.value)} 暂停朗读。`)
  }
  sleepOpen.value = false
}

function applySleepClock(hour: number, minute: number): void {
  const target = startSleepAt(hour, minute)
  showToast(`将在 ${formatTargetDay(target)} 暂停朗读。`)
  sleepOpen.value = false
}

function clearSleepTimer(): void {
  cancelSleepTimer()
  sleepOpen.value = false
  showToast('已取消定时。')
}

function previewSystemVoice(voiceURI: string | null): void {
  controller.value?.previewSystemVoice(voiceURI)
}

function previewEnglishVoice(voiceURI: string | null): void {
  controller.value?.previewEnglishVoice(voiceURI)
}

function refreshSystemVoices(): void {
  const current = controller.value
  if (!current) return
  const next = current.refreshSystemVoices()
  voices.value = next
  englishVoices.value = current.refreshEnglishVoices()
  if (!next.length) {
    showToast('还没有检测到中文系统音色，请稍后重试或检查系统语音设置。')
  }
}

function jumpToChapter(index: number): void {
  tocOpen.value = false
  controller.value?.jumpToChapter(index)
}

function findVoicePack(
  status: AiModelStatus,
  voiceId: string,
): AiModelStatus['packs'][number] | null {
  for (const pack of status.packs) {
    if (pack.voices.some((voice) => voice.id === voiceId)) return pack
  }
  return null
}

function patchSettings(partial: Partial<ReaderSettings>): void {
  if (partial.engine === 'sherpa') {
    const status = aiStatus.value
    if (!status?.supported) {
      showToast('当前浏览器不支持离线 AI 音色。', 'error')
      return
    }
    const voiceId = partial.aiVoiceId ?? settingsStore.settings.aiVoiceId
    const pack = findVoicePack(status, voiceId)
    const englishReady = status.englishPack?.phase === 'ready'
    if ((!pack || pack.phase !== 'ready') && !englishReady) {
      showToast(
        partial.aiVoiceId
          ? '所选音色包尚未下载，请先下载。'
          : '请先下载所选离线音色包。',
      )
      return
    }
    controller.value?.prepareAiEngine()
  }
  settingsStore.patch(partial)
}

async function downloadAiModel(
  packId: string,
  voiceId?: string,
): Promise<void> {
  const current = controller.value
  if (!current) return
  if (state.value.isPlaying) {
    showToast('请先暂停朗读再下载音色包。')
    return
  }
  const initialEnglish =
    aiStatus.value?.englishPack?.id === packId ? aiStatus.value.englishPack : null
  const packName =
    aiStatus.value?.packs.find((pack) => pack.id === packId)?.name ??
    initialEnglish?.name ??
    '音色'
  current.cancelVoicePreview()
  try {
    await current.downloadAiModel(packId)
    const nextStatus = current.getAiStatus()
    aiStatus.value = nextStatus
    const englishPack =
      nextStatus.englishPack?.id === packId ? nextStatus.englishPack : null
    if (englishPack?.phase === 'ready') {
      current.prepareAiEngine()
      settingsStore.patch({ englishAi: true })
      showToast(`「${englishPack.name}」已准备好，英文段落将使用离线音色。`)
      return
    }
    const pack = nextStatus.packs.find((item) => item.id === packId)
    const voice =
      pack?.voices.find((item) => item.id === voiceId) ?? pack?.voices[0]
    if (pack?.phase === 'ready' && voice) {
      current.prepareAiEngine()
      settingsStore.patch({ aiVoiceId: voice.id, engine: 'sherpa' })
      showToast(`「${pack.name}」已准备好，已选用「${voice.label}」。`)
      return
    }
    showToast(`${packName}音色包已准备好。`)
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : '下载失败，请检查网络后重试。',
      'error',
    )
  }
}

async function removeAiModel(packId: string): Promise<void> {
  const current = controller.value
  if (!current) return
  if (state.value.isPlaying) {
    showToast('请先暂停朗读再删除音色包。')
    return
  }
  const pack =
    aiStatus.value?.packs.find((item) => item.id === packId) ??
    (aiStatus.value?.englishPack?.id === packId
      ? aiStatus.value.englishPack
      : null)
  if (!pack) return
  if (aiStatus.value?.selectedVoice?.packId === packId) {
    showToast('请先切换到其他音色，再删除当前音色包。')
    return
  }
  current.cancelVoicePreview()
  try {
    await current.removeAiModel(packId)
    showToast(`「${pack.name}」音色包已删除。`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除失败，请稍后重试。', 'error')
  }
}

function resetSettings(): void {
  settingsStore.reset()
  showToast('已恢复默认设置。')
}

function enterPocket(): void {
  if (!ready.value) return
  tocOpen.value = false
  closeSettings()
  pocketActive.value = true
  controller.value?.setPocketActive(true)
}

function leavePocket(): void {
  pocketActive.value = false
  controller.value?.setPocketActive(false)
}

function toggleFromPocket(): void {
  controller.value?.toggle()
}

function leaveReader(): void {
  navigateToLibrary()
}

onMounted(() => {
  void boot()
})

onBeforeUnmount(() => {
  unmounted = true
  stopDiagnostics()
  controller.value?.destroy()
  controller.value = null
  document.title = '书声 · 网页听书 | EPUB / TXT / MOBI / AZW3 / FB2 朗读器'
})
</script>

<template>
  <div class="reader" :class="{ 'reader--pocket': pocketActive }">
    <header class="reader__top">
      <button type="button" class="icon-btn" aria-label="返回书架" @click="leaveReader">
        <AppIcon name="back" :size="22" />
      </button>
      <div class="reader__heading">
        <p class="reader__book">{{ book?.title ?? '正在打开…' }}</p>
        <p class="reader__chapter">
          {{ state.chapterLabel || (loading ? '正在准备' : '开始阅读') }}
        </p>
      </div>
      <div class="reader__tools">
        <button
          type="button"
          class="icon-btn icon-btn--small sleep-tool"
          :class="{ 'is-active': sleepActive }"
          :aria-label="sleepAriaLabel"
          :disabled="!ready"
          @click="openSleepTimer"
        >
          <AppIcon name="clock" :size="19" />
          <span v-if="sleepActive" class="sleep-tool__label">{{ sleepLabel }}</span>
        </button>
        <button
          type="button"
          class="icon-btn icon-btn--small"
          aria-label="目录"
          :disabled="!ready"
          @click="openToc"
        >
          <AppIcon name="list" :size="19" />
        </button>
        <button
          type="button"
          class="icon-btn icon-btn--small"
          aria-label="阅读设置"
          :disabled="!ready"
          @click="openSettings()"
        >
          <AppIcon name="settings" :size="19" />
        </button>
      </div>
    </header>

    <div class="reader__track" aria-hidden="true">
      <i :style="{ width: `${bookPercent}%` }"></i>
    </div>

    <main class="reader__stage" aria-label="正文">
      <div ref="epubHost" class="epub-host"></div>

      <div v-if="loading" class="reader__state">
        <span class="reader__spinner" aria-hidden="true"></span>
        <p class="reader__state-title">正在翻开</p>
        <p class="reader__state-copy">《{{ book?.title ?? '这本书' }}》</p>
      </div>

      <div v-else-if="loadError" class="reader__state">
        <span class="reader__state-icon"><AppIcon name="book" :size="24" /></span>
        <p class="reader__state-title">没能打开这本书</p>
        <p class="reader__state-copy">{{ loadError }}</p>
        <div class="reader__state-actions">
          <button type="button" class="state-btn state-btn--primary" @click="boot">
            重试
          </button>
          <button type="button" class="state-btn" @click="leaveReader">返回书架</button>
        </div>
      </div>

      <button
        v-if="pageTurnsVisible"
        type="button"
        class="page-turn page-turn--prev"
        :class="{ 'page-turn--shown': pageTurnRevealed }"
        aria-label="上一页"
        @click="turnPage('previous')"
      >
        <AppIcon name="back" :size="20" />
      </button>
      <button
        v-if="pageTurnsVisible"
        type="button"
        class="page-turn page-turn--next"
        :class="{ 'page-turn--shown': pageTurnRevealed }"
        aria-label="下一页"
        @click="turnPage('next')"
      >
        <AppIcon name="forward" :size="20" />
      </button>
    </main>

    <p v-if="showUnsupported" class="reader__notice">
      当前浏览器不支持语音朗读，你仍然可以阅读并轻点句子跳转。
    </p>

    <footer class="player">
      <div class="player__meta">
        <span class="player__chapter">{{ state.chapterLabel || '尚未开始朗读' }}</span>
        <span
          v-if="state.activeEngine"
          class="player__engine"
          :class="{ 'player__engine--ai': state.activeEngine === 'sherpa' }"
        >
          {{
            state.activeEngine === 'sherpa'
              ? `${state.activeLang === 'en' ? englishVoiceLabel : aiVoiceLabel} · 离线`
              : '系统语音'
          }}
        </span>
        <span v-if="state.sentenceCount" class="player__count">
          {{ sentenceLabel }}
        </span>
        <span v-if="remainingLabel" class="player__remaining">
          {{ remainingLabel }}
        </span>
      </div>
      <div class="player__controls">
        <div class="player__tune" role="group" aria-label="阅读外观">
          <button
            type="button"
            class="tune-btn"
            :disabled="!ready"
            :aria-label="`阅读主题，当前${themeLabel}`"
            @click="openTune('theme')"
          >
            <AppIcon name="theme" :size="15" />
          </button>
          <button
            type="button"
            class="tune-btn tune-btn--font"
            :disabled="!ready"
            :aria-label="`字号，当前${fontLabel}`"
            @click="openTune('font')"
          >
            <span aria-hidden="true">Aa</span>
          </button>
        </div>
        <div class="player__transport">
          <button
            type="button"
            class="transport-btn"
            :disabled="!ready"
            aria-label="上一句"
            @click="previousSentence"
          >
            <AppIcon name="skip-back" :size="21" />
          </button>
          <button
            type="button"
            class="play-btn"
            :disabled="!ready || !state.canSpeak"
            :aria-label="state.isPlaying ? '暂停朗读' : '开始朗读'"
            @click="togglePlayback"
          >
            <span v-if="playBusy" class="player__spinner" aria-hidden="true"></span>
            <AppIcon v-else :name="state.isPlaying ? 'pause' : 'play'" :size="25" />
          </button>
          <button
            type="button"
            class="transport-btn"
            :disabled="!ready"
            aria-label="下一句"
            @click="nextSentence"
          >
            <AppIcon name="skip-forward" :size="21" />
          </button>
        </div>
        <div class="player__tune" role="group" aria-label="朗读速度与口袋模式">
          <button
            type="button"
            class="tune-btn tune-btn--rate"
            :disabled="!ready"
            :aria-label="`朗读速度，当前${rateLabel}`"
            @click="openTune('rate')"
          >
            <span aria-hidden="true">{{ rateLabel }}</span>
          </button>
          <button
            type="button"
            class="tune-btn"
            :disabled="!ready"
            aria-label="进入口袋模式"
            @click="enterPocket"
          >
            <AppIcon name="moon" :size="16" />
          </button>
        </div>
      </div>
    </footer>

    <TocSheet
      :open="tocOpen"
      :chapters="chapters"
      :current-index="state.chapterIndex"
      @close="tocOpen = false"
      @select="jumpToChapter"
    />

    <ReaderSettingsSheet
      :open="settingsOpen"
      :settings="settingsStore.settings"
      :voices="voices"
      :english-voices="englishVoices"
      :ai="aiStatus"
      :book-lexicon="bookLexiconStatus"
      :is-playing="state.isPlaying"
      :diagnostics="diagnostics"
      :build-id="buildLabel"
      @close="closeSettings"
      @patch="patchSettings"
      @reset="resetSettings"
      @notice="showToast"
      @preview-voice="previewSystemVoice"
      @preview-english-voice="previewEnglishVoice"
      @refresh-voices="refreshSystemVoices"
      @download-ai="downloadAiModel"
      @remove-ai="removeAiModel"
    />

    <ReaderTuneSheet
      :open="tuneOpen"
      :kind="tuneKind"
      :settings="settingsStore.settings"
      @close="closeTune"
      @patch="patchSettings"
    />

    <SleepTimerSheet
      :open="sleepOpen"
      :active="sleepActive"
      :ends-at="sleepEndsAt"
      :remaining-ms="sleepRemainingMs"
      :mode="sleepMode"
      @close="closeSleepTimer"
      @start-countdown="applySleepCountdown"
      @start-at-time="applySleepClock"
      @cancel="clearSleepTimer"
    />

    <PocketOverlay
      v-if="pocketActive"
      :book-title="book?.title ?? ''"
      :chapter-label="state.chapterLabel"
      :is-playing="state.isPlaying"
      :sleep-label="sleepActive ? sleepLabel : ''"
      @close="leavePocket"
      @toggle="toggleFromPocket"
      @sleep="openSleepTimer"
    />
  </div>
</template>

<style scoped>
.reader {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--app-bg);
  color: var(--app-fg);
}

/* Layout is kept intact so scroll/highlight can resync the moment the
   overlay closes; only painting is suppressed while pocket mode is active. */
.reader--pocket .reader__stage {
  visibility: hidden;
}

.reader__top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: calc(env(safe-area-inset-top, 0px) + 7px) 10px 7px;
  background: var(--app-bg);
  z-index: 3;
}

/* Keep the controls clear of the taller iOS status surface. */
@media (display-mode: standalone) {
  @supports (-webkit-touch-callout: none) {
    .reader__top {
      padding-top: calc(env(safe-area-inset-top, 0px) + 19px);
    }
  }
}

.icon-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  color: var(--app-fg);
  transition: background-color 0.16s ease, opacity 0.16s ease;
}

.icon-btn:active:not(:disabled) {
  background: color-mix(in srgb, var(--app-fg) 7%, transparent);
}

.icon-btn:disabled {
  opacity: 0.3;
}

.icon-btn--small {
  width: 38px;
  height: 38px;
}

.sleep-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: auto;
  min-width: 38px;
  padding: 0 8px;
  border-radius: 999px;
}

.sleep-tool.is-active {
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  color: var(--app-accent);
}

.sleep-tool__label {
  font-size: 10.5px;
  line-height: 1;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.reader__heading {
  flex: 1;
  min-width: 0;
  padding: 0 4px;
  text-align: center;
  line-height: 1.3;
}

.reader__book {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.reader__chapter {
  margin: 3px 0 0;
  font-size: 10.5px;
  letter-spacing: 0.03em;
  color: var(--app-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.reader__tools {
  flex: none;
  display: flex;
  align-items: center;
}

.reader__track {
  flex: none;
  height: 2px;
  background: var(--app-line-soft);
  overflow: hidden;
}

.reader__track i {
  display: block;
  height: 100%;
  border-radius: 0 2px 2px 0;
  background: var(--app-accent);
  transition: width 0.5s cubic-bezier(0.32, 0.72, 0, 1);
}

.reader__stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.epub-host {
  position: absolute;
  inset: 0;
}

.epub-host :deep(.epub-container) {
  background: transparent;
}

/* Phones do not deliver touches into the book iframe, so the stage keeps
   pointer events and maps taps back into the text. */
@media (hover: none) and (pointer: coarse) {
  .epub-host :deep(iframe) {
    pointer-events: none;
  }
}

.page-turn {
  position: absolute;
  top: 50%;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 36px;
  height: 64px;
  padding: 0;
  transform: translateY(-50%);
  border: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-bg) 72%, transparent);
  color: var(--app-fg);
  opacity: 0.34;
  transition: opacity 0.18s ease, background-color 0.16s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.page-turn--prev {
  left: 8px;
}

.page-turn--next {
  right: 8px;
}

.page-turn--shown {
  opacity: 1;
}

.page-turn:active {
  background: color-mix(in srgb, var(--app-fg) 8%, transparent);
}

.reader__state {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 32px;
  text-align: center;
  background: var(--app-bg);
}

.reader__spinner {
  width: 26px;
  height: 26px;
  margin-bottom: 16px;
  border: 2px solid var(--app-line);
  border-top-color: var(--app-accent);
  border-radius: 50%;
  animation: reader-spin 0.9s linear infinite;
}

.reader__state-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 16px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
  color: var(--app-accent);
}

.reader__state-title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.reader__state-copy {
  max-width: 24em;
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--app-muted);
}

.reader__state-actions {
  display: flex;
  gap: 9px;
  margin-top: 22px;
}

.state-btn {
  height: 42px;
  padding: 0 18px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 13px;
  color: var(--app-fg);
}

.state-btn--primary {
  border-color: transparent;
  background: var(--app-accent);
  color: var(--app-bg);
}

.reader__notice {
  flex: none;
  margin: 0 14px 8px;
  padding: 9px 13px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 16%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent) 6%, transparent);
  font-size: 11.5px;
  line-height: 1.6;
  text-align: center;
  color: var(--app-muted);
}

.player {
  flex: none;
  padding: 9px 16px calc(env(safe-area-inset-bottom, 0px) + 11px);
  border-top: 1px solid var(--app-line-soft);
  background: color-mix(in srgb, var(--app-ui) 86%, transparent);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.player__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 20px;
  padding: 0 2px;
}

.player__chapter {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  letter-spacing: 0.02em;
  color: var(--app-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.player__engine {
  flex: none;
  padding: 2px 7px;
  border: 1px solid var(--app-line-soft);
  border-radius: 999px;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--app-muted);
  white-space: nowrap;
}

.player__engine--ai {
  border-color: color-mix(in srgb, var(--app-accent) 28%, transparent);
  background: color-mix(in srgb, var(--app-accent) 6%, transparent);
  color: var(--app-accent);
}

.player__count {
  flex: none;
  font-size: 10.5px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.player__remaining {
  flex: none;
  font-size: 10.5px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  white-space: nowrap;
}

.player__tune {
  display: flex;
  align-items: center;
  gap: 5px;
}

.tune-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--app-line);
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-bg) 46%, transparent);
  color: var(--app-muted);
  transition: border-color 0.16s ease, color 0.16s ease;
}

.tune-btn:disabled {
  opacity: 0.4;
}

.tune-btn:active:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 40%, transparent);
  color: var(--app-accent);
}

.tune-btn--font {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.tune-btn--rate {
  font-size: 10px;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}

.player__controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(8px, 1.6vw, 16px);
  margin-top: 2px;
}

.player__transport {
  display: flex;
  align-items: center;
  gap: 10px;
}

.transport-btn {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: var(--app-fg);
  opacity: 0.82;
  transition: opacity 0.16s ease, background-color 0.16s ease;
}

.transport-btn:active:not(:disabled) {
  background: color-mix(in srgb, var(--app-fg) 7%, transparent);
  opacity: 1;
}

.transport-btn:disabled {
  opacity: 0.25;
}

.play-btn {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: var(--app-accent);
  color: var(--app-bg);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--app-accent) 28%, transparent);
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.play-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.play-btn:disabled {
  opacity: 0.4;
  box-shadow: none;
}

.player__spinner {
  width: 20px;
  height: 20px;
  border: 2px solid color-mix(in srgb, var(--app-bg) 30%, transparent);
  border-top-color: var(--app-bg);
  border-radius: 50%;
  animation: reader-spin 0.8s linear infinite;
}

@keyframes reader-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 389px) {
  .player__tune {
    gap: 4px;
  }

  .tune-btn {
    width: 28px;
    height: 28px;
  }

  .player__transport {
    gap: 8px;
  }

  .transport-btn {
    width: 36px;
    height: 36px;
  }

  .play-btn {
    width: 52px;
    height: 52px;
  }
}

@media (max-width: 359px) {
  .sleep-tool {
    width: 38px;
    padding: 0;
  }

  .sleep-tool__label {
    display: none;
  }

  .player__tune {
    gap: 3px;
  }

  .tune-btn {
    width: 24px;
    height: 24px;
  }

  .player__transport {
    gap: 4px;
  }

  .play-btn {
    width: 48px;
    height: 48px;
  }
}
</style>
