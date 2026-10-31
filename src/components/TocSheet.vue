<script setup lang="ts">
import { nextTick, watch } from 'vue'
import type { ChapterInfo } from '@/types'
import Sheet from './Sheet.vue'

const props = defineProps<{
  open: boolean
  chapters: ChapterInfo[]
  currentIndex: number
}>()

const emit = defineEmits<{
  close: []
  select: [index: number]
}>()

async function revealCurrent(): Promise<void> {
  await nextTick()
  await nextTick()
  const current = document.querySelector<HTMLElement>('.sheet .toc__item.is-current')
  current?.scrollIntoView({ block: 'center' })
}

watch(
  () => props.open,
  (open) => {
    if (open) void revealCurrent()
  },
)
</script>

<template>
  <Sheet
    :open="open"
    title="目录"
    :subtitle="chapters.length ? `共 ${chapters.length} 章` : undefined"
    @close="emit('close')"
  >
    <nav class="toc" aria-label="章节列表">
      <button
        v-for="chapter in chapters"
        :key="chapter.index"
        type="button"
        class="toc__item"
        :class="{ 'is-current': chapter.index === currentIndex }"
        @click="emit('select', chapter.index)"
      >
        <span class="toc__num">{{ String(chapter.index + 1).padStart(2, '0') }}</span>
        <span class="toc__label">{{ chapter.label }}</span>
        <span v-if="chapter.index === currentIndex" class="toc__badge">在读</span>
      </button>
      <p v-if="!chapters.length" class="toc__empty">这本书还没有可阅读的章节。</p>
    </nav>
  </Sheet>
</template>

<style scoped>
.toc {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
}

.toc__item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 10px;
  border-radius: 12px;
  text-align: left;
  color: var(--app-fg);
  transition: background-color 0.16s ease;
}

.toc__item:active {
  background: color-mix(in srgb, var(--app-fg) 6%, transparent);
}

.toc__item.is-current {
  background: color-mix(in srgb, var(--app-accent) 9%, transparent);
}

.toc__num {
  flex: none;
  width: 22px;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}

.toc__label {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  line-height: 1.55;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.toc__item.is-current .toc__label {
  color: var(--app-accent);
  font-weight: 600;
}

.toc__badge {
  flex: none;
  padding: 2px 7px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--app-accent);
}

.toc__empty {
  margin: 18px 0;
  text-align: center;
  font-size: 13px;
  color: var(--app-muted);
}
</style>
