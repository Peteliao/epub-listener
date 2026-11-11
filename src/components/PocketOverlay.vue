<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  bookTitle: string
  chapterLabel: string
  isPlaying: boolean
  sleepLabel: string
}>()

const emit = defineEmits<{
  close: []
  toggle: []
  sleep: []
}>()

const HOLD_MS = 1500
const root = ref<HTMLElement | null>(null)
const holding = ref(false)
const holdProgress = ref(0)
const hintVisible = ref(false)
const hintText = ref('')

let holdTimer: number | null = null
let hintTimer: number | null = null
let tapTimer: number | null = null
let animationFrame = 0
let holdStartedAt = 0
let pointerOrigin: { x: number; y: number; time: number } | null = null
let moved = false
let holdCompleted = false
let lastTapAt = 0

function flash(text: string, duration = 2800): void {
  hintText.value = text
  hintVisible.value = true
  if (hintTimer !== null) window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    hintVisible.value = false
    hintTimer = null
  }, duration)
}

function hideHint(): void {
  hintVisible.value = false
  if (hintTimer !== null) {
    window.clearTimeout(hintTimer)
    hintTimer = null
  }
}

function clearTapTimer(): void {
  if (tapTimer !== null) {
    window.clearTimeout(tapTimer)
    tapTimer = null
  }
}

function stopHoldAnimation(): void {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = 0
  }
}

function abortHold(): void {
  holding.value = false
  holdProgress.value = 0
  if (holdTimer !== null) {
    window.clearTimeout(holdTimer)
    holdTimer = null
  }
  stopHoldAnimation()
}

function completeHold(): void {
  holdCompleted = true
  holding.value = false
  holdProgress.value = 1
  stopHoldAnimation()
  emit('close')
}

function tickHold(now: number): void {
  if (!holding.value) return
  const elapsed = Math.min(HOLD_MS, now - holdStartedAt)
  holdProgress.value = elapsed / HOLD_MS
  if (elapsed < HOLD_MS) animationFrame = requestAnimationFrame(tickHold)
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  clearTapTimer()
  hideHint()

  pointerOrigin = { x: event.clientX, y: event.clientY, time: performance.now() }
  moved = false
  holdCompleted = false
  holding.value = true
  holdProgress.value = 0
  holdStartedAt = performance.now()
  holdTimer = window.setTimeout(completeHold, HOLD_MS)
  animationFrame = requestAnimationFrame(tickHold)

  const target = event.currentTarget as HTMLElement
  try {
    target.setPointerCapture(event.pointerId)
  } catch {
    // Pointer capture is best-effort on older webviews.
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!pointerOrigin) return
  if (Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) > 12) {
    moved = true
    abortHold()
  }
}

function onPointerUp(): void {
  const origin = pointerOrigin
  const wasMoved = moved
  pointerOrigin = null
  abortHold()

  if (holdCompleted) {
    holdCompleted = false
    return
  }
  if (!origin || wasMoved) return

  const now = performance.now()
  if (now - lastTapAt < 320) {
    clearTapTimer()
    lastTapAt = 0
    emit('toggle')
    flash(props.isPlaying ? '已暂停' : '继续播放', 1400)
    return
  }

  lastTapAt = now
  clearTapTimer()
  tapTimer = window.setTimeout(() => {
    flash('双击暂停或继续 · 长按 1.5 秒退出')
  }, 280)
}

function onPointerCancel(): void {
  pointerOrigin = null
  abortHold()
}

onMounted(() => {
  root.value?.focus({ preventScroll: true })
  flash('双击暂停或继续 · 长按 1.5 秒退出', 3200)
})

onBeforeUnmount(() => {
  abortHold()
  clearTapTimer()
  if (hintTimer !== null) {
    window.clearTimeout(hintTimer)
    hintTimer = null
  }
})
</script>

<template>
  <div
    ref="root"
    class="pocket"
    role="dialog"
    aria-modal="true"
    aria-label="口袋模式"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu.prevent
    @keydown.escape="emit('close')"
  >
    <p class="pocket__book">{{ bookTitle }}</p>

    <button
      type="button"
      class="pocket__sleep"
      :class="{ 'is-active': Boolean(sleepLabel) }"
      :aria-label="sleepLabel ? `定时关闭，${sleepLabel}` : '设置定时关闭'"
      @pointerdown.stop
      @pointerup.stop
      @click.stop="emit('sleep')"
    >
      <AppIcon name="clock" :size="14" />
      <span>{{ sleepLabel || '定时' }}</span>
    </button>

    <div class="pocket__center">
      <AppIcon name="moon" :size="26" />
      <p class="pocket__chapter">{{ chapterLabel || '正在听书' }}</p>
      <p class="pocket__state">{{ isPlaying ? '正在朗读' : '已暂停' }}</p>
    </div>

    <Transition name="fade">
      <p v-if="hintVisible" class="pocket__hint">{{ hintText }}</p>
    </Transition>

    <div class="pocket__hold" :class="{ 'is-holding': holding }">
      <div class="pocket__hold-track">
        <span class="pocket__hold-fill" :style="{ transform: `scaleX(${holdProgress})` }"></span>
      </div>
      <span>{{ holding ? '继续按住以退出' : '长按 1.5 秒退出' }}</span>
    </div>

    <button
      type="button"
      class="pocket__a11y"
      @pointerdown.stop
      @click.stop="emit('close')"
    >
      退出口袋模式
    </button>
  </div>
</template>

<style scoped>
.pocket {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #000;
  color: #d9cfbf;
  touch-action: none;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}

.pocket__book {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 28px);
  left: 0;
  right: 0;
  margin: 0;
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.28em;
  color: #4f4a42;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 0 84px;
}

.pocket__sleep {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 18px);
  right: 16px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid #211e19;
  border-radius: 999px;
  background: rgba(18, 16, 13, 0.72);
  color: #6c6255;
  font-size: 10px;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
}

.pocket__sleep.is-active {
  border-color: #3b3125;
  color: #b08a56;
}

.pocket__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: -6vh;
  padding: 0 36px;
  text-align: center;
  opacity: 0.62;
}

.pocket__center svg {
  color: #776c5b;
  opacity: 0.7;
}

.pocket__chapter {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  letter-spacing: 0.1em;
  line-height: 1.6;
  color: #bdb1a0;
  max-width: 24em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.pocket__state {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.3em;
  color: #6c6255;
}

.pocket__hint {
  position: absolute;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 94px);
  transform: translateX(-50%);
  margin: 0;
  padding: 8px 15px;
  border: 1px solid #211e19;
  border-radius: 999px;
  background: rgba(22, 20, 17, 0.86);
  color: #918676;
  font-size: 11px;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.pocket__hold {
  position: absolute;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 38px);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  width: 172px;
  color: #4c463e;
  font-size: 10px;
  letter-spacing: 0.14em;
  transition: color 0.2s ease;
}

.pocket__hold.is-holding {
  color: #a0855f;
}

.pocket__hold-track {
  width: 100%;
  height: 2px;
  border-radius: 2px;
  background: #211e19;
  overflow: hidden;
}

.pocket__hold-fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: #b08a56;
  transform-origin: left center;
}

.pocket__a11y {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.pocket__a11y:focus-visible {
  top: calc(env(safe-area-inset-top, 0px) + 18px);
  left: 50%;
  width: auto;
  height: auto;
  padding: 9px 16px;
  border-radius: 999px;
  background: #1c1915;
  color: #d9cfbf;
  font-size: 12px;
  clip-path: none;
  transform: translateX(-50%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
