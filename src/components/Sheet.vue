<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  open: boolean
  title: string
  subtitle?: string
}>()

const emit = defineEmits<{ close: [] }>()

const closeButton = ref<HTMLButtonElement | null>(null)
let lastActive: HTMLElement | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      lastActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      closeButton.value?.focus({ preventScroll: true })
    } else {
      document.removeEventListener('keydown', onKeydown)
      lastActive?.focus({ preventScroll: true })
      lastActive = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet">
        <div class="sheet__backdrop" @click="emit('close')"></div>
        <section class="sheet__panel" role="dialog" aria-modal="true" :aria-label="title">
          <div class="sheet__handle" aria-hidden="true"></div>
          <header class="sheet__head">
            <div class="sheet__heading">
              <h2>{{ title }}</h2>
              <p v-if="subtitle">{{ subtitle }}</p>
            </div>
            <button
              ref="closeButton"
              type="button"
              class="sheet__close"
              aria-label="关闭"
              @click="emit('close')"
            >
              <AppIcon name="close" :size="18" />
            </button>
          </header>
          <div class="sheet__body">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.sheet__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(18, 14, 10, 0.42);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.sheet__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 78vh;
  max-height: min(78dvh, 720px);
  border-radius: 26px 26px 0 0;
  background: var(--app-ui);
  color: var(--app-fg);
  box-shadow: 0 -16px 50px rgba(25, 18, 12, 0.24);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.sheet__handle {
  flex: none;
  width: 38px;
  height: 4px;
  margin: 9px auto 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 18%, transparent);
}

.sheet__head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 22px 12px;
}

.sheet__heading h2 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.sheet__heading p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--app-muted);
}

.sheet__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-top: 1px;
  border-radius: 50%;
  color: var(--app-muted);
}

.sheet__close:active {
  background: color-mix(in srgb, var(--app-fg) 8%, transparent);
}

.sheet__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* Leaves clearance so the last row can scroll above iOS Safari's floating
     toolbar and the home indicator. */
  padding: 4px 22px calc(52px + env(safe-area-inset-bottom, 0px));
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.24s ease;
}

.sheet-enter-active .sheet__panel,
.sheet-leave-active .sheet__panel {
  transition: transform 0.26s cubic-bezier(0.32, 0.72, 0, 1);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .sheet__panel,
.sheet-leave-to .sheet__panel {
  transform: translateY(100%);
}

@media (min-width: 640px) {
  .sheet {
    align-items: center;
    padding: 24px;
  }

  .sheet__panel {
    width: 540px;
    max-height: 82vh;
    max-height: min(82dvh, 760px);
    border-radius: 24px;
  }

  .sheet-enter-from .sheet__panel,
  .sheet-leave-to .sheet__panel {
    transform: translateY(16px) scale(0.98);
  }

  .sheet__handle {
    display: none;
  }

  .sheet__head {
    padding-top: 22px;
  }
}
</style>
