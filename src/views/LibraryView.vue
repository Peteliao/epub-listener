<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BookSummary, StoredProgress } from '@/types'
import { BOOK_FORMAT_LABELS, getBookFormat } from '@/types'
import {
  getBook,
  getBookCover,
  getProgress,
  listBooks,
  removeBook,
  saveBookCover,
  touchBook,
} from '@/core/db/LibraryDB'
import { extractBookCover } from '@/core/library/bookCover'
import { importBookFile, importSampleBook } from '@/core/library/importBook'
import { IMPORT_ACCEPT } from '@/core/reader/formats/bookFormat'
import AppIcon from '@/components/AppIcon.vue'
import { showToast } from '@/ui/toast'
import { navigateToReader } from '@/ui/nav'
import { appBuildId, installAvailable, isStandalone, promptInstall } from '@/ui/pwa'

const INSTALL_HINT_KEY = 'shusheng.installHintDismissed.v1'

const books = ref<BookSummary[]>([])
const progressMap = ref<Record<string, StoredProgress>>({})
const coverUrls = ref<Record<string, string>>({})
const loading = ref(true)
const busy = ref<'file' | 'sample' | null>(null)
const pendingDelete = ref<string | null>(null)
const deleting = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
let backfillRunning = false
let disposed = false

const installHintDismissed = ref(readInstallHintDismissed())
const isIos =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isWeChat = /micromessenger/i.test(navigator.userAgent)

const isBusy = computed(() => busy.value !== null)

const buildLabel = computed(() => {
  if (!import.meta.env.PROD) return '开发模式'
  return appBuildId.value ? `构建 ${appBuildId.value}` : '构建未知'
})

const installHint = computed(() => {
  if (isStandalone.value || installHintDismissed.value) return null
  if (installAvailable.value) {
    return {
      title: '把书声装到桌面',
      body: '离线打开、全屏阅读，书籍和音色包都留在本机。',
      canPrompt: true,
    }
  }
  if (isWeChat) {
    return {
      title: '添加到主屏幕',
      body: '微信内暂不支持安装。点右上角「…」选择在浏览器打开，再添加到主屏幕。',
      canPrompt: false,
    }
  }
  if (isIos) {
    return {
      title: '添加到主屏幕',
      body: '在 Safari 中点按分享按钮，选择「添加到主屏幕」，之后可以离线打开书声。',
      canPrompt: false,
    }
  }
  return null
})

function readInstallHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_HINT_KEY) === '1'
  } catch {
    return false
  }
}

function dismissInstallHint(): void {
  installHintDismissed.value = true
  try {
    window.localStorage.setItem(INSTALL_HINT_KEY, '1')
  } catch {
    // The hint stays hidden for this session.
  }
}

async function installApp(): Promise<void> {
  if (!installAvailable.value) return
  const accepted = await promptInstall()
  if (accepted) showToast('正在把书声安装到桌面…')
}

const COVER_THEMES = [
  { background: 'linear-gradient(145deg, #eadcc4, #cab08a)', color: '#584329' },
  { background: 'linear-gradient(145deg, #dbe2d0, #b1c0a1)', color: '#3e4c33' },
  { background: 'linear-gradient(145deg, #ecd6ca, #d0a892)', color: '#5c392a' },
  { background: 'linear-gradient(145deg, #d6dfe4, #a8bac5)', color: '#2e4553' },
  { background: 'linear-gradient(145deg, #e5ddcc, #c3b79a)', color: '#4c4230' },
]

function coverTheme(book: BookSummary): { background: string; color: string } {
  let hash = 0
  for (const char of book.id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }
  return COVER_THEMES[hash % COVER_THEMES.length]!
}

function coverInitial(title: string): string {
  const first = Array.from(title.trim())[0] ?? '书'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

function setCoverUrl(bookId: string, cover: Blob): void {
  if (disposed) return
  const previous = coverUrls.value[bookId]
  if (previous) URL.revokeObjectURL(previous)
  coverUrls.value[bookId] = URL.createObjectURL(cover)
}

function clearCoverUrl(bookId: string): void {
  const url = coverUrls.value[bookId]
  if (!url) return
  URL.revokeObjectURL(url)
  delete coverUrls.value[bookId]
}

async function loadCovers(summaries: BookSummary[]): Promise<void> {
  if (disposed) return
  const ids = new Set(summaries.map((book) => book.id))
  for (const id of Object.keys(coverUrls.value)) {
    if (!ids.has(id)) clearCoverUrl(id)
  }
  await Promise.all(
    summaries.map(async (book) => {
      if (coverUrls.value[book.id]) return
      try {
        const cover = await getBookCover(book.id)
        if (cover) setCoverUrl(book.id, cover)
      } catch {
        // A missing cover must not block the rest of the shelf.
      }
    }),
  )
}

async function backfillCovers(): Promise<void> {
  if (backfillRunning || disposed) return
  backfillRunning = true
  try {
    for (const book of books.value) {
      if (disposed) return
      if (coverUrls.value[book.id]) continue
      try {
        const known = await getBookCover(book.id)
        if (known !== undefined) continue
        if (getBookFormat(book) === 'txt') {
          await saveBookCover(book.id, null)
          continue
        }
        const stored = await getBook(book.id)
        if (!stored) continue
        const cover = await extractBookCover(getBookFormat(stored), stored.file)
        if (disposed || !books.value.some((item) => item.id === book.id)) continue
        if (cover) setCoverUrl(book.id, cover)
        await saveBookCover(book.id, cover)
      } catch {
        // Keep scanning the shelf even if one book has a broken cover.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 60))
    }
  } finally {
    backfillRunning = false
  }
}

function percentOf(bookId: string): number {
  return Math.round((progressMap.value[bookId]?.percent ?? 0) * 100)
}

async function refresh(): Promise<void> {
  const summaries = await listBooks()
  books.value = summaries
  await loadCovers(summaries)

  const entries = await Promise.all(
    summaries.map(async (book) => [book.id, await getProgress(book.id)] as const),
  )
  const map: Record<string, StoredProgress> = {}
  for (const [id, progress] of entries) {
    if (progress) map[id] = progress
  }
  progressMap.value = map

  window.setTimeout(() => {
    void backfillCovers()
  }, 700)
}

function pickFile(): void {
  if (isBusy.value) return
  fileInput.value?.click()
}

async function handleFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || isBusy.value) return

  busy.value = 'file'
  try {
    const result = await importBookFile(file)
    await refresh()
    showToast(
      result.reused
        ? `《${result.book.title}》已经在书架里了。`
        : `《${result.book.title}》已加入书架。`,
    )
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导入失败，请重试。', 'error')
  } finally {
    busy.value = null
  }
}

async function openSample(): Promise<void> {
  if (isBusy.value) return
  busy.value = 'sample'
  try {
    const result = await importSampleBook()
    await touchBook(result.book.id)
    showToast(
      result.updated
        ? '样书已更新，准备朗读。'
        : result.reused
          ? '继续上次的样书之旅。'
          : '样书已加入书架，准备朗读。',
    )
    navigateToReader(result.book.id)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '样书暂时打不开，请稍后重试。', 'error')
  } finally {
    busy.value = null
  }
}

function openBook(book: BookSummary): void {
  pendingDelete.value = null
  void touchBook(book.id)
  navigateToReader(book.id)
}

function askDelete(book: BookSummary): void {
  pendingDelete.value = pendingDelete.value === book.id ? null : book.id
}

async function confirmDelete(book: BookSummary): Promise<void> {
  if (deleting.value) return
  deleting.value = book.id
  try {
    await removeBook(book.id)
    pendingDelete.value = null
    await refresh()
    showToast(`已从书架移除《${book.title}》。`)
  } catch {
    showToast('删除失败，请稍后重试。', 'error')
  } finally {
    deleting.value = null
  }
}

onMounted(async () => {
  try {
    await refresh()
  } catch {
    showToast('书架加载失败，请刷新页面重试。', 'error')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  disposed = true
  for (const url of Object.values(coverUrls.value)) URL.revokeObjectURL(url)
  coverUrls.value = {}
})
</script>

<template>
  <div class="library">
    <div class="library__inner">
      <header class="brand">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="27" height="27">
            <g
              transform="translate(32 32) scale(1.32) translate(-32 -32)"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linejoin="round"
            >
              <path
                d="M16 19c5.5-2.4 10.5-1.2 16 2.2 5.5-3.4 10.5-4.6 16-2.2v27c-5.5-2.4-10.5-1.2-16 2.2-5.5-3.4-10.5-4.6-16-2.2V19z"
              />
              <path d="M32 21.2v27" stroke-width="2" opacity=".55" />
              <path
                d="M22 30c2.4-1 4.8-.5 7 1M22 36.5c2.4-1 4.8-.5 7 1M39.5 30c2.2-1 4.6-.5 7 1"
                stroke-width="2"
                stroke-linecap="round"
                opacity=".8"
              />
            </g>
          </svg>
        </span>
        <span class="brand__name">
          <strong>书声</strong>
          <small>SHUSHENG</small>
        </span>
        <span class="brand__tag">纯网页听书</span>
      </header>

      <aside v-if="installHint" class="install-hint">
        <span class="install-hint__icon"><AppIcon name="download" :size="18" /></span>
        <div class="install-hint__copy">
          <strong>{{ installHint.title }}</strong>
          <p>{{ installHint.body }}</p>
        </div>
        <div class="install-hint__actions">
          <button
            v-if="installHint.canPrompt"
            type="button"
            class="install-hint__btn"
            @click="installApp"
          >
            安装
          </button>
          <button
            type="button"
            class="install-hint__close"
            aria-label="不再提示安装"
            @click="dismissInstallHint"
          >
            <AppIcon name="close" :size="13" />
          </button>
        </div>
      </aside>

      <section class="hero">
        <p class="hero__eyebrow">EPUB · FB2 · MOBI · AZW3 · TXT</p>
        <h1>让文字，<br /><em>读给你听。</em></h1>
        <p class="hero__desc">
          导入一本电子书，逐句朗读、同步高亮。书留在本机，阅读进度也只属于你。
        </p>
        <div class="hero__actions">
          <button
            type="button"
            class="btn btn--primary"
            :disabled="isBusy"
            @click="pickFile"
          >
            <span v-if="busy === 'file'" class="btn__spinner" aria-hidden="true"></span>
            <AppIcon v-else name="plus" :size="18" />
            {{ busy === 'file' ? '正在导入…' : '导入电子书' }}
          </button>
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="isBusy"
            @click="openSample"
          >
            {{ busy === 'sample' ? '正在打开…' : '试听样书' }}
            <AppIcon v-if="busy !== 'sample'" name="arrow" :size="17" />
          </button>
        </div>
        <p class="hero__features">
          <span><AppIcon name="check" :size="13" />系统语音</span>
          <span><AppIcon name="check" :size="13" />逐句高亮</span>
          <span><AppIcon name="check" :size="13" />本机存储</span>
        </p>
      </section>

      <section class="shelf" aria-labelledby="shelf-title">
        <header class="shelf__head">
          <h2 id="shelf-title">书架</h2>
          <span>{{ loading ? '正在整理' : `${books.length} 本` }}</span>
        </header>

        <ul v-if="loading" class="skeleton-list" aria-hidden="true">
          <li v-for="index in 3" :key="index" class="skeleton">
            <span class="skeleton__cover"></span>
            <span class="skeleton__lines">
              <i></i>
              <i></i>
              <i></i>
            </span>
          </li>
        </ul>

        <div v-else-if="!books.length" class="empty">
          <span class="empty__icon"><AppIcon name="book" :size="25" /></span>
          <h3>书架还是空的</h3>
          <p>导入一本 EPUB、FB2、MOBI、AZW3 或 TXT，或先听听样书《山间来信》。</p>
          <button type="button" class="empty__action" @click="openSample">
            打开样书
            <AppIcon name="arrow" :size="15" />
          </button>
        </div>

        <ul v-else class="book-list">
          <li v-for="book in books" :key="book.id" class="book-card">
            <button type="button" class="book-card__main" @click="openBook(book)">
              <span
                class="book-card__cover"
                :class="{ 'book-card__cover--image': coverUrls[book.id] }"
                :style="coverTheme(book)"
                aria-hidden="true"
              >
                <img
                  v-if="coverUrls[book.id]"
                  :src="coverUrls[book.id]"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  @error="clearCoverUrl(book.id)"
                />
                <span v-else>{{ coverInitial(book.title) }}</span>
              </span>
              <span class="book-card__meta">
                <span class="book-card__title">{{ book.title }}</span>
                <span class="book-card__author">
                  {{ book.author || '未知作者' }} · {{ book.chapterCount }} 章
                  <em v-if="book.source === 'sample'" class="book-card__badge">样书</em>
                  <em
                    v-else-if="getBookFormat(book) !== 'epub'"
                    class="book-card__badge"
                  >
                    {{ BOOK_FORMAT_LABELS[getBookFormat(book)] }}
                  </em>
                </span>
                <span v-if="progressMap[book.id]" class="book-card__progress">
                  <span class="book-card__bar">
                    <i :style="{ width: `${percentOf(book.id)}%` }"></i>
                  </span>
                  <span class="book-card__pct">{{ percentOf(book.id) }}%</span>
                </span>
                <span v-else class="book-card__new">
                  {{ loading ? '' : '尚未开始' }}
                </span>
              </span>
            </button>
            <button
              type="button"
              class="book-card__delete"
              :aria-label="`删除《${book.title}》`"
              @click="askDelete(book)"
            >
              <AppIcon name="trash" :size="17" />
            </button>
            <div v-if="pendingDelete === book.id" class="book-card__confirm">
              <span>删除这本书？进度也会一并清除。</span>
              <span class="book-card__confirm-actions">
                <button
                  type="button"
                  class="confirm-btn"
                  :disabled="deleting === book.id"
                  @click="pendingDelete = null"
                >
                  取消
                </button>
                <button
                  type="button"
                  class="confirm-btn confirm-btn--danger"
                  :disabled="deleting === book.id"
                  @click="confirmDelete(book)"
                >
                  {{ deleting === book.id ? '删除中…' : '删除' }}
                </button>
              </span>
            </div>
          </li>
        </ul>
      </section>

      <footer class="library__foot">
        系统语音或离线 AI 音色 · 书籍与进度仅保存在本机 · {{ buildLabel }}
      </footer>
    </div>

    <input
      ref="fileInput"
      class="file-input"
      type="file"
      :accept="IMPORT_ACCEPT"
      tabindex="-1"
      aria-hidden="true"
      @change="handleFile"
    />
  </div>
</template>

<style scoped>
.library {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background:
    radial-gradient(120% 55% at 100% 0%, color-mix(in srgb, var(--app-accent) 7%, transparent), transparent 60%),
    var(--app-bg);
  color: var(--app-fg);
}

.library__inner {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  padding: calc(env(safe-area-inset-top, 0px) + 20px) 22px
    calc(env(safe-area-inset-bottom, 0px) + 30px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
}

.brand__mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  background: var(--app-accent);
  color: var(--app-bg);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.18),
    0 7px 18px color-mix(in srgb, var(--app-accent) 24%, transparent);
}

.brand__name {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.brand__name strong {
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.16em;
  line-height: 1;
}

.brand__name small {
  font-size: 7.5px;
  letter-spacing: 0.32em;
  color: var(--app-muted);
}

.brand__tag {
  margin-left: auto;
  padding: 5px 10px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--app-muted);
}

.install-hint {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin-top: 20px;
  padding: 12px 12px 12px 13px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 16%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-accent) 5%, transparent);
}

.install-hint__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  color: var(--app-accent);
}

.install-hint__copy {
  flex: 1;
  min-width: 0;
  padding-top: 1px;
}

.install-hint__copy strong {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.install-hint__copy p {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted);
}

.install-hint__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

.install-hint__btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--app-accent);
  color: var(--app-bg);
  font-size: 11.5px;
  font-weight: 600;
}

.install-hint__close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--app-muted);
}

.install-hint__close:active {
  background: color-mix(in srgb, var(--app-fg) 7%, transparent);
}

.hero {
  position: relative;
  margin-top: 46px;
  z-index: 0;
}

.hero::before {
  content: '';
  position: absolute;
  top: -72px;
  right: -70px;
  width: 240px;
  height: 240px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--app-accent) 11%, transparent),
    transparent 68%
  );
  z-index: -1;
  pointer-events: none;
}

.hero__eyebrow {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.26em;
  color: var(--app-accent);
}

.hero__eyebrow::before {
  content: '';
  width: 22px;
  height: 1px;
  background: currentColor;
  opacity: 0.7;
}

.hero h1 {
  margin: 18px 0 0;
  font-family: var(--font-serif);
  font-size: clamp(36px, 10.5vw, 48px);
  font-weight: 600;
  line-height: 1.26;
  letter-spacing: 0.008em;
}

.hero h1 em {
  position: relative;
  font-style: normal;
  color: var(--app-accent);
  white-space: nowrap;
}

.hero h1 em::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 3%;
  bottom: 4px;
  height: 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  z-index: -1;
}

.hero__desc {
  max-width: 29em;
  margin: 18px 0 0;
  font-size: 14px;
  line-height: 1.85;
  color: var(--app-muted);
}

.hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 26px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 50px;
  padding: 0 21px;
  border-radius: 999px;
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  transition: transform 0.16s ease, opacity 0.16s ease;
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn--primary {
  background: var(--app-accent);
  color: var(--app-bg);
  box-shadow: 0 10px 26px color-mix(in srgb, var(--app-accent) 24%, transparent);
}

.btn--ghost {
  border: 1px solid var(--app-line);
  background: color-mix(in srgb, var(--app-ui) 55%, transparent);
  color: var(--app-fg);
}

.btn__spinner {
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, var(--app-bg) 35%, transparent);
  border-top-color: var(--app-bg);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.hero__features {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 22px 0 0;
  font-size: 11.5px;
  color: var(--app-muted);
}

.hero__features span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.hero__features svg {
  color: var(--app-accent);
}

.shelf {
  margin-top: 54px;
}

.shelf__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--app-line);
}

.shelf__head h2 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.shelf__head span {
  font-size: 11px;
  color: var(--app-muted);
  letter-spacing: 0.05em;
}

.book-list,
.skeleton-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.book-card {
  position: relative;
  border-bottom: 1px solid var(--app-line-soft);
}

.book-card__main {
  display: flex;
  align-items: center;
  gap: 15px;
  width: 100%;
  padding: 16px 44px 16px 0;
  text-align: left;
  color: inherit;
}

.book-card__cover {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 52px;
  height: 72px;
  border-radius: 4px 9px 9px 4px;
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
  box-shadow:
    inset 3px 0 0 rgba(30, 20, 10, 0.08),
    inset 0 0 0 1px rgba(255, 255, 255, 0.28),
    0 5px 14px rgba(35, 25, 15, 0.14);
  overflow: hidden;
}

.book-card__cover img {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.book-card__cover::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(118deg, rgba(255, 255, 255, 0.34), transparent 48%);
}

.book-card__cover--image::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    rgba(20, 12, 4, 0.2),
    transparent 15%,
    transparent 86%,
    rgba(20, 12, 4, 0.08)
  );
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}

.book-card__cover--image::after {
  z-index: 3;
  background: linear-gradient(118deg, rgba(255, 255, 255, 0.14), transparent 46%);
}

.book-card__cover span {
  position: relative;
  z-index: 1;
}

.book-card__meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.book-card__title {
  font-size: 15.5px;
  font-weight: 600;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.book-card__author {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--app-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.book-card__badge {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  letter-spacing: 0.06em;
  color: var(--app-accent);
}

.book-card__progress {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 5px;
}

.book-card__bar {
  flex: 1;
  max-width: 168px;
  height: 3px;
  border-radius: 2px;
  background: var(--app-line);
  overflow: hidden;
}

.book-card__bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--app-accent);
  transition: width 0.4s ease;
}

.book-card__pct {
  flex: none;
  font-size: 10.5px;
  color: var(--app-accent);
  font-variant-numeric: tabular-nums;
}

.book-card__new {
  margin-top: 4px;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--app-muted);
  opacity: 0.72;
}

.book-card__delete {
  position: absolute;
  top: 10px;
  right: -2px;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--app-muted);
  opacity: 0.55;
  transition: opacity 0.16s ease, color 0.16s ease;
}

.book-card__delete:active,
.book-card__delete:hover {
  opacity: 1;
  color: var(--app-accent);
}

.book-card__confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 14px;
  padding: 11px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent) 7%, transparent);
  font-size: 11.5px;
  color: var(--app-muted);
}

.book-card__confirm-actions {
  display: flex;
  gap: 7px;
}

.confirm-btn {
  padding: 6px 12px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--app-fg);
}

.confirm-btn--danger {
  border-color: transparent;
  background: #a3412c;
  color: #fbeee7;
}

.confirm-btn:disabled {
  opacity: 0.5;
}

.empty {
  margin-top: 20px;
  padding: 36px 24px 32px;
  border: 1px dashed var(--app-line);
  border-radius: 18px;
  text-align: center;
  color: var(--app-muted);
}

.empty__icon {
  display: inline-grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin-bottom: 12px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
  color: var(--app-accent);
}

.empty h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--app-fg);
}

.empty p {
  margin: 7px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
}

.empty__action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 16px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--app-accent);
  font-size: 12.5px;
  color: var(--app-accent);
}

.skeleton {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 16px 0;
  border-bottom: 1px solid var(--app-line-soft);
}

.skeleton__cover,
.skeleton__lines i {
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--app-fg) 6%, transparent) 30%,
    color-mix(in srgb, var(--app-fg) 11%, transparent) 50%,
    color-mix(in srgb, var(--app-fg) 6%, transparent) 70%
  );
  background-size: 220% 100%;
  animation: shimmer 1.4s ease infinite;
}

.skeleton__cover {
  flex: none;
  width: 52px;
  height: 72px;
  border-radius: 5px;
}

.skeleton__lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.skeleton__lines i {
  height: 11px;
  border-radius: 4px;
}

.skeleton__lines i:nth-child(1) {
  width: 56%;
}

.skeleton__lines i:nth-child(2) {
  width: 36%;
  height: 9px;
}

.skeleton__lines i:nth-child(3) {
  width: 72%;
  height: 4px;
  margin-top: 3px;
}

.library__foot {
  margin-top: 42px;
  padding-top: 16px;
  border-top: 1px solid var(--app-line-soft);
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--app-muted);
  opacity: 0.8;
}

.file-input {
  position: fixed;
  left: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes shimmer {
  from {
    background-position: 140% 0;
  }
  to {
    background-position: -60% 0;
  }
}

@media (min-width: 640px) {
  .library__inner {
    padding-left: 28px;
    padding-right: 28px;
  }

  .hero {
    margin-top: 56px;
  }
}
</style>
