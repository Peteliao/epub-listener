<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PronunciationReport } from '@/core/feedback/types'
import {
  copyText,
  downloadTextFile,
  openPronunciationIssue,
  pronunciationIssueBody,
  pronunciationIssueTitle,
  reportFileName,
  reportsToJsonl,
} from '@/core/feedback/report'
import {
  listPronunciationReports,
  removePronunciationReport,
  savePronunciationReport,
} from '@/core/db/LibraryDB'
import Sheet from './Sheet.vue'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  close: []
  notice: [message: string, tone?: 'info' | 'error']
  changed: [count: number]
}>()

const reports = ref<PronunciationReport[]>([])
const loading = ref(false)
const error = ref('')
const confirmRemoveId = ref<string | null>(null)

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function excerpt(report: PronunciationReport): string {
  const text = report.paragraph.text.replace(/\s+/g, ' ').trim()
  return text.length > 86 ? `${text.slice(0, 86)}…` : text
}

function marksLabel(report: PronunciationReport): string {
  return report.marks
    .map((mark) => `${mark.char} → ${mark.expectedLabel}`)
    .join(' · ')
}

function engineLabel(report: PronunciationReport): string {
  const voice = report.voice
  if (voice.engine === 'system') return `${voice.voiceLabel} · 系统语音`
  return `${voice.voiceLabel} · ${voice.packVersion || '离线包'}`
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const list = await listPronunciationReports()
    reports.value = list.reverse()
    emit('changed', reports.value.length)
  } catch {
    error.value = '读取本机反馈记录失败。'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      confirmRemoveId.value = null
      void refresh()
    }
  },
  { immediate: true },
)

async function copyReport(report: PronunciationReport): Promise<void> {
  const text = `${pronunciationIssueTitle(report)}\n\n${pronunciationIssueBody(report)}`
  const copied = await copyText(text)
  emit(
    'notice',
    copied ? '反馈内容已复制。' : '复制失败，请检查浏览器权限。',
    copied ? 'info' : 'error',
  )
}

async function copyAll(): Promise<void> {
  if (!reports.value.length) return
  const copied = await copyText(reportsToJsonl(reports.value))
  emit(
    'notice',
    copied
      ? '已复制全部 JSONL，可粘贴保存为 .jsonl 文件。'
      : '复制失败，请检查浏览器权限。',
    copied ? 'info' : 'error',
  )
}

function exportAll(): void {
  if (!reports.value.length) return
  downloadTextFile(reportsToJsonl(reports.value), reportFileName())
  emit('notice', '已生成 JSONL 导出文件。')
}

async function openGithub(report: PronunciationReport): Promise<void> {
  const issueUrl = openPronunciationIssue(report)
  // Reactive records are proxies and cannot be structured-cloned into IndexedDB.
  const updated = JSON.parse(JSON.stringify(report)) as PronunciationReport
  updated.status = 'issue-opened'
  updated.issueUrl = issueUrl
  updated.updatedAt = Date.now()
  try {
    await savePronunciationReport(updated)
    reports.value = reports.value.map((item) =>
      item.id === updated.id ? updated : item,
    )
  } catch {
    emit('notice', 'GitHub 已打开，但记录状态更新失败。', 'error')
    return
  }
  emit('notice', '已打开 GitHub 提交页，请确认内容后点击 Create。')
}

async function removeReport(report: PronunciationReport): Promise<void> {
  if (confirmRemoveId.value !== report.id) {
    confirmRemoveId.value = report.id
    return
  }
  try {
    await removePronunciationReport(report.id)
    reports.value = reports.value.filter((item) => item.id !== report.id)
    confirmRemoveId.value = null
    emit('changed', reports.value.length)
    emit('notice', '已删除这条本机反馈。')
  } catch {
    emit('notice', '删除失败，请稍后重试。', 'error')
  }
}
</script>

<template>
  <Sheet
    :open="open"
    title="读音反馈记录"
    subtitle="仅保存在本机；导出 JSONL 后可汇总成读音词典"
    @close="emit('close')"
  >
    <div v-if="loading" class="state">正在读取记录…</div>
    <div v-else-if="error" class="state">
      <p>{{ error }}</p>
      <button type="button" class="text-action" @click="refresh">重试</button>
    </div>
    <div v-else-if="!reports.length" class="state">
      还没有读音反馈。朗读时点顶部的旗标，或从设置里进入「读音反馈」。
    </div>

    <template v-else>
      <div class="toolbar">
        <span class="count">{{ reports.length }} 条记录</span>
        <div class="toolbar-actions">
          <button type="button" class="tool" @click="copyAll">复制全部</button>
          <button type="button" class="tool" @click="exportAll">导出 JSONL</button>
        </div>
      </div>

      <div class="report-list">
        <article v-for="report in reports" :key="report.id" class="report">
          <header class="report-head">
            <div class="report-title">
              <strong>{{ report.includeTitle ? report.book.title : '未记录书名' }}</strong>
              <span>{{ formatDate(report.createdAt) }}</span>
            </div>
            <span
              class="status"
              :class="{ 'is-opened': report.status === 'issue-opened' }"
            >
              {{ report.status === 'issue-opened' ? 'GitHub 已打开' : '仅本机' }}
            </span>
          </header>

          <p class="excerpt">{{ excerpt(report) }}</p>
          <p class="marks">{{ marksLabel(report) }}</p>
          <p v-if="report.note" class="note">备注：{{ report.note }}</p>
          <p class="meta">
            {{ report.book.chapterLabel || `第 ${report.book.chapterIndex + 1} 章` }}
            · {{ engineLabel(report) }}
          </p>

          <div class="report-actions">
            <button type="button" class="report-action" @click="copyReport(report)">
              复制
            </button>
            <button type="button" class="report-action" @click="openGithub(report)">
              GitHub
            </button>
            <button
              type="button"
              class="report-action report-action--danger"
              @click="removeReport(report)"
            >
              {{ confirmRemoveId === report.id ? '确认删除' : '删除' }}
            </button>
          </div>
        </article>
      </div>

      <p class="privacy">
        JSONL 包含所选段落、书名与音色信息，请只发送给可信的开发者。导出后可用
        scripts/reports-to-overlay.mjs 汇总候选读音。
      </p>
    </template>
  </Sheet>
</template>

<style scoped>
.state {
  padding: 26px 0 18px;
  color: var(--app-muted);
  font-size: 14px;
  line-height: 1.7;
}

.state p {
  margin: 0 0 10px;
}

.text-action {
  padding: 0;
  color: var(--app-accent);
  font-size: 13px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.count {
  color: var(--app-muted);
  font-size: 12px;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
}

.tool {
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 8px;
  color: var(--app-fg);
  font-size: 11px;
}

.report-list {
  display: grid;
  gap: 12px;
}

.report {
  padding: 13px 14px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 10%, transparent);
  border-radius: 14px;
  background: var(--app-bg);
}

.report-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.report-title {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.report-title strong {
  overflow: hidden;
  color: var(--app-fg);
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-title span {
  color: var(--app-muted);
  font-size: 10px;
}

.status {
  flex: none;
  padding: 3px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-fg) 7%, transparent);
  color: var(--app-muted);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.status.is-opened {
  color: var(--app-accent);
}

.excerpt {
  margin: 10px 0 7px;
  color: color-mix(in srgb, var(--app-fg) 82%, transparent);
  font-family: var(--font-serif);
  font-size: 13px;
  line-height: 1.7;
}

.marks {
  margin: 0;
  color: var(--app-accent);
  font-size: 13px;
}

.note {
  margin: 5px 0 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.6;
}

.meta {
  margin: 7px 0 0;
  color: var(--app-muted);
  font-size: 10px;
}

.report-actions {
  display: flex;
  gap: 8px;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--app-fg) 8%, transparent);
}

.report-action {
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 11%, transparent);
  border-radius: 8px;
  color: var(--app-fg);
  font-size: 11px;
}

.report-action--danger {
  margin-left: auto;
  color: var(--app-muted);
}

.privacy {
  margin: 16px 0 0;
  color: var(--app-muted);
  font-size: 10px;
  line-height: 1.7;
}
</style>
