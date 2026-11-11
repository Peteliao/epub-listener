<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  lockScreenProbe,
  PROBE_CLIP_SECONDS,
  type ProbeSnapshot,
  type ProbeVerdictCode,
} from '@/core/system/LockScreenProbe'

const props = defineProps<{
  isPlaying: boolean
  buildId: string
}>()

const emit = defineEmits<{ notice: [message: string] }>()

const snapshot = ref<ProbeSnapshot>(lockScreenProbe.getSnapshot())
const copied = ref(false)
const showRaw = ref(false)

let unsubscribe: (() => void) | null = null
let copyTimer: number | null = null

onMounted(() => {
  lockScreenProbe.setBuildId(props.buildId)
  unsubscribe = lockScreenProbe.subscribe(() => {
    snapshot.value = lockScreenProbe.getSnapshot()
  })
  snapshot.value = lockScreenProbe.getSnapshot()
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  if (copyTimer !== null) {
    window.clearTimeout(copyTimer)
    copyTimer = null
  }
})

const running = computed(() => snapshot.value.phase === 'running')
const result = computed(() => snapshot.value.result)
const verdictCode = computed<ProbeVerdictCode | null>(
  () => result.value?.verdict.code ?? null,
)
const session = computed(() => result.value?.session ?? null)

const phaseText = computed(() => {
  if (running.value) {
    if (snapshot.value.clip === 'A') {
      if (snapshot.value.audioTime >= PROBE_CLIP_SECONDS - 0.2) {
        return 'A 段结束，正在切换 B'
      }
      return 'A 段播放中 · 低音滴答'
    }
    if (snapshot.value.clip === 'B') return 'B 段播放中 · 高音滴答'
    return '准备测试音频'
  }
  if (snapshot.value.phase === 'finished') return '已完成'
  return '待开始'
})

const liveRows = computed(() => {
  const current = snapshot.value
  return [
    {
      label: '屏幕',
      value: current.hidden
        ? `已锁屏 ${(current.hiddenMs / 1000).toFixed(1)} s`
        : '未锁定',
    },
    {
      label: '音频',
      value: current.clip
        ? `${current.clip} 段 · ${current.audioTime.toFixed(1)} / ${PROBE_CLIP_SECONDS} s`
        : '—',
    },
    { label: '主线程计时器', value: `${current.timerTicks} 次` },
    {
      label: 'Worker',
      value: `${current.workerTicks} tick · ${jobLabel(current.workerJob)}`,
    },
  ]
})

const metrics = computed<Array<{ label: string; value: string }>>(() => {
  const current = result.value
  const active = current?.session
  if (!current || !active) return []

  const rows = [
    {
      label: '锁屏时长',
      value: `${(active.durationMs / 1000).toFixed(1)} s`,
    },
    { label: 'A 段', value: describeA() },
    { label: 'B 段', value: describeB() },
    {
      label: '主线程计时器',
      value: `后台 ${active.timerTicks} 次 · 最大间隔 ${formatGap(
        active.timerMaxGapMs,
      )}`,
    },
    {
      label: 'Worker',
      value: `后台 ${active.workerTicks} tick · 最大间隔 ${formatGap(
        active.workerMaxGapMs,
      )}`,
    },
    {
      label: '合成模拟',
      value:
        active.workerJobDoneWall !== null
          ? '锁屏期间完成'
          : current.evidence.jobRequestedWall !== null
            ? '未在锁屏期间完成'
            : '未在锁屏期间发起',
    },
  ]
  return rows
})

const verdictTone = computed(() => {
  switch (verdictCode.value) {
    case 'ok':
      return 'is-ok'
    case 'chain-blocked':
    case 'incomplete':
      return 'is-warn'
    case 'media-stopped':
    case 'js-frozen':
    case 'worker-frozen':
    case 'unsupported':
      return 'is-bad'
    default:
      return ''
  }
})

function inSession(wall: number | null): boolean {
  const active = session.value
  if (!active || wall === null) return false
  return wall >= active.startWall && wall <= active.endWall + 1_500
}

function describeA(): string {
  const current = result.value
  const active = current?.session
  if (!current || !active) return '—'
  if (inSession(current.evidence.aEndedWall)) {
    return `${active.timeAtHide.toFixed(1)} s → 已播完`
  }
  if (active.clipAtShow === 'B') {
    return `${active.timeAtHide.toFixed(1)} s → 已切到 B`
  }
  return `${active.timeAtHide.toFixed(1)} s → ${active.timeAtShow.toFixed(1)} s`
}

function describeB(): string {
  const current = result.value
  const active = current?.session
  if (!current || !active) return '—'
  const request = current.evidence.bRequestWall
  if (request === null) return '锁屏期间未起播'

  const delay = Math.max(0, request - active.startWall) / 1000
  let state = '未出声'
  if (current.evidence.bPlayRejectedWall !== null) {
    state = 'play() 被拒绝'
  } else if (inSession(current.evidence.bEndedWall)) {
    state = '已播完'
  } else if (active.clipAtShow === 'B') {
    state = `解锁时 ${active.timeAtShow.toFixed(1)} s`
  }
  return `锁屏后 ${delay.toFixed(1)} s · ${state}`
}

function jobLabel(state: ProbeSnapshot['workerJob']): string {
  if (state === 'running') return '合成模拟中'
  if (state === 'done') return '合成模拟完成'
  if (state === 'failed') return '合成模拟出错'
  return '合成模拟待命'
}

function formatGap(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`
}

function start(): void {
  if (props.isPlaying) {
    emit('notice', '请先暂停朗读，再开始锁屏自检。')
    return
  }
  copied.value = false
  showRaw.value = false
  lockScreenProbe.start()
}

function finishNow(): void {
  lockScreenProbe.finishNow()
}

function selectRaw(event: FocusEvent): void {
  const target = event.target
  if (target instanceof HTMLTextAreaElement) target.select()
}

async function copyReport(): Promise<void> {
  const text = result.value?.report
  if (!text) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    copied.value = true
    showRaw.value = false
    if (copyTimer !== null) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copied.value = false
      copyTimer = null
    }, 2400)
  } catch {
    showRaw.value = true
    emit('notice', '无法写入剪贴板，请长按下方文本手动复制。')
  }
}
</script>

<template>
  <div class="probe">
    <div class="probe__head">
      <div>
        <h3 class="probe__title">锁屏自检</h3>
        <p class="probe__sub">
          验证 iPhone 锁屏后，媒体、主线程与 Worker 是否还在工作
        </p>
      </div>
      <span class="probe__badge" :data-phase="snapshot.phase">
        {{ snapshot.phase === 'running' ? '进行中' : snapshot.phase === 'finished' ? '已完成' : '待开始' }}
      </span>
    </div>

    <ol class="probe__steps">
      <li>把媒体音量调到能听清，测试期间不要播放书籍。</li>
      <li>点开始后 3 秒内按电源键锁屏。</li>
      <li>锁屏后先听到低音滴答（A 段），约 12 秒后变成高音滴答（B 段），说明续播成功。</li>
      <li>约 30 秒后解锁，结果会自动生成。</li>
    </ol>

    <p class="probe__note">
      两段测试音频各 12 秒，不会上传任何内容；锁屏期间可在锁屏界面看到「A 段 / B 段」。
      可在 Safari 标签页和主屏幕 PWA 各测一次。
    </p>

    <div class="probe__actions">
      <button
        v-if="!running"
        type="button"
        class="probe-btn probe-btn--primary"
        @click="start"
      >
        {{ snapshot.phase === 'finished' ? '重新测试' : '开始锁屏自检' }}
      </button>
      <button v-else type="button" class="probe-btn" @click="finishNow">
        提前结束
      </button>
    </div>

    <div v-if="running" class="probe__live">
      <div class="probe__live-head">
        <strong>{{ phaseText }}</strong>
        <span>{{ (snapshot.elapsedMs / 1000).toFixed(1) }} s</span>
      </div>
      <div
        v-for="row in liveRows"
        :key="row.label"
        class="probe__live-row"
      >
        <span>{{ row.label }}</span>
        <span>{{ row.value }}</span>
      </div>
      <p v-if="!snapshot.hidden && snapshot.elapsedMs > 8000" class="probe__hint">
        还没有检测到锁屏。请按电源键锁屏，让音频在后台继续。
      </p>
      <p v-else-if="snapshot.hidden" class="probe__hint">
        保持锁屏，听到音调变高后继续等待，约 30 秒再解锁。
      </p>
    </div>

    <div v-if="result" class="probe__result" :class="verdictTone">
      <strong class="probe__verdict">{{ result.verdict.title }}</strong>
      <p class="probe__verdict-detail">{{ result.verdict.detail }}</p>

      <div class="probe__metrics">
        <div v-for="row in metrics" :key="row.label" class="probe__metric">
          <span>{{ row.label }}</span>
          <span>{{ row.value }}</span>
        </div>
      </div>

      <div class="probe__actions probe__actions--result">
        <button type="button" class="probe-btn" @click="copyReport">
          {{ copied ? '已复制' : '复制报告' }}
        </button>
        <button
          type="button"
          class="probe-btn"
          @click="showRaw = !showRaw"
        >
          {{ showRaw ? '收起纯文本' : '查看纯文本' }}
        </button>
      </div>

      <textarea
        v-if="showRaw"
        class="probe__raw"
        readonly
        rows="14"
        :value="result.report"
        @focus="selectRaw"
      ></textarea>

      <details class="probe__timeline">
        <summary>事件时间线（{{ result.events.length }}）</summary>
        <p
          v-for="(event, index) in result.events"
          :key="`${event.wall}-${index}`"
          class="probe__event"
        >
          +{{ (event.elapsed / 1000).toFixed(1) }}s · {{ event.name }}
          <span v-if="event.detail"> · {{ event.detail }}</span>
        </p>
      </details>
    </div>

    <p v-if="snapshot.error" class="probe__error">{{ snapshot.error }}</p>
  </div>
</template>

<style scoped>
.probe {
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.probe__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.probe__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--app-muted);
}

.probe__sub {
  margin: 5px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--app-muted);
}

.probe__badge {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--app-muted);
}

.probe__badge[data-phase='running'] {
  border-color: color-mix(in srgb, var(--app-accent) 40%, transparent);
  color: var(--app-accent);
}

.probe__steps {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.8;
  color: color-mix(in srgb, var(--app-fg) 76%, transparent);
}

.probe__note,
.probe__hint {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.65;
  color: var(--app-muted);
}

.probe__hint {
  padding: 8px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--app-accent) 6%, transparent);
  color: color-mix(in srgb, var(--app-accent) 78%, var(--app-muted));
}

.probe__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.probe-btn {
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid var(--app-line);
  border-radius: 999px;
  background: var(--app-bg);
  color: var(--app-fg);
  font-size: 12px;
  letter-spacing: 0.03em;
}

.probe-btn--primary {
  border-color: transparent;
  background: var(--app-accent);
  color: var(--app-bg);
}

.probe-btn:active {
  transform: scale(0.98);
}

.probe__live {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-fg) 4%, transparent);
}

.probe__live-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
}

.probe__live-head span {
  color: var(--app-accent);
  font-variant-numeric: tabular-nums;
}

.probe__live-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  font-size: 11px;
  line-height: 1.8;
  color: var(--app-muted);
}

.probe__live-row span:last-child {
  color: var(--app-fg);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.probe__result {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--app-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-fg) 3%, transparent);
}

.probe__result.is-ok {
  border-color: color-mix(in srgb, #3f7d4f 34%, transparent);
  background: color-mix(in srgb, #3f7d4f 6%, transparent);
}

.probe__result.is-warn {
  border-color: color-mix(in srgb, #b07a2c 38%, transparent);
  background: color-mix(in srgb, #b07a2c 6%, transparent);
}

.probe__result.is-bad {
  border-color: color-mix(in srgb, #a3412c 34%, transparent);
  background: color-mix(in srgb, #a3412c 5%, transparent);
}

.probe__verdict {
  display: block;
  font-size: 13px;
  letter-spacing: 0.03em;
}

.probe__verdict-detail {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: color-mix(in srgb, var(--app-fg) 78%, transparent);
}

.probe__metrics {
  display: grid;
  gap: 6px;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px dashed color-mix(in srgb, var(--app-fg) 12%, transparent);
}

.probe__metric {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  font-size: 11px;
  color: var(--app-muted);
}

.probe__metric span:last-child {
  color: var(--app-fg);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.probe__actions--result {
  margin-top: 10px;
}

.probe__raw {
  width: 100%;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--app-line);
  border-radius: 10px;
  background: var(--app-bg);
  color: var(--app-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.6;
  resize: vertical;
}

.probe__timeline {
  margin-top: 10px;
  font-size: 10.5px;
  color: var(--app-muted);
}

.probe__timeline summary {
  cursor: pointer;
  color: var(--app-muted);
}

.probe__event {
  margin: 6px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.probe__error {
  margin: 8px 0 0;
  font-size: 11px;
  color: color-mix(in srgb, #c25a3f 82%, var(--app-fg));
}
</style>
