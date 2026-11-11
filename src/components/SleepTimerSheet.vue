<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  formatRemaining,
  formatTargetDay,
  nextTimeOccurrence,
  type SleepTimerMode,
} from '@/ui/sleepTimer'
import AppIcon from './AppIcon.vue'
import Sheet from './Sheet.vue'

const props = defineProps<{
  open: boolean
  active: boolean
  endsAt: number | null
  remainingMs: number
  mode: SleepTimerMode | null
}>()

const emit = defineEmits<{
  close: []
  startCountdown: [minutes: number]
  startAtTime: [hour: number, minute: number]
  cancel: []
}>()

const QUICK_OPTIONS = [
  { minutes: 15, label: '15 分钟' },
  { minutes: 30, label: '30 分钟' },
  { minutes: 45, label: '45 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 90, label: '1.5 小时' },
]

const MODES: Array<{ value: SleepTimerMode; label: string }> = [
  { value: 'countdown', label: '倒计时' },
  { value: 'clock', label: '到点停止' },
]

const mode = ref<SleepTimerMode>('countdown')
const hours = ref(0)
const minutes = ref(30)
const timeValue = ref(defaultTimeValue())
const clockNow = ref(Date.now())
let clockTicker: number | null = null

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function defaultTimeValue(): string {
  const next = new Date(Date.now() + 60 * 60 * 1000)
  next.setMinutes(0, 0, 0)
  return `${pad(next.getHours())}:${pad(next.getMinutes())}`
}

function stopClockTicker(): void {
  if (clockTicker !== null) {
    window.clearInterval(clockTicker)
    clockTicker = null
  }
}

watch(
  () => props.open,
  (open) => {
    stopClockTicker()
    if (!open) return
    clockNow.value = Date.now()
    if (props.mode) mode.value = props.mode
    if (props.active && props.endsAt) {
      const target = new Date(props.endsAt)
      timeValue.value = `${pad(target.getHours())}:${pad(target.getMinutes())}`
    }
    clockTicker = window.setInterval(() => {
      clockNow.value = Date.now()
    }, 30_000)
  },
  { immediate: true },
)

onBeforeUnmount(stopClockTicker)

const parsedTime = computed(() => {
  const [hour, minute] = timeValue.value.split(':').map((part) => Number(part))
  if (Number.isInteger(hour) && Number.isInteger(minute)) {
    return { hour, minute }
  }
  return null
})

const clockTarget = computed(() => {
  const parsed = parsedTime.value
  if (!parsed) return null
  return nextTimeOccurrence(parsed.hour, parsed.minute, clockNow.value)
})

const clockTargetLabel = computed(() =>
  clockTarget.value
    ? formatTargetDay(clockTarget.value, clockNow.value)
    : '',
)

const customTotal = computed(() => hours.value * 60 + minutes.value)
const remainingLabel = computed(() => formatRemaining(props.remainingMs))
const targetDayLabel = computed(() =>
  props.endsAt ? formatTargetDay(props.endsAt) : '',
)

function clampInt(value: string, max: number): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return 0
  return Math.min(max, Math.max(0, parsed))
}

function onHoursInput(event: Event): void {
  hours.value = clampInt((event.target as HTMLInputElement).value, 23)
}

function onMinutesInput(event: Event): void {
  minutes.value = clampInt((event.target as HTMLInputElement).value, 59)
}

function onTimeInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  if (value) timeValue.value = value
}

function startClock(): void {
  const parsed = parsedTime.value
  if (!parsed) return
  emit('startAtTime', parsed.hour, parsed.minute)
}
</script>

<template>
  <Sheet
    :open="open"
    title="定时关闭"
    subtitle="到点自动暂停朗读"
    @close="emit('close')"
  >
    <section v-if="active && endsAt" class="sleep-status">
      <span class="sleep-status__icon" aria-hidden="true">
        <AppIcon name="clock" :size="19" />
      </span>
      <div class="sleep-status__copy">
        <strong>{{ targetDayLabel }} 暂停朗读</strong>
        <span>还剩 {{ remainingLabel }}</span>
      </div>
      <button
        type="button"
        class="sleep-status__cancel"
        @click="emit('cancel')"
      >
        取消
      </button>
    </section>

    <div class="sleep-modes" role="group" aria-label="定时方式">
      <button
        v-for="item in MODES"
        :key="item.value"
        type="button"
        class="sleep-mode"
        :class="{ 'is-active': mode === item.value }"
        :aria-pressed="mode === item.value"
        @click="mode = item.value"
      >
        {{ item.label }}
      </button>
    </div>

    <section v-if="mode === 'countdown'" class="sleep-pane">
      <div class="sleep-quick">
        <button
          v-for="item in QUICK_OPTIONS"
          :key="item.minutes"
          type="button"
          class="sleep-quick__btn"
          @click="emit('startCountdown', item.minutes)"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="sleep-custom">
        <label class="sleep-field">
          <input
            :value="hours"
            type="number"
            min="0"
            max="23"
            inputmode="numeric"
            aria-label="小时数"
            @input="onHoursInput"
          />
          <span>小时</span>
        </label>
        <label class="sleep-field">
          <input
            :value="minutes"
            type="number"
            min="0"
            max="59"
            inputmode="numeric"
            aria-label="分钟数"
            @input="onMinutesInput"
          />
          <span>分钟</span>
        </label>
        <button
          type="button"
          class="sleep-start"
          :disabled="customTotal <= 0"
          @click="emit('startCountdown', customTotal)"
        >
          开始
        </button>
      </div>

      <p class="sleep-note">
        点选上面的时长会立即开始倒计时，也可以自定义小时与分钟。
      </p>
    </section>

    <section v-else class="sleep-pane">
      <label class="sleep-clock">
        <span>停止时间</span>
        <input
          :value="timeValue"
          type="time"
          aria-label="停止时间"
          @input="onTimeInput"
        />
      </label>

      <p v-if="clockTargetLabel" class="sleep-target">
        将在 {{ clockTargetLabel }} 暂停朗读
      </p>
      <p v-else class="sleep-note">请选择一个有效的时间。</p>

      <button
        type="button"
        class="sleep-start sleep-start--wide"
        :disabled="!clockTargetLabel"
        @click="startClock"
      >
        设定到点停止
      </button>
      <p class="sleep-note">
        若所选时间已经过去，会按明天的这个时间计算。
      </p>
    </section>

    <p class="sleep-foot">
      定时只在当前阅读页生效；返回书架或刷新页面后会取消。到点仅暂停朗读，不会退出阅读页。
    </p>
  </Sheet>
</template>

<style scoped>
.sleep-status {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 32%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-bg));
}

.sleep-status__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-accent);
}

.sleep-status__copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sleep-status__copy strong {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.sleep-status__copy span {
  font-size: 11px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}

.sleep-status__cancel {
  flex: none;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  background: var(--app-bg);
  font-size: 11.5px;
  color: var(--app-muted);
}

.sleep-status__cancel:active {
  color: var(--app-accent);
  border-color: color-mix(in srgb, var(--app-accent) 40%, transparent);
}

.sleep-modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-top: 18px;
  padding: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 6%, transparent);
}

.sleep-mode {
  height: 36px;
  border-radius: 999px;
  font-size: 12.5px;
  letter-spacing: 0.03em;
  color: var(--app-muted);
  transition: background-color 0.16s ease, color 0.16s ease;
}

.sleep-mode.is-active {
  background: var(--app-bg);
  color: var(--app-fg);
  box-shadow: 0 2px 8px rgba(30, 22, 14, 0.08);
}

.sleep-pane {
  margin-top: 18px;
}

.sleep-quick {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.sleep-quick__btn {
  height: 44px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 12px;
  background: var(--app-bg);
  font-size: 12.5px;
  letter-spacing: 0.02em;
  color: var(--app-fg);
}

.sleep-quick__btn:active {
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.sleep-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.sleep-field {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 12px;
  background: var(--app-bg);
  font-size: 11.5px;
  color: var(--app-muted);
  white-space: nowrap;
}

.sleep-field input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  font-size: 14px;
  color: var(--app-fg);
  font-variant-numeric: tabular-nums;
  outline: none;
  appearance: textfield;
  -moz-appearance: textfield;
}

.sleep-field input::-webkit-outer-spin-button,
.sleep-field input::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.sleep-start {
  flex: none;
  height: 44px;
  padding: 0 18px;
  border-radius: 12px;
  background: var(--app-accent);
  color: var(--app-bg);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.sleep-start:disabled {
  opacity: 0.4;
}

.sleep-start--wide {
  width: 100%;
  margin-top: 14px;
}

.sleep-clock {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 13px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 12px;
  background: var(--app-bg);
  font-size: 12.5px;
  color: var(--app-fg);
}

.sleep-clock input {
  flex: none;
  border: 0;
  background: transparent;
  font-size: 20px;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--app-accent);
  outline: none;
}

.sleep-target {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-muted);
}

.sleep-note {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--app-muted);
}

.sleep-foot {
  margin: 20px 0 0;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
  font-size: 10.5px;
  line-height: 1.7;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
</style>
