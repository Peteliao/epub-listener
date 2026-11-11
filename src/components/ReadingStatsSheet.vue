<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  flushListeningTracking,
  formatListenDuration,
  getListeningSnapshot,
  type ListeningSnapshot,
} from '@/core/stats/listeningStats'
import {
  buildShareText,
  renderShareCard,
} from '@/core/share/shareCard'
import {
  canShareImage,
  copyShareText,
  downloadBlob,
  shareImageCard,
} from '@/core/share/share'
import { useSettingsStore } from '@/stores/settings'
import AppIcon from './AppIcon.vue'
import Sheet from './Sheet.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; notice: [message: string] }>()

const settingsStore = useSettingsStore()
const stats = ref<ListeningSnapshot>(getListeningSnapshot())
const includeBook = ref(true)
const shareSupported = ref(false)
const previewUrl = ref('')
const previewBlob = ref<Blob | null>(null)
const generating = ref(false)
const sharing = ref(false)
let generation = 0

const hasData = computed(() => stats.value.totalMs > 0)
const totalLabel = computed(() =>
  formatListenDuration(stats.value.totalMs, true),
)
const todayLabel = computed(() => formatListenDuration(stats.value.todayMs))
const busy = computed(() => generating.value || sharing.value)
const firstMonth = computed(() => {
  const timestamp = stats.value.firstAt
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`
})

function revokePreview(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewBlob.value = null
}

async function generatePreview(): Promise<void> {
  const id = ++generation
  revokePreview()
  if (!props.open || !hasData.value) {
    generating.value = false
    return
  }

  generating.value = true
  try {
    const blob = await renderShareCard({
      snapshot: stats.value,
      theme: settingsStore.settings.theme,
      includeBook: includeBook.value && Boolean(stats.value.lastBook),
    })
    if (id !== generation) return
    previewBlob.value = blob
    previewUrl.value = URL.createObjectURL(blob)
  } catch (error) {
    if (id === generation) {
      emit(
        'notice',
        error instanceof Error ? error.message : '分享卡生成失败，请重试。',
      )
    }
  } finally {
    if (id === generation) generating.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      generation += 1
      generating.value = false
      sharing.value = false
      revokePreview()
      return
    }
    flushListeningTracking()
    stats.value = getListeningSnapshot()
    includeBook.value = true
    shareSupported.value = canShareImage()
    void generatePreview()
  },
  { immediate: true },
)

watch(includeBook, () => {
  if (props.open && hasData.value) void generatePreview()
})

async function currentBlob(): Promise<Blob> {
  if (previewBlob.value) return previewBlob.value
  const blob = await renderShareCard({
    snapshot: stats.value,
    theme: settingsStore.settings.theme,
    includeBook: includeBook.value && Boolean(stats.value.lastBook),
  })
  previewBlob.value = blob
  previewUrl.value = URL.createObjectURL(blob)
  return blob
}

async function share(): Promise<void> {
  if (busy.value || !hasData.value) return
  sharing.value = true
  try {
    // Keep the Web Share call inside the tap gesture when the preview is ready;
    // iOS drops the share sheet if an await runs first.
    const blob = previewBlob.value ?? (await currentBlob())
    const result = await shareImageCard(blob, buildShareText(stats.value))
    if (result === 'downloaded') {
      emit('notice', '分享卡已保存，可发送给朋友。')
    }
  } catch (error) {
    emit(
      'notice',
      error instanceof Error ? error.message : '分享失败，请稍后重试。',
    )
  } finally {
    sharing.value = false
  }
}

async function save(): Promise<void> {
  if (busy.value || !hasData.value) return
  try {
    downloadBlob(await currentBlob())
    emit('notice', '分享卡已保存。')
  } catch (error) {
    emit(
      'notice',
      error instanceof Error ? error.message : '保存失败，请稍后重试。',
    )
  }
}

async function copy(): Promise<void> {
  const copied = await copyShareText(buildShareText(stats.value))
  emit('notice', copied ? '分享文案已复制。' : '复制失败，请手动选择文字。')
}

onBeforeUnmount(revokePreview)
</script>

<template>
  <Sheet
    :open="open"
    title="听书统计"
    subtitle="时长只记录在这台设备上"
    @close="emit('close')"
  >
    <template v-if="hasData">
      <section class="summary">
        <p class="summary__label">累计听书</p>
        <p class="summary__total">{{ totalLabel }}</p>
        <p class="summary__since">
          自 {{ firstMonth }} 起 · {{ stats.activeDays }} 天有记录
        </p>
      </section>

      <div class="metrics">
        <div>
          <span>今日</span>
          <strong>{{ todayLabel }}</strong>
        </div>
        <div>
          <span>连续</span>
          <strong>{{ stats.streakDays }} 天</strong>
        </div>
        <div>
          <span>听过</span>
          <strong>{{ stats.bookCount }} 本</strong>
        </div>
      </div>

      <section class="preview" aria-label="分享卡预览">
        <div class="preview__frame">
          <img v-if="previewUrl" :src="previewUrl" alt="听书分享卡预览" />
          <span v-else class="preview__skeleton" aria-hidden="true"></span>
        </div>
        <p class="preview__hint">
          分享卡在本机生成，只有点击分享后才会发送。
        </p>
      </section>

      <button
        v-if="stats.lastBook"
        type="button"
        class="book-row"
        role="switch"
        :aria-checked="includeBook"
        @click="includeBook = !includeBook"
      >
        <span class="book-row__copy">
          <strong>在分享卡中显示书名</strong>
          <small>《{{ stats.lastBook.title }}》</small>
        </span>
        <span class="book-row__switch" :class="{ 'is-on': includeBook }">
          <span></span>
        </span>
      </button>

      <div class="actions">
        <button
          type="button"
          class="actions__primary"
          :disabled="busy"
          @click="share"
        >
          <AppIcon :name="shareSupported ? 'share' : 'download'" :size="18" />
          {{
            generating
              ? '正在生成分享卡…'
              : sharing
                ? '正在分享…'
                : shareSupported
                  ? '分享给朋友'
                  : '保存分享卡'
          }}
        </button>
        <div class="actions__row">
          <button type="button" :disabled="busy" @click="save">保存图片</button>
          <span class="actions__dot" aria-hidden="true"></span>
          <button type="button" @click="copy">复制文案</button>
        </div>
      </div>
    </template>

    <div v-else class="empty">
      <span class="empty__icon"><AppIcon name="clock" :size="26" /></span>
      <strong>还没有听书记录</strong>
      <p>开始朗读后，书声会在这里记下你的听书时光，并生成可分享的海报。</p>
    </div>
  </Sheet>
</template>

<style scoped>
.summary {
  padding: 12px 0 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
}

.summary__label {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--app-muted);
}

.summary__total {
  margin: 9px 0 0;
  font-family: var(--font-serif);
  font-size: 32px;
  font-weight: 600;
  letter-spacing: 0.03em;
  line-height: 1.2;
}

.summary__since {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--app-muted);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 14px 0 16px;
}

.metrics > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  border-left: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
}

.metrics > div:first-child {
  border-left: 0;
}

.metrics span {
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--app-muted);
}

.metrics strong {
  font-family: var(--font-serif);
  font-size: 16.5px;
  font-weight: 600;
}

.preview {
  padding: 4px 0 14px;
  text-align: center;
}

.preview__frame {
  width: min(52vw, 212px);
  aspect-ratio: 3 / 4;
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-fg) 10%, transparent);
  border-radius: 16px;
  background: var(--app-bg);
  box-shadow: 0 16px 36px color-mix(in srgb, var(--app-fg) 16%, transparent);
}

.preview__frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview__skeleton {
  display: block;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    110deg,
    color-mix(in srgb, var(--app-fg) 5%, transparent) 30%,
    color-mix(in srgb, var(--app-fg) 10%, transparent) 50%,
    color-mix(in srgb, var(--app-fg) 5%, transparent) 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.3s ease-in-out infinite;
}

.preview__hint {
  margin: 11px 0 0;
  font-size: 10.5px;
  color: var(--app-muted);
}

.book-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  width: 100%;
  padding: 13px 0;
  border-top: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
  text-align: left;
}

.book-row__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.book-row__copy strong {
  font-size: 12.5px;
  font-weight: 600;
}

.book-row__copy small {
  overflow: hidden;
  font-size: 11px;
  color: var(--app-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.book-row__switch {
  flex: none;
  display: inline-flex;
  align-items: center;
  width: 42px;
  height: 25px;
  padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 16%, transparent);
  transition: background-color 0.18s ease;
}

.book-row__switch span {
  display: block;
  width: 21px;
  height: 21px;
  border-radius: 50%;
  background: var(--app-bg);
  box-shadow: 0 1px 3px rgba(20, 14, 8, 0.25);
  transition: transform 0.18s ease;
}

.book-row__switch.is-on {
  background: var(--app-accent);
}

.book-row__switch.is-on span {
  transform: translateX(17px);
}

.actions {
  padding-top: 4px;
}

.actions__primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 48px;
  border-radius: 999px;
  background: var(--app-accent);
  color: var(--app-bg);
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  box-shadow: 0 10px 24px color-mix(in srgb, var(--app-accent) 24%, transparent);
  transition: transform 0.16s ease, opacity 0.16s ease;
}

.actions__primary:active:not(:disabled) {
  transform: scale(0.98);
}

.actions__primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.actions__row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 9px 0 2px;
}

.actions__row button {
  padding: 6px 4px;
  font-size: 12px;
  color: var(--app-muted);
}

.actions__row button:disabled {
  opacity: 0.5;
}

.actions__dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-fg) 26%, transparent);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 34px 12px 42px;
  text-align: center;
}

.empty__icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 15px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  color: var(--app-accent);
}

.empty strong {
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
}

.empty p {
  max-width: 24em;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted);
}

@media (min-width: 640px) {
  .preview__frame {
    width: 240px;
  }
}

@keyframes shimmer {
  from {
    background-position: 180% 0;
  }
  to {
    background-position: -80% 0;
  }
}
</style>
