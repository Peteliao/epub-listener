<script setup lang="ts">
type IconName =
  | 'back'
  | 'forward'
  | 'list'
  | 'settings'
  | 'play'
  | 'pause'
  | 'skip-back'
  | 'skip-forward'
  | 'moon'
  | 'trash'
  | 'plus'
  | 'close'
  | 'book'
  | 'arrow'
  | 'check'
  | 'volume'
  | 'spark'
  | 'download'
  | 'clock'
  | 'theme'

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 20 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'back'">
      <path d="M15 18l-6-6 6-6" />
    </template>
    <template v-else-if="name === 'forward'">
      <path d="M9 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'list'">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke-width="2.6" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2.2" />
      <circle cx="15" cy="17" r="2.2" />
    </template>
    <template v-else-if="name === 'play'">
      <path d="M8.2 5.4v13.2L19 12z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'pause'">
      <rect x="6.8" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'skip-back'">
      <path d="M5.5 5v14" />
      <path d="M18.5 5.6 8.8 12l9.7 6.4z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'skip-forward'">
      <path d="M18.5 5v14" />
      <path d="M5.5 5.6 15.2 12l-9.7 6.4z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20.4 13.3A8.4 8.4 0 1 1 10.7 3.6a6.7 6.7 0 0 0 9.7 9.7z" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M9 7V4.8h6V7M6.8 7l1 13h8.4l1-13" />
      <path d="M10 11v5M14 11v5" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="M6 6l12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'book'">
      <path d="M4 19.2A2.2 2.2 0 0 1 6.2 17H20" />
      <path d="M6.2 3H20v18H6.2A2.2 2.2 0 0 1 4 18.8V5.2A2.2 2.2 0 0 1 6.2 3z" />
    </template>
    <template v-else-if="name === 'arrow'">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m5 12.5 4.4 4.4L19 7.2" />
    </template>
    <template v-else-if="name === 'volume'">
      <path d="M11 5 6.6 9H3v6h3.6L11 19z" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.6a7.6 7.6 0 0 1 0 10.8" />
    </template>
    <template v-else-if="name === 'spark'">
      <path
        d="M11 3.6 12.7 9l5.4 1.7-5.4 1.7L11 17.9l-1.7-5.5L3.9 10.7 9.3 9z"
        fill="currentColor"
        stroke="none"
      />
      <path
        d="m18.4 14.8.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z"
        fill="currentColor"
        stroke="none"
      />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 4v10M8 10.5l4 4 4-4" />
      <path d="M5 18.5h14" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4V12l3.1 1.9" />
    </template>
    <template v-else-if="name === 'theme'">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 3.8a8.2 8.2 0 0 1 0 16.4Z" fill="currentColor" stroke="none" />
    </template>
  </svg>
</template>
