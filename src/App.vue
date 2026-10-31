<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import LibraryView from '@/views/LibraryView.vue'
import ReaderView from '@/views/ReaderView.vue'
import AppIcon from '@/components/AppIcon.vue'
import ToastHost from '@/components/ToastHost.vue'
import { useSettingsStore } from '@/stores/settings'
import { parseRoute, type Route } from '@/ui/nav'
import {
  applyUpdate,
  dismissUpdate,
  setupPwa,
  updateReady,
} from '@/ui/pwa'
import { READER_PALETTES } from '@/types'

const settingsStore = useSettingsStore()
const route = ref<Route>(parseRoute(window.location.hash))

function syncRoute(): void {
  route.value = parseRoute(window.location.hash)
}

watchEffect(() => {
  const palette = READER_PALETTES[settingsStore.settings.theme]
  const root = document.documentElement
  root.style.setProperty('--app-bg', palette.bg)
  root.style.setProperty('--app-fg', palette.fg)
  root.style.setProperty('--app-muted', palette.muted)
  root.style.setProperty('--app-accent', palette.accent)
  root.style.setProperty('--app-ui', palette.uiBg)
  root.style.setProperty('--app-highlight', palette.highlight)
  root.style.colorScheme = palette.dark ? 'dark' : 'light'
  root.dataset.theme = settingsStore.settings.theme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', palette.bg)
})

onMounted(() => {
  window.addEventListener('hashchange', syncRoute)
  if (!window.location.hash) {
    window.history.replaceState(null, '', '#/')
  }
  setupPwa()
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', syncRoute)
})
</script>

<template>
  <div class="app-shell">
    <!-- iOS 27 blurs whatever is rendered at the top edge of installed PWAs;
         an opaque surface there makes the system blur invisible. -->
    <div class="status-surface" aria-hidden="true"></div>
    <ReaderView v-if="route.name === 'reader'" :key="route.bookId" :book-id="route.bookId" />
    <LibraryView v-else />
    <ToastHost />

    <Transition name="update">
      <div v-if="updateReady" class="update-banner" role="status">
        <span class="update-banner__copy">新版本已准备好</span>
        <button type="button" class="update-banner__action" @click="applyUpdate">
          重启更新
        </button>
        <button
          type="button"
          class="update-banner__close"
          aria-label="稍后更新"
          @click="dismissUpdate"
        >
          <AppIcon name="close" :size="14" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  min-height: 0;
}

.status-surface {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: 4;
  height: calc(env(safe-area-inset-top, 0px) + 1px);
  background: var(--app-bg);
  pointer-events: none;
}

/* iOS standalone paints a progressive blur over the top edge. The surface
   must stay painted past the safe area or the system blur reappears. */
@media (display-mode: standalone) {
  @supports (-webkit-touch-callout: none) {
    .status-surface {
      height: calc(env(safe-area-inset-top, 0px) + 12px);
    }
  }
}

.update-banner {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  left: 50%;
  z-index: 95;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100vw - 28px);
  padding: 8px 9px 8px 15px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 999px;
  background: var(--app-ui);
  color: var(--app-fg);
  box-shadow: 0 10px 30px rgba(30, 22, 14, 0.18);
  transform: translateX(-50%);
}

.update-banner__copy {
  font-size: 12px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.update-banner__action {
  flex: none;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--app-accent);
  color: var(--app-bg);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

.update-banner__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--app-muted);
}

.update-banner__close:active {
  background: color-mix(in srgb, var(--app-fg) 7%, transparent);
}

.update-enter-active,
.update-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.update-enter-from,
.update-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
</style>
