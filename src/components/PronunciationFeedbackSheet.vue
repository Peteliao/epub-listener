<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BookFormat } from '@/types'
import type {
  FeedbackParagraph,
  FeedbackSnapshot,
  PronunciationMark,
  PronunciationReport,
} from '@/core/feedback/types'
import {
  createReportId,
  createPronunciationReport,
  openPronunciationIssue,
} from '@/core/feedback/report'
import {
  getReadingContext,
  normalizeCustomReading,
  textUnits,
  type ReadingCandidate,
  type ReadingContext,
} from '@/core/feedback/pinyin'
import { savePronunciationReport } from '@/core/db/LibraryDB'
import AppIcon from './AppIcon.vue'
import Sheet from './Sheet.vue'

const props = defineProps<{
  open: boolean
  snapshot: FeedbackSnapshot | null
  bookId: string
  bookTitle: string
  bookFormat: BookFormat
  bookSize: number
  bookFingerprint: string | null
  fingerprintLoading: boolean
  buildId: string
}>()

const emit = defineEmits<{
  close: []
  saved: [report: PronunciationReport]
  notice: [message: string, tone?: 'info' | 'error']
  refresh: []
}>()

const HAN = /\p{Script=Han}/u

const selectedParagraphId = ref<string | null>(null)
const marks = ref<PronunciationMark[]>([])
const activeCharIndex = ref<number | null>(null)
const readingContext = ref<ReadingContext | null>(null)
const readingLoading = ref(false)
const customReading = ref('')
const customError = ref('')
const note = ref('')
const includeTitle = ref(true)
const saving = ref(false)
let contextToken = 0

const paragraphs = computed(() => props.snapshot?.paragraphs ?? [])
const currentParagraphIndex = computed(() =>
  Math.max(
    0,
    paragraphs.value.findIndex((paragraph) => paragraph.isCurrent),
  ),
)
const selectedParagraph = computed<FeedbackParagraph | null>(
  () =>
    paragraphs.value.find(
      (paragraph) => paragraph.id === selectedParagraphId.value,
    ) ??
    paragraphs.value[currentParagraphIndex.value] ??
    null,
)
const charUnits = computed(() => {
  const paragraph = selectedParagraph.value
  if (!paragraph) return []
  return textUnits(paragraph.text).map((unit) => ({
    ...unit,
    han: HAN.test(unit.char),
  }))
})
const markedIndexes = computed(
  () => new Set(marks.value.map((mark) => mark.charIndex)),
)
const activeMark = computed(
  () =>
    marks.value.find((mark) => mark.charIndex === activeCharIndex.value) ??
    null,
)
const canSave = computed(
  () =>
    marks.value.length > 0 &&
    marks.value.every((mark) => Boolean(mark.expectedPinyin)) &&
    Boolean(selectedParagraph.value),
)
const voiceSummary = computed(() => {
  const voice = props.snapshot?.voice
  if (!voice) return ''
  const engine =
    voice.engine === 'sherpa'
      ? `离线包 ${voice.packVersion || '未知版本'}`
      : '系统语音'
  return `${voice.voiceLabel} · ${engine}`
})
const voiceCaveat = computed(() => {
  const voice = props.snapshot?.voice
  if (!voice) return ''
  if (voice.engine !== 'sherpa') {
    return '系统语音由设备控制；这条反馈会记录下来，但修正不会改变系统音色。'
  }
  if (!voice.overlaySupported) {
    return '当前离线音色不读取项目读音词典；这条反馈只能用于支持词典的音色（如山岚）。'
  }
  return ''
})

function relativeLabel(paragraph: FeedbackParagraph): string {
  const delta =
    paragraphs.value.indexOf(paragraph) - currentParagraphIndex.value
  if (delta === 0) return '本段'
  if (delta === -1) return '上一段'
  if (delta < -1) return `上${Math.abs(delta)}段`
  return '下一段'
}

function resetForSnapshot(): void {
  const list = props.snapshot?.paragraphs ?? []
  const current =
    list.find((paragraph) => paragraph.isCurrent) ?? list[list.length - 1]
  selectedParagraphId.value = current?.id ?? null
  marks.value = []
  activeCharIndex.value = null
  readingContext.value = null
  readingLoading.value = false
  customReading.value = ''
  customError.value = ''
  note.value = ''
  includeTitle.value = true
  contextToken += 1
}

watch(
  () => props.open,
  (open) => {
    if (open) resetForSnapshot()
  },
  { immediate: true },
)

watch(
  () => props.snapshot,
  () => {
    if (props.open) resetForSnapshot()
  },
)

function requestRefresh(): void {
  if (
    marks.value.length &&
    !window.confirm('刷新会清空已标记的字，继续吗？')
  ) {
    return
  }
  emit('refresh')
}

function selectParagraph(paragraph: FeedbackParagraph): void {
  if (paragraph.id === selectedParagraphId.value) return
  if (
    marks.value.length &&
    !window.confirm('切换段落会清空已标记的字，继续吗？')
  ) {
    return
  }
  selectedParagraphId.value = paragraph.id
  marks.value = []
  activeCharIndex.value = null
  readingContext.value = null
  customReading.value = ''
  customError.value = ''
  contextToken += 1
}

async function loadContext(
  paragraph: FeedbackParagraph,
  charIndex: number,
): Promise<void> {
  const token = (contextToken += 1)
  readingLoading.value = true
  readingContext.value = null
  customError.value = ''
  try {
    const result = await getReadingContext(paragraph.text, charIndex)
    if (token !== contextToken) return
    readingContext.value = result
    const mark = marks.value.find((item) => item.charIndex === charIndex)
    if (mark && result) {
      mark.word = result.word
      mark.wordStart = result.wordStart
      mark.wordEnd = result.wordEnd
    }
  } finally {
    if (token === contextToken) readingLoading.value = false
  }
}

function pickChar(start: number, char: string): void {
  const paragraph = selectedParagraph.value
  if (!paragraph || !HAN.test(char)) return
  let mark = marks.value.find((item) => item.charIndex === start)
  if (!mark) {
    mark = {
      id: createReportId(),
      char,
      charIndex: start,
      word: char,
      wordStart: start,
      wordEnd: start + char.length,
      expectedPinyin: '',
      expectedLabel: '',
    }
    marks.value.push(mark)
  }
  activeCharIndex.value = start
  customReading.value = ''
  void loadContext(paragraph, start)
}

function activateMark(mark: PronunciationMark): void {
  const paragraph = selectedParagraph.value
  if (!paragraph) return
  activeCharIndex.value = mark.charIndex
  customReading.value = ''
  void loadContext(paragraph, mark.charIndex)
}

function removeMark(mark: PronunciationMark): void {
  marks.value = marks.value.filter((item) => item.id !== mark.id)
  if (activeCharIndex.value === mark.charIndex) {
    activeCharIndex.value = null
    readingContext.value = null
    contextToken += 1
  }
}

function chooseCandidate(candidate: ReadingCandidate): void {
  const mark = activeMark.value
  if (!mark) return
  mark.expectedPinyin = candidate.value
  mark.expectedLabel = candidate.label
  customReading.value = ''
  customError.value = ''
}

async function applyCustomReading(): Promise<void> {
  const mark = activeMark.value
  if (!mark) return
  const reading = await normalizeCustomReading(customReading.value)
  if (!reading) {
    customError.value = '请输入单个音节，例如 huan2 或 huán。'
    return
  }
  mark.expectedPinyin = reading.value
  mark.expectedLabel = reading.label
  customError.value = ''
}

function buildReport(): PronunciationReport | null {
  const paragraph = selectedParagraph.value
  const snapshot = props.snapshot
  if (!paragraph || !snapshot || !canSave.value) return null
  return createPronunciationReport({
    id: createReportId(),
    createdAt: Date.now(),
    appBuildId: props.buildId,
    book: {
      id: props.bookId,
      title: props.bookTitle,
      format: props.bookFormat,
      size: props.bookSize,
      fingerprint: props.bookFingerprint,
      chapterIndex: snapshot.chapterIndex,
      chapterHref: snapshot.chapterHref,
      chapterLabel: snapshot.chapterLabel,
    },
    paragraph,
    marks: marks.value.map((mark) => ({ ...mark })),
    note: note.value,
    voice: { ...snapshot.voice },
    includeTitle: includeTitle.value,
  })
}

async function saveLocal(): Promise<void> {
  if (!canSave.value) {
    emit('notice', '请先为每个标记的字选择正确读音。', 'error')
    return
  }
  const report = buildReport()
  if (!report || saving.value) return
  saving.value = true
  try {
    await savePronunciationReport(report)
    emit('saved', report)
    emit('notice', '反馈已保存到本机，可在「读音反馈记录」中导出。')
    emit('close')
  } catch {
    emit('notice', '反馈保存失败，请稍后重试。', 'error')
  } finally {
    saving.value = false
  }
}

async function submitGithub(): Promise<void> {
  if (!canSave.value) {
    emit('notice', '请先为每个标记的字选择正确读音。', 'error')
    return
  }
  const report = buildReport()
  if (!report || saving.value) return
  saving.value = true
  const issueUrl = openPronunciationIssue(report)
  report.status = 'issue-opened'
  report.issueUrl = issueUrl
  report.updatedAt = Date.now()
  try {
    await savePronunciationReport(report)
    emit('saved', report)
    emit('notice', '已打开 GitHub 提交页，请确认内容后点击 Create。')
    emit('close')
  } catch {
    emit('notice', 'GitHub 已打开，但本地记录保存失败。', 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Sheet
    :open="open"
    title="读音反馈"
    subtitle="点按读错的汉字，再选择正确读音"
    @close="emit('close')"
  >
    <div v-if="!snapshot || !paragraphs.length" class="empty">
      <p>暂时读不到当前段落。请先开始朗读，或轻点正文定位后再试。</p>
      <button type="button" class="text-action" @click="requestRefresh">
        读取当前进度
      </button>
    </div>

    <template v-else>
      <div class="picker-head">
        <div>
          <h3 class="section-title">选择段落</h3>
          <p class="section-sub">朗读过快时，可选回上一段</p>
        </div>
        <button type="button" class="text-action" @click="requestRefresh">
          刷新
        </button>
      </div>

      <div class="paragraph-picker" role="tablist" aria-label="反馈段落">
        <button
          v-for="paragraph in paragraphs"
          :key="paragraph.id"
          type="button"
          role="tab"
          class="paragraph-tab"
          :class="{ 'is-active': paragraph.id === selectedParagraphId }"
          :aria-selected="paragraph.id === selectedParagraphId"
          @click="selectParagraph(paragraph)"
        >
          <span>{{ relativeLabel(paragraph) }}</span>
          <small v-if="paragraph.isCurrent">朗读中</small>
        </button>
      </div>

      <div v-if="selectedParagraph" class="paragraph-block">
        <p class="paragraph-meta">
          {{ selectedParagraph.text.length }} 字 · 第
          {{ selectedParagraph.startSentenceIndex + 1 }}–
          {{ selectedParagraph.endSentenceIndex + 1 }} 句
        </p>
        <div class="char-grid" aria-label="段落正文，点按汉字标记读音">
          <template v-for="unit in charUnits" :key="unit.start">
            <button
              v-if="unit.han"
              type="button"
              class="char"
              :class="{
                'is-marked': markedIndexes.has(unit.start),
                'is-active': activeCharIndex === unit.start,
              }"
              :aria-label="`标记「${unit.char}」`"
              @click="pickChar(unit.start, unit.char)"
            >
              {{ unit.char }}
            </button>
            <span v-else class="char char--plain">{{ unit.char }}</span>
          </template>
        </div>
        <p class="char-hint">轻点读错的汉字；标错可以再点一次修改或删除。</p>
      </div>

      <div v-if="marks.length" class="marks">
        <h3 class="section-title">已标记</h3>
        <div class="mark-list">
          <div
            v-for="mark in marks"
            :key="mark.id"
            class="mark-row"
            :class="{ 'is-active': mark.charIndex === activeCharIndex }"
          >
            <button
              type="button"
              class="mark-main"
              @click="activateMark(mark)"
            >
              <span class="mark-char">{{ mark.char }}</span>
              <span class="mark-word">{{ mark.word }}</span>
              <span
                class="mark-reading"
                :class="{ 'is-unset': !mark.expectedPinyin }"
              >
                {{ mark.expectedLabel || '待选读音' }}
              </span>
            </button>
            <button
              type="button"
              class="mark-remove"
              aria-label="删除标记"
              @click="removeMark(mark)"
            >
              <AppIcon name="close" :size="14" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="activeMark" class="editor">
        <div class="editor-head">
          <h3 class="section-title">
            「{{ activeMark.char }}」在「{{ readingContext?.word || activeMark.word }}」中
          </h3>
          <span v-if="readingContext?.word" class="editor-word">
            正确读音
          </span>
        </div>
        <p v-if="readingLoading" class="editor-hint">正在查询候选读音…</p>
        <template v-else>
          <div v-if="readingContext?.candidates.length" class="candidates">
            <button
              v-for="candidate in readingContext.candidates"
              :key="candidate.value"
              type="button"
              class="candidate"
              :class="{
                'is-active': candidate.value === activeMark.expectedPinyin,
              }"
              @click="chooseCandidate(candidate)"
            >
              <span class="candidate-label">{{ candidate.label }}</span>
              <span class="candidate-value">{{ candidate.value }}</span>
              <span v-if="candidate.contextual" class="candidate-tag">按词</span>
            </button>
          </div>
          <p v-else class="editor-hint">没有查到候选读音，请在下方手动输入。</p>
          <p class="editor-note">
            「按词」是词典按当前词组给出的读音；如果听到的正是它，请选择其他读音。
          </p>
          <div class="custom-row">
            <input
              v-model="customReading"
              class="custom-input"
              type="text"
              autocapitalize="off"
              spellcheck="false"
              placeholder="手动输入，如 huan2 或 huán"
              aria-label="手动输入正确读音"
              @keydown.enter.prevent="applyCustomReading"
            />
            <button type="button" class="custom-apply" @click="applyCustomReading">
              应用
            </button>
          </div>
          <p v-if="customError" class="editor-error">{{ customError }}</p>
        </template>
      </div>

      <label class="note-field">
        <span>补充说明（可选）</span>
        <textarea
          v-model="note"
          rows="2"
          maxlength="300"
          placeholder="例如：这里应读 huán，不是 hái"
        ></textarea>
      </label>

      <div class="voice-meta">
        <span>{{ voiceSummary }}</span>
        <span v-if="fingerprintLoading">正在生成书籍指纹…</span>
        <span v-else-if="bookFingerprint">
          指纹 {{ bookFingerprint.slice(0, 14) }}…
        </span>
      </div>
      <p v-if="voiceCaveat" class="voice-caveat">{{ voiceCaveat }}</p>

      <label class="consent">
        <input v-model="includeTitle" type="checkbox" />
        <span>在公开反馈中包含书名</span>
      </label>
      <p class="privacy">
        提交会打开预填好的 GitHub issue 页面，需要登录后手动点击 Create；所选段落会公开显示。
        反馈会先保存在本机，不上传整本书。
      </p>

      <div class="actions">
        <button
          type="button"
          class="action action--quiet"
          :disabled="saving || !canSave"
          @click="saveLocal"
        >
          存到本机
        </button>
        <button
          type="button"
          class="action action--primary"
          :disabled="saving || !canSave"
          @click="submitGithub"
        >
          去 GitHub 提交
        </button>
      </div>
    </template>
  </Sheet>
</template>

<style scoped>
.empty {
  padding: 28px 0 18px;
  color: var(--app-muted);
  font-size: 14px;
  line-height: 1.7;
}

.empty p {
  margin: 0 0 12px;
}

.text-action {
  padding: 0;
  color: var(--app-accent);
  font-size: 13px;
}

.picker-head,
.editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--app-muted);
}

.section-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--app-muted);
}

.paragraph-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 16px;
}

.paragraph-tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 10px;
  color: var(--app-fg);
  font-size: 13px;
}

.paragraph-tab small {
  color: var(--app-muted);
  font-size: 10px;
}

.paragraph-tab.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 58%, transparent);
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
}

.paragraph-block {
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 10%, transparent);
  border-radius: 14px;
  background: var(--app-bg);
}

.paragraph-meta {
  margin: 0 0 10px;
  color: var(--app-muted);
  font-size: 11px;
  letter-spacing: 0.06em;
}

.char-grid {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  font-family: var(--font-serif);
  font-size: 20px;
  line-height: 1.6;
  user-select: none;
}

.char {
  min-width: 1.05em;
  min-height: 1.45em;
  padding: 0 1px;
  border-radius: 5px;
  color: var(--app-fg);
  text-align: center;
  touch-action: manipulation;
}

.char--plain {
  color: color-mix(in srgb, var(--app-fg) 72%, transparent);
}

.char.is-marked {
  background: color-mix(in srgb, var(--app-accent) 13%, transparent);
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-fg));
}

.char.is-active {
  background: color-mix(in srgb, var(--app-accent) 24%, transparent);
  box-shadow: inset 0 -2px 0 var(--app-accent);
}

.char-hint {
  margin: 10px 0 0;
  color: var(--app-muted);
  font-size: 11px;
}

.marks {
  margin-top: 18px;
}

.mark-list {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.mark-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 10%, transparent);
  border-radius: 11px;
  background: var(--app-bg);
}

.mark-row.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 48%, transparent);
}

.mark-main {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
  padding: 10px 12px;
  color: var(--app-fg);
  text-align: left;
}

.mark-char {
  font-family: var(--font-serif);
  font-size: 19px;
}

.mark-word {
  flex: 1;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mark-reading {
  color: var(--app-accent);
  font-size: 14px;
}

.mark-reading.is-unset {
  color: var(--app-muted);
  font-size: 12px;
}

.mark-remove {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin-right: 6px;
  border-radius: 50%;
  color: var(--app-muted);
}

.editor {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 28%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-accent) 4%, var(--app-bg));
}

.editor-word {
  color: var(--app-muted);
  font-size: 11px;
}

.editor-hint,
.editor-note {
  margin: 8px 0 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.6;
}

.candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.candidate {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
  border-radius: 9px;
  color: var(--app-fg);
}

.candidate.is-active {
  border-color: color-mix(in srgb, var(--app-accent) 55%, transparent);
  background: color-mix(in srgb, var(--app-accent) 9%, transparent);
  color: var(--app-accent);
}

.candidate-label {
  font-size: 15px;
}

.candidate-value {
  color: var(--app-muted);
  font-size: 10px;
}

.candidate-tag {
  color: var(--app-muted);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.custom-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.custom-input {
  flex: 1;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
  border-radius: 9px;
  background: var(--app-bg);
  color: var(--app-fg);
  font-size: 13px;
}

.custom-apply {
  flex: none;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
  border-radius: 9px;
  color: var(--app-fg);
  font-size: 12px;
}

.editor-error {
  margin: 8px 0 0;
  color: #b4553e;
  font-size: 11px;
}

.note-field {
  display: block;
  margin-top: 16px;
}

.note-field span {
  display: block;
  margin-bottom: 7px;
  color: var(--app-muted);
  font-size: 12px;
}

.note-field textarea {
  width: 100%;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-fg) 12%, transparent);
  border-radius: 10px;
  background: var(--app-bg);
  color: var(--app-fg);
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
}

.voice-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  margin-top: 14px;
  color: var(--app-muted);
  font-size: 11px;
}

.voice-caveat {
  margin: 7px 0 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.6;
}

.consent {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  color: var(--app-fg);
  font-size: 13px;
}

.consent input {
  width: 16px;
  height: 16px;
  accent-color: var(--app-accent);
}

.privacy {
  margin: 7px 0 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.65;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}

.action {
  flex: 1;
  min-height: 44px;
  border-radius: 11px;
  font-size: 14px;
}

.action:disabled {
  opacity: 0.45;
}

.action--quiet {
  border: 1px solid color-mix(in srgb, var(--app-fg) 13%, transparent);
  color: var(--app-fg);
}

.action--primary {
  background: var(--app-accent);
  color: var(--app-bg);
}

@media (min-width: 640px) {
  .char-grid {
    font-size: 21px;
  }
}
</style>
