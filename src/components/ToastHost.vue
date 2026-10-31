<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import { dismissToast, toasts } from '@/ui/toast'
</script>

<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="item in toasts"
          :key="item.id"
          class="toast"
          :class="`toast--${item.tone}`"
          role="status"
        >
          <span class="toast__dot" aria-hidden="true"></span>
          <p class="toast__text">{{ item.message }}</p>
          <button
            type="button"
            class="toast__close"
            aria-label="关闭提示"
            @click="dismissToast(item.id)"
          >
            <AppIcon name="close" :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 14px);
  left: 50%;
  z-index: 120;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: min(calc(100% - 28px), 430px);
  transform: translateX(-50%);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  max-width: 100%;
  padding: 11px 12px 11px 14px;
  border-radius: 14px;
  background: rgba(35, 30, 24, 0.94);
  color: #f6efe2;
  box-shadow: 0 10px 30px rgba(20, 15, 10, 0.28);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  pointer-events: auto;
}

.toast--error {
  background: rgba(83, 35, 24, 0.96);
}

.toast__dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 7px;
  border-radius: 50%;
  background: #d9a15e;
}

.toast--error .toast__dot {
  background: #f0a58c;
}

.toast__text {
  flex: 1;
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
}

.toast__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -2px -2px 0 0;
  border-radius: 50%;
  color: rgba(246, 239, 226, 0.6);
}

.toast__close:active {
  background: rgba(255, 255, 255, 0.12);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.toast-move {
  transition: transform 0.22s ease;
}
</style>
