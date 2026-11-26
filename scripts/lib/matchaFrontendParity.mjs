import { prepareFrontendSpeechText } from './frontendSpeech.mjs'
import { planTokenStream } from './acousticCases.mjs'

export const MATCHA_FRONTEND_PROTOCOL = 'matcha-frontend-parity-v1'
export const MATCHA_FRONTEND_VERSION = 'matcha-g2p-v1'

const OMISSION_REASONS = new Set([
  'sentence-boundary-no-token',
  'word-boundary-no-token',
  'runtime-oov-skipped',
  'native-managed-text',
])

export const MATCHA_FRONTEND_CASES = Object.freeze([
  {
    id: 'chinese-date',
    label: '中文日期与数词',
    source: 'prepared',
    input: '二零二六年十一月二十六日。',
    expectedDecision: 'g2p',
    nativeTokens: ['er4', 'ling2', 'er4', 'liu4', 'nian2', 'shi2', 'yi1', 'yue4', 'er4', 'shi2', 'liu4', 'ri4', '.'],
  },
  {
    id: 'arabic-date',
    label: '阿拉伯日期与页码整句回退',
    source: 'prepared',
    input: '2026年11月26日，第123页。',
    expectedDecision: 'native-fallback',
    nativeTokens: [
      'er4', 'ling2', 'er4', 'liu4', 'nian2', 'shi2', 'yi1', 'yue4', 'er4', 'shi2', 'liu4', 'ri4', ',',
      'di4', 'yi4', 'bai3', 'er4', 'shi2', 'san1', 'ye4', '.',
    ],
  },
  {
    id: 'decimal-number',
    label: '小数整句回退',
    source: 'prepared',
    input: '价格是123.45元。',
    expectedDecision: 'native-fallback',
    nativeTokens: [
      'jia4', 'ge2', 'shi4', 'yi4', 'bai3', 'er4', 'shi2', 'san1',
      'dian3', 'si4', 'wu3', 'yuan2', '.',
    ],
  },
  {
    id: 'tone-sandhi-yi',
    label: '“一”变调',
    source: 'prepared',
    input: '一个人。',
    expectedDecision: 'g2p',
    nativeTokens: ['yi2', 'ge4', 'ren2', '.'],
  },
  {
    id: 'tone-sandhi-bu',
    label: '“不”变调前字族',
    source: 'prepared',
    input: '不去重庆。',
    expectedDecision: 'g2p',
    nativeTokens: ['bu4', 'qu4', 'chong2', 'qing4', '.'],
  },
  {
    id: 'punctuation',
    label: '中英标点、分号与省略号',
    source: 'prepared',
    input: '你好，世界！再见；然后……',
    expectedDecision: 'g2p',
    nativeTokens: [
      'ni2', 'hao3', ',', 'shi4', 'jie4', '!', 'zai4', 'jian4',
      'ran2', 'hou4', '.', '.', '.', '.', '.', '.',
    ],
  },
  {
    id: 'quotes',
    label: '引号 OOV 丢弃但正文完整',
    source: 'prepared',
    input: '“你好，”她说。',
    expectedDecision: 'g2p',
    nativeTokens: ['ni2', 'hao3', ',', 'ta1', 'shuo1', '.'],
  },
  {
    id: 'word-joiner',
    label: 'U+200B 词界保护',
    source: 'direct',
    input: '学\u200b会计，重庆银行。',
    expectedDecision: 'g2p',
    nativeTokens: ['xue2', 'kuai4', 'ji4', ',', 'chong2', 'qing4', 'yin2', 'hang2', '.'],
  },
  {
    id: 'utterance-reset',
    label: 'U+2060 与词内边界',
    source: 'direct',
    input: '自己只是占了点\u2060\u200b地盘；',
    expectedDecision: 'g2p',
    nativeTokens: ['zi4', 'ji3', 'zhi3', 'shi4', 'zhan4', 'le', 'dian3', 'di4', 'pan2', '"'],
  },
  {
    id: 'punctuation-reset',
    label: '纯标点重置段保留零样本',
    source: 'direct',
    input: '“\u2060你好”',
    expectedDecision: 'g2p',
    nativeTokens: ['ni2', 'hao3'],
  },
  {
    id: 'raw-number-latin',
    label: '数字与拉丁版本号整句回退',
    source: 'prepared',
    input: '你好2，v1.2.3。',
    expectedDecision: 'native-fallback',
    nativeTokens: ['ni2', 'hao3', 'er4', ',', 'yi1', '.', 'er4', 'dian3', 'san1', '.'],
  },
  {
    id: 'uncovered-han',
    label: '未覆盖汉字硬失败',
    source: 'prepared',
    input: '你好，𠀀。',
    expectedDecision: 'reject',
    expectedError: '拒绝静默丢弃',
    nativeTokens: null,
  },
])

export function planMatchaFrontendCase(item, { assets, frontend, overlayText = assets.overlayText }) {
  const prepared = item.source === 'direct'
    ? { speechText: item.input }
    : prepareFrontendSpeechText(item.input, overlayText, frontend)
  try {
    const stream = planTokenStream(prepared.speechText, assets)
    const nativeManaged = stream.nativeManaged
    const decision = nativeManaged.length ? 'native-fallback' : 'g2p'
    return {
      id: item.id,
      label: item.label,
      source: item.source,
      input: item.input,
      normalizedText: prepared.normalizedText ?? null,
      speechText: prepared.speechText,
      decision,
      tokens: decision === 'g2p' ? stream.tokens : null,
      coverage: stream.coverage,
      omissions: stream.omitted,
      nativeManaged,
      error: null,
    }
  } catch (error) {
    return {
      id: item.id,
      label: item.label,
      source: item.source,
      input: item.input,
      normalizedText: prepared.normalizedText ?? null,
      speechText: prepared.speechText,
      decision: 'reject',
      tokens: null,
      coverage: null,
      omissions: [],
      nativeManaged: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function sameTokens(left, right) {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right)
}

export function validateMatchaFrontendReport(report, { requireNative = false } = {}) {
  const errors = []
  if (report?.protocol !== MATCHA_FRONTEND_PROTOCOL) errors.push('协议不匹配')
  if (!['frozen-snapshot', 'native-probe'].includes(report?.mode)) errors.push('模式无效')
  if (report?.listeningAccuracy !== null) errors.push('未试听实验不得填写 listeningAccuracy')
  const rows = Array.isArray(report?.cases) ? report.cases : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (rows.length !== MATCHA_FRONTEND_CASES.length) errors.push('Parity 案例数量不完整')
  if (byId.size !== rows.length) errors.push('存在重复案例 ID')
  for (const item of MATCHA_FRONTEND_CASES) {
    const row = byId.get(item.id)
    if (!row) {
      errors.push(`${item.id}：缺少案例`)
      continue
    }
    if (row.decision !== item.expectedDecision) errors.push(`${item.id}：前端决策与计划不一致`)
    if (row.omissions?.some((entry) => !OMISSION_REASONS.has(entry.reason))) {
      errors.push(`${item.id}：存在未分类的字符丢弃`)
    }
    if (item.expectedDecision === 'g2p') {
      if (!sameTokens(row.tokens, item.nativeTokens)) errors.push(`${item.id}：G2P token 与原生快照不一致`)
      if (row.nativeManaged?.length) errors.push(`${item.id}：G2P 案例不得含原生托管文本`)
      if (row.coverage?.ok !== true) errors.push(`${item.id}：汉字覆盖不完整`)
    } else if (item.expectedDecision === 'native-fallback') {
      if (row.tokens !== null) errors.push(`${item.id}：不得把原生托管文本冒充完整 token`)
      if (!row.nativeManaged?.length || row.nativeManaged.some((entry) => entry.reason !== 'native-managed-text')) {
        errors.push(`${item.id}：缺少明确的原生托管文本清单`)
      }
      if (row.coverage?.ok !== true) errors.push(`${item.id}：回退前汉字覆盖不完整`)
    } else if (!row.error?.includes(item.expectedError)) {
      errors.push(`${item.id}：未覆盖汉字未硬失败`)
    }
    if (requireNative && item.expectedDecision !== 'reject') {
      const native = row.nativeComparison
      if (!native?.captured || !sameTokens(native.tokens, item.nativeTokens)) {
        errors.push(`${item.id}：实时原生 token 与冻结快照不一致`)
      }
    }
  }
  return errors
}

export function renderMatchaFrontendSummary(report) {
  const lines = [
    '# Matcha 前端一致性报告', '',
    `- 协议：${report.protocol}`,
    `- 模式：${report.mode}`,
    '- 支持的中文 Matcha 请求默认走完整 token 直输；数字/拉丁片段整句回退，未覆盖汉字硬失败。',
    '- token 一致只证明模型输入一致，不替代真人听感验收。', '',
    '| 案例 | 决策 | 字符覆盖/回退证据 | 原生 token |',
    '| --- | --- | --- | --- |',
  ]
  for (const row of report.cases) {
    const evidence = row.decision === 'native-fallback'
      ? row.nativeManaged.map((entry) => JSON.stringify(entry.text)).join('')
      : row.decision === 'reject'
        ? row.error
        : `${row.coverage.phones}/${row.coverage.han} 汉字`
    lines.push(`| ${row.label} | ${row.decision} | ${evidence} | ${row.nativeComparison?.captured ? '实时一致' : '冻结快照'} |`)
  }
  return `${lines.join('\n')}\n`
}
