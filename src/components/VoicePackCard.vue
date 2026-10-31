<script setup lang="ts">
import { computed } from 'vue'
import type { AiPackStatus } from '@/core/tts/AiModel'
import AppIcon from './AppIcon.vue'

const props = withDefaults(
  defineProps<{
    pack: AiPackStatus
    variant?: 'zh' | 'en'
    selected: boolean
    selectedVoiceId?: string | null
    pendingVoiceId?: string | null
    pendingVoiceLabel?: string | null
    busy: boolean
    confirmRemove: boolean
    removableWhenSelected?: boolean
  }>(),
  {
    variant: 'zh',
    selectedVoiceId: null,
    pendingVoiceId: null,
    pendingVoiceLabel: null,
    removableWhenSelected: false,
  },
)

const emit = defineEmits<{
  select: [voiceId: string]
  download: [voiceId?: string]
  remove: []
  cancelRemove: []
  cancelPending: []
}>()

const isEnglish = computed(() => props.variant === 'en')

const title = computed(() =>
  isEnglish.value
    ? `英文 · ${props.pack.voices[0]?.label ?? '离线音色'}`
    : props.pack.name,
)

const downloadVoiceId = computed(() =>
  isEnglish.value
    ? props.pack.voices[0]?.id
    : props.pendingVoiceId ?? undefined,
)

const showRemoveActions = computed(
  () => !props.selected || props.removableWhenSelected,
)

const errorFallback = computed(() =>
  isEnglish.value ? '英文音色包准备失败，请重试。' : '音色包准备失败，请重试。',
)

const missingNote = computed(() =>
  isEnglish.value
    ? `另需共享语音运行时 ${formatBytes(props.pack.runtimeBytes)}；中文音色已下载时不会重复下载。`
    : `另需共享语音运行时 ${formatBytes(props.pack.runtimeBytes)}（仅首次下载）。`,
)

function stateLabel(pack: AiPackStatus): string {
  if (pack.phase === 'ready') return '已缓存'
  if (pack.phase === 'downloading') return '下载中'
  if (pack.phase === 'error') return '需重试'
  return '未下载'
}

function packPercent(pack: AiPackStatus): number {
  if (pack.totalBytes <= 0) return 0
  return Math.min(
    100,
    Math.round((pack.downloadedBytes / pack.totalBytes) * 100),
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}
</script>

<template>
  <article class="voice-pack" :class="{ 'is-selected': selected }">
    <header class="voice-pack__head">
      <div class="voice-pack__title">
        <h4 class="voice-pack__name">{{ title }}</h4>
        <span
          class="voice-pack__badge"
          :class="{ 'is-commercial': pack.license.commercialUse }"
        >
          {{ pack.license.commercialUse ? '可商用' : '非商业' }}
        </span>
        <span v-if="selected" class="voice-pack__current">使用中</span>
      </div>
      <span class="pack-state" :data-phase="pack.phase">
        {{ stateLabel(pack) }}
      </span>
    </header>

    <p class="voice-pack__desc">{{ pack.description }}</p>
    <p class="voice-pack__license">
      {{ pack.license.label }} · {{ pack.license.notice }}
    </p>

    <div
      v-if="!isEnglish"
      class="voice-chips"
      role="group"
      :aria-label="`${pack.name}音色`"
    >
      <button
        v-for="voice in pack.voices"
        :key="voice.id"
        type="button"
        class="voice-chip"
        :class="{
          'is-active': selectedVoiceId === voice.id,
          'is-locked': pack.phase !== 'ready',
          'is-pending': pendingVoiceId === voice.id,
        }"
        :aria-disabled="pack.phase !== 'ready'"
        @click="emit('select', voice.id)"
      >
        <span class="voice-chip__head">
          <span class="voice-chip__label">{{ voice.label }}</span>
          <span v-if="pendingVoiceId === voice.id" class="voice-chip__pending">
            待下载
          </span>
          <span
            v-else-if="selectedVoiceId === voice.id"
            class="voice-chip__check"
            aria-hidden="true"
          >
            <AppIcon name="check" :size="10" />
          </span>
        </span>
        <span class="voice-chip__desc">{{ voice.description }}</span>
      </button>
    </div>

    <div v-if="pack.phase === 'downloading'" class="pack-progress">
      <div class="pack-bar">
        <i :style="{ width: `${packPercent(pack)}%` }"></i>
      </div>
      <div class="pack-progress-meta">
        <span>{{ pack.message || '正在下载…' }}</span>
        <span>{{ packPercent(pack) }}%</span>
      </div>
      <p class="pack-note">
        {{ formatBytes(pack.downloadedBytes) }} /
        {{ formatBytes(pack.totalBytes) }} · 含共享运行时
      </p>
    </div>

    <div v-else-if="pack.phase === 'ready'" class="pack-actions">
      <span class="pack-ready-line">
        <span class="pack-dot" aria-hidden="true"></span>
        已缓存 {{ formatBytes(pack.modelBytes) }}，断网也能朗读
      </span>
      <template v-if="showRemoveActions">
        <button
          v-if="!confirmRemove"
          type="button"
          class="pack-link pack-link--danger"
          :class="{ 'is-blocked': busy }"
          @click="emit('remove')"
        >
          删除音色包
        </button>
        <template v-else>
          <button type="button" class="pack-link" @click="emit('cancelRemove')">
            取消
          </button>
          <button
            type="button"
            class="pack-link pack-link--danger"
            :class="{ 'is-blocked': busy }"
            @click="emit('remove')"
          >
            确认删除
          </button>
        </template>
      </template>
      <span v-else class="pack-inuse">切换其他音色后可删除</span>
    </div>

    <div v-else-if="pack.phase === 'error'" class="pack-error">
      <p class="pack-error-text">
        {{ pack.error || errorFallback }}
      </p>
      <button
        type="button"
        class="pack-btn"
        :class="{ 'is-blocked': busy }"
        @click="emit('download', downloadVoiceId)"
      >
        <AppIcon name="download" :size="16" />
        <template v-if="!isEnglish && pendingVoiceLabel">
          重试并切换到「{{ pendingVoiceLabel }}」
        </template>
        <template v-else>重试下载</template>
      </button>
    </div>

    <template v-else>
      <div class="pack-actions">
        <button
          type="button"
          class="pack-btn pack-btn--primary"
          :class="{
            'is-blocked': busy,
            'is-pending': !isEnglish && Boolean(pendingVoiceLabel),
          }"
          @click="emit('download', downloadVoiceId)"
        >
          <AppIcon name="download" :size="16" />
          <template v-if="isEnglish">
            下载英文音色包（{{ formatBytes(pack.modelBytes) }}）
          </template>
          <template v-else-if="pendingVoiceLabel">
            下载并切换到「{{ pendingVoiceLabel }}」（{{
              formatBytes(pack.modelBytes)
            }}）
          </template>
          <template v-else>
            下载 {{ pack.name }}（{{ formatBytes(pack.modelBytes) }}）
          </template>
        </button>
        <button
          v-if="!isEnglish && pendingVoiceLabel"
          type="button"
          class="pack-link"
          @click="emit('cancelPending')"
        >
          取消
        </button>
      </div>
      <p class="pack-note">{{ missingNote }}</p>
    </template>
  </article>
</template>

<style scoped>
.pack-state {
  flex: none;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 6%, transparent);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--app-muted);
}

.pack-state[data-phase='ready'] {
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  color: var(--app-accent);
}

.pack-state[data-phase='downloading'] {
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
  color: var(--app-accent);
}

.pack-state[data-phase='error'] {
  background: color-mix(in srgb, #a3412c 10%, transparent);
  color: color-mix(in srgb, #c25a3f 72%, var(--app-fg));
}

.pack-progress {
  margin-top: 13px;
}

.pack-bar {
  height: 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--app-fg) 9%, transparent);
  overflow: hidden;
}

.pack-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--app-accent);
  transition: width 0.25s ease;
}

.pack-progress-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--app-muted);
}

.pack-progress-meta span:last-child {
  flex: none;
  color: var(--app-accent);
  font-variant-numeric: tabular-nums;
}

.pack-ready-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12.5px;
  color: var(--app-fg);
}

.pack-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--app-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}

.pack-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 13px;
}

.pack-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 40px;
  padding: 8px 16px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  color: var(--app-fg);
  background: var(--app-bg);
}

.pack-btn--primary {
  border-color: transparent;
  background: var(--app-accent);
  color: var(--app-bg);
}

.pack-btn--primary.is-pending {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 16%, transparent);
}

.pack-btn.is-blocked,
.pack-link.is-blocked {
  opacity: 0.55;
}

.pack-btn:active {
  transform: scale(0.98);
}

.pack-link {
  padding: 7px 2px;
  font-size: 11.5px;
  color: var(--app-muted);
}

.pack-link--danger {
  color: color-mix(in srgb, #c25a3f 72%, var(--app-fg));
}

.pack-error {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, #a3412c 18%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, #a3412c 5%, transparent);
}

.pack-error-text {
  margin: 0 0 10px;
  font-size: 11.5px;
  line-height: 1.65;
  color: color-mix(in srgb, #a3412c 84%, var(--app-fg));
}

.pack-note {
  margin: 9px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--app-muted);
}

.voice-pack {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 9%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-bg) 52%, transparent);
}

.voice-pack.is-selected {
  border-color: color-mix(in srgb, var(--app-accent) 28%, transparent);
  background: color-mix(in srgb, var(--app-accent) 4%, var(--app-bg));
}

.voice-pack__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.voice-pack__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.voice-pack__name {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-fg);
}

.voice-pack__badge {
  flex: none;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--app-muted);
}

.voice-pack__badge.is-commercial {
  border-color: color-mix(in srgb, var(--app-accent) 30%, transparent);
  background: color-mix(in srgb, var(--app-accent) 6%, transparent);
  color: var(--app-accent);
}

.voice-pack__current {
  flex: none;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--app-accent);
}

.voice-pack__desc {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.65;
  color: color-mix(in srgb, var(--app-fg) 78%, transparent);
}

.voice-pack__license {
  margin: 5px 0 0;
  font-size: 10px;
  line-height: 1.55;
  color: color-mix(in srgb, var(--app-muted) 88%, transparent);
}

.voice-chips {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
  gap: 8px;
  margin-top: 11px;
}

.voice-chip {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 11%, transparent);
  border-radius: 12px;
  background: var(--app-bg);
  color: var(--app-fg);
  text-align: left;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.voice-chip.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 54%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-bg));
}

.voice-chip.is-locked {
  opacity: 0.55;
}

.voice-chip.is-pending {
  border-color: color-mix(in srgb, var(--app-accent) 44%, transparent);
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-bg));
}

.voice-chip:active {
  transform: scale(0.99);
}

.voice-chip__pending {
  flex: none;
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--app-accent);
}

.voice-chip__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.voice-chip__label {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.voice-chip__desc {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
}

.voice-chip__check {
  flex: none;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--app-accent);
  color: var(--app-bg);
}

.pack-inuse {
  padding: 7px 2px;
  font-size: 10.5px;
  color: var(--app-muted);
}
</style>