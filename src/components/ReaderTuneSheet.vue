<script setup lang="ts">
import { computed } from 'vue'
import type { ReaderSettings, ReaderTuneKind } from '@/types'
import {
  READER_PALETTES,
  READER_THEME_LABELS,
  READER_THEME_ORDER,
} from '@/types'
import AppIcon from './AppIcon.vue'
import Sheet from './Sheet.vue'

const props = defineProps<{
  open: boolean
  kind: ReaderTuneKind | null
  settings: ReaderSettings
}>()

const emit = defineEmits<{
  close: []
  patch: [value: Partial<ReaderSettings>]
}>()

const THEMES = READER_THEME_ORDER.map((value) => ({
  value,
  label: READER_THEME_LABELS[value],
}))

const RATES = [0.8, 1, 1.2, 1.5, 2]

const RATE_HINTS: Record<string, string> = {
  '0.8': '慢读',
  '1.0': '常速',
  '1.2': '稍快',
  '1.5': '快速',
  '2.0': '极速',
}

const FONT_PRESETS = [
  { size: 16, label: '小' },
  { size: 18, label: '标准' },
  { size: 21, label: '大' },
  { size: 24, label: '特大' },
]

const title = computed(() => {
  if (props.kind === 'theme') return '阅读主题'
  if (props.kind === 'font') return '字号'
  return '朗读速度'
})

const subtitle = computed(() => {
  if (props.kind === 'theme') return '纸张与文字配色，选择后立即生效'
  if (props.kind === 'font') return '正文文字大小，14–28 px'
  return '选择朗读节奏，锁屏播放同样沿用'
})

const rateHint = computed(() => RATE_HINTS[props.settings.rate.toFixed(1)] ?? '')

function changeFont(delta: number): void {
  const next = Math.min(28, Math.max(14, props.settings.fontSize + delta))
  if (next !== props.settings.fontSize) emit('patch', { fontSize: next })
}

function onFontRange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value !== props.settings.fontSize) {
    emit('patch', { fontSize: Math.min(28, Math.max(14, value)) })
  }
}
</script>

<template>
  <Sheet :open="open" :title="title" :subtitle="subtitle" @close="emit('close')">
    <div v-if="kind === 'theme'" class="tune">
      <div class="theme-grid" role="radiogroup" aria-label="阅读主题">
        <button
          v-for="theme in THEMES"
          :key="theme.value"
          type="button"
          class="theme-card"
          role="radio"
          :aria-checked="settings.theme === theme.value"
          :class="{ 'is-active': settings.theme === theme.value }"
          @click="emit('patch', { theme: theme.value })"
        >
          <span
            class="theme-card__preview"
            :style="{
              background: READER_PALETTES[theme.value].bg,
              color: READER_PALETTES[theme.value].fg,
              borderColor: `${READER_PALETTES[theme.value].fg}26`,
            }"
          >
            <span class="theme-card__mark">文</span>
            <span class="theme-card__line"></span>
            <span class="theme-card__line theme-card__line--short"></span>
            <i
              class="theme-card__dot"
              :style="{ background: READER_PALETTES[theme.value].accent }"
            ></i>
          </span>
          <span class="theme-card__label">
            {{ theme.label }}
            <AppIcon
              v-if="settings.theme === theme.value"
              name="check"
              :size="12"
            />
          </span>
        </button>
      </div>
      <p class="tune__hint">
        浅色可选纸白、护眼、青瓷等；夜间推荐夜读、靛蓝、省电。省电为纯黑背景，OLED 屏更省电。
      </p>
    </div>

    <div v-else-if="kind === 'font'" class="tune">
      <div
        class="font-preview"
        :style="{ fontSize: `${settings.fontSize}px` }"
      >
        山间的风翻过书页，字句缓缓醒来。
      </div>
      <div class="font-line">
        <button
          type="button"
          class="font-step"
          :disabled="settings.fontSize <= 14"
          aria-label="减小字号"
          @click="changeFont(-1)"
        >
          A−
        </button>
        <input
          class="font-range"
          type="range"
          min="14"
          max="28"
          step="1"
          :value="settings.fontSize"
          aria-label="字号"
          @input="onFontRange"
        />
        <button
          type="button"
          class="font-step"
          :disabled="settings.fontSize >= 28"
          aria-label="增大字号"
          @click="changeFont(1)"
        >
          A+
        </button>
      </div>
      <div class="font-presets" role="group" aria-label="常用字号">
        <button
          v-for="preset in FONT_PRESETS"
          :key="preset.size"
          type="button"
          class="font-preset"
          :class="{ 'is-active': settings.fontSize === preset.size }"
          @click="emit('patch', { fontSize: preset.size })"
        >
          <strong>{{ preset.label }}</strong>
          <small>{{ preset.size }} px</small>
        </button>
      </div>
      <p class="tune__hint">
        当前 {{ settings.fontSize }} px，正文会立即重排；字号只影响阅读界面。
      </p>
    </div>

    <div v-else-if="kind === 'rate'" class="tune">
      <div class="rate-stage">
        <strong>{{ settings.rate.toFixed(1) }}×</strong>
        <span>{{ rateHint }} · 当前朗读速度</span>
      </div>
      <div class="rate-grid" role="radiogroup" aria-label="朗读速度">
        <button
          v-for="rate in RATES"
          :key="rate"
          type="button"
          class="rate-option"
          role="radio"
          :aria-checked="Math.abs(settings.rate - rate) < 0.02"
          :class="{ 'is-active': Math.abs(settings.rate - rate) < 0.02 }"
          @click="emit('patch', { rate })"
        >
          <strong>{{ rate.toFixed(1) }}×</strong>
          <small>{{ RATE_HINTS[rate.toFixed(1)] }}</small>
        </button>
      </div>
      <p class="tune__hint">
        语速在句子之间生效；离线音色与系统语音都会按此速度朗读。
      </p>
    </div>
  </Sheet>
</template>

<style scoped>
.tune {
  padding-top: 2px;
}

.tune__hint {
  margin: 16px 0 2px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--app-muted);
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.theme-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 6px;
  border: 1px solid var(--app-line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-fg) 2%, transparent);
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.theme-card.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 52%, transparent);
  background: color-mix(in srgb, var(--app-accent) 6%, transparent);
}

.theme-card__preview {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  height: 64px;
  padding: 9px 10px;
  border: 1px solid;
  border-radius: 9px;
}

.theme-card__mark {
  font-family: var(--font-serif);
  font-size: 21px;
  font-weight: 600;
  line-height: 1;
}

.theme-card__line {
  width: 70%;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
  opacity: 0.24;
}

.theme-card__line--short {
  width: 46%;
}

.theme-card__dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.theme-card__label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}

.theme-card.is-active .theme-card__label {
  color: var(--app-accent);
}

.font-preview {
  display: flex;
  align-items: center;
  min-height: 98px;
  padding: 16px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-fg) 4%, transparent);
  font-family: var(--font-serif);
  line-height: 1.75;
  letter-spacing: 0.02em;
}

.font-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.font-step {
  flex: none;
  width: 48px;
  height: 42px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: var(--app-bg);
  font-size: 13px;
  color: var(--app-fg);
}

.font-step:disabled {
  opacity: 0.32;
}

.font-step:active:not(:disabled) {
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.font-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--app-accent);
}

.font-presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 16px;
}

.font-preset {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 9px 4px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: var(--app-bg);
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.font-preset strong {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.font-preset small {
  font-size: 9.5px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}

.font-preset.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 52%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-bg));
  color: var(--app-accent);
}

.rate-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 0 2px;
}

.rate-stage strong {
  font-family: var(--font-serif);
  font-size: 42px;
  line-height: 1;
  letter-spacing: 0.02em;
  color: var(--app-accent);
  font-variant-numeric: tabular-nums;
}

.rate-stage span {
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--app-muted);
}

.rate-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-top: 16px;
}

.rate-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 11px 2px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: var(--app-bg);
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.rate-option strong {
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.rate-option small {
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}

.rate-option.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 52%, transparent);
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-bg));
  color: var(--app-accent);
}

.rate-option.is-active small {
  color: color-mix(in srgb, var(--app-accent) 76%, var(--app-muted));
}
</style>
