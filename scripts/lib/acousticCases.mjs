import { createHash } from 'node:crypto'
import { phoneticPhones } from './reading.mjs'
import { NON_PHONE } from './fusionRisk.mjs'
import { sentenceCoverage, stripWordBoundaries } from './omission.mjs'
import {
  buildTokenStream, planPcmSegments,
} from './naturalness.mjs'
import { prepareFrontendSpeechText } from './frontendSpeech.mjs'
import { UTTERANCE_RESET, WORD_BOUNDARY } from './wordFamily.mjs'
import { isIFinalPhone } from './vowelReduction.mjs'

export const ACOUSTIC_CASE_PROTOCOL = 'acoustic-cases-v1'
export const ACOUSTIC_CASE_VARIANTS = Object.freeze([
  'current', 'lead', 'tail', 'both', 'utterance-reset', 'segmented-pcm',
])
const HAN = /\p{Script=Han}/u

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function phoneCount(tokens) {
  return tokens.filter((token) => !NON_PHONE.has(token)).length
}

function neutralDiagnostics(tokens, neutrals) {
  const phones = tokens.flatMap((phone, tokenIndex) => {
    if (NON_PHONE.has(phone) || !/^[a-zv]+$/.test(phone)) return []
    return [{ tokenIndex, phone, trained: neutrals.has(phone) }]
  })
  return { phones, untrained: phones.filter((item) => !item.trained) }
}

export function planTokenStream(text, assets, word = '') {
  const stream = buildTokenStream(text, assets.effective, assets.tokens, { allowNativeManagedText: true })
  const coverage = sentenceCoverage(stream, text)
  const range = stream.ranges.find((item) => item.word === word) ?? null
  const phones = range
    ? phoneticPhones(assets.effective.get(range.word))
    : stream.tokens.filter((token) => !NON_PHONE.has(token))
  const nativeManaged = stream.omitted.filter((item) => item.reason === 'native-managed-text')
  return { ...stream, coverage, range, phones, count: phones.length, nativeManaged }
}

/** Keep punctuation-only reset parts as zero-sample segments, matching the worker join. */
export function planUtteranceReset(text, word, assets) {
  const parts = String(text).split(UTTERANCE_RESET).map((part) => part.trim()).filter(Boolean)
  const targetIndex = parts.findIndex((part) => part.replaceAll(WORD_BOUNDARY, '').includes(word))
  const streams = parts.map((part, index) => {
    try {
      return planTokenStream(part, assets, index === targetIndex ? word : '')
    } catch (error) {
      if (error instanceof Error && error.message === '空 token 流') return null
      throw error
    }
  })
  return { parts, streams, targetIndex, target: targetIndex >= 0 ? streams[targetIndex] : null }
}

export function findWordOccurrences(text, word) {
  const source = Array.from(String(text))
  const target = Array.from(String(word))
  const occurrences = []
  if (!target.length) return occurrences
  for (let start = 0; start <= source.length - target.length; start += 1) {
    if (target.every((char, offset) => source[start + offset] === char)) {
      occurrences.push({ word, start, end: start + target.length })
    }
  }
  return occurrences
}

export function planFamilyExclusions(c, assets) {
  const target = Array.from(c.word)
  const exclusions = []
  for (const [word, reading] of assets.effective) {
    const chars = Array.from(word)
    if (chars.length <= target.length) continue
    const phones = phoneticPhones(reading)
    if (phones.length !== chars.length) continue
    const offsets = []
    for (let start = 0; start <= chars.length - target.length; start += 1) {
      if (!target.every((char, offset) => chars[start + offset] === char)) continue
      if (phones[start + c.offset] !== c.phone) offsets.push(start)
    }
    if (offsets.length) exclusions.push({ word, offsets })
  }
  return exclusions
}

export function findFamilyOccurrences(text, words, exclusions = []) {
  const value = String(text)
  const source = Array.from(value)
  const eligible = words.flatMap((word) => findWordOccurrences(value, word))
    .filter((occurrence) => !exclusions.some((exclusion) => {
      const chars = Array.from(exclusion.word)
      return exclusion.offsets.some((offset) => {
        const start = occurrence.start - offset
        return start >= 0
          && source.slice(start, start + chars.length).join('') === exclusion.word
      })
    }))
  return eligible.filter((occurrence) => !eligible.some((other) =>
    other !== occurrence
    && other.start <= occurrence.start
    && other.end >= occurrence.end
    && other.end - other.start > occurrence.end - occurrence.start))
}

export function locateFamilyTarget(part, occurrence, c, assets) {
  const stream = planTokenStream(part, assets)
  const charPhones = new Map()
  for (const range of stream.ranges) {
    if (!assets.effective.has(range.word)) continue
    const rawTokens = String(assets.effective.get(range.word)).split(/\s+/).filter(Boolean)
    const rangeTokens = stream.tokens.slice(range.start, range.end)
    if (JSON.stringify(rawTokens) !== JSON.stringify(rangeTokens)) {
      return { ok: false, reason: `${range.word} token 与词典读音不一致` }
    }
    let phoneOffset = 0
    rawTokens.forEach((token, index) => {
      if (token === '"') return
      charPhones.set(range.charOffset + phoneOffset, {
        phone: token, tokenIndex: range.start + index, range,
      })
      phoneOffset += 1
    })
    if (phoneOffset !== Array.from(range.word).length) {
      return { ok: false, reason: `${range.word} 音素与字数不一致` }
    }
  }
  const targets = []
  const sourceChars = Array.from(part)
  for (let offset = occurrence.start; offset < occurrence.end; offset += 1) {
    if (sourceChars[offset] === WORD_BOUNDARY) continue
    const target = charPhones.get(offset)
    if (!target) return { ok: false, reason: `${occurrence.word} 缺少连续字符 token` }
    targets.push(target)
  }
  const expectedIndices = new Set(targets.map((target) => target.tokenIndex))
  for (let index = targets[0].tokenIndex; index <= targets.at(-1).tokenIndex; index += 1) {
    if (stream.tokens[index] !== '"' && !expectedIndices.has(index)) {
      return { ok: false, reason: `${occurrence.word} 跨非词界 token，无法作为连续字族目标测量` }
    }
  }
  const target = targets[c.offset]
  if (target.phone !== c.phone) {
    return {
      ok: false,
      reason: `${occurrence.word} 目标音素漂移：期望 ${c.phone}，实际 ${target.phone}（覆盖词 ${target.range.word}）`,
    }
  }
  const coveredBy = [...new Set(targets.map((item) => item.range.word))].join(' + ')
  return {
    ok: true,
    word: occurrence.word,
    group: part,
    tokens: stream.tokens,
    start: targets[0].tokenIndex,
    count: targets.length,
    coveredBy,
    targetCoveredBy: target.range.word,
    targetPhoneIndex: c.offset,
    nativeManaged: stream.nativeManaged,
  }
}

function edgeVariant(kind, stream) {
  const base = stripWordBoundaries(stream.tokens, stream.range.start, stream.count)
  const start = stream.range.start
  const tokens = [...base]
  if (kind === 'lead' || kind === 'both') tokens.splice(start, 0, '"')
  if (kind === 'tail' || kind === 'both') tokens.splice(start + stream.count + (kind === 'both' ? 1 : 0), 0, '"')
  return {
    id: kind,
    label: { lead: '词首边界', tail: '词尾边界', both: '词首 + 词尾边界' }[kind],
    kind: 'boundary',
    tokens,
    start,
    count: stream.count,
    targetPhones: stream.phones,
    forbidden: kind === 'tail' && stream.count >= 3
      ? '三字及以上词禁用自动词尾边界；仅作诊断测量'
      : null,
  }
}

function resetVariant(text, word) {
  const index = text.indexOf(word)
  const before = index < 0 ? '' : text.slice(0, index)
  const after = index < 0 ? text : text.slice(index)
  return {
    id: 'utterance-reset',
    label: '真实语句重置（Worker 独立合成 + 120ms 拼接）',
    kind: 'utterance-reset',
    resetText: index < 0 ? text : `${before}${UTTERANCE_RESET}${after}`,
    comparable: Boolean(index >= 0 && before.trim()),
    reason: index < 0 ? '无法定位目标词' : before.trim() ? null : '目标已在组块开头，当前方案已包含等价语句重置',
  }
}

function segmentedVariant(text, word, assets) {
  const merged = []
  for (const segment of planPcmSegments(text)) {
    const speakable = /[\p{Script=Han}\p{Letter}\p{Number}]/u.test(segment.text)
    if (!speakable && merged.length) {
      const previous = merged[merged.length - 1]
      previous.text += segment.text
      previous.punctuation = `${previous.punctuation ?? ''}${segment.punctuation ?? ''}`
      previous.pauseAfterMs = segment.pauseAfterMs
    } else if (speakable || segment.pauseAfterMs > 0) {
      merged.push({ ...segment })
    }
  }
  const segments = merged.map((segment) => {
    const stream = planTokenStream(segment.text, assets, word)
    return { ...segment, ...stream }
  })
  const target = segments.find((segment) => segment.ranges.some((range) => range.word === word))
  return {
    id: 'segmented-pcm',
    label: '按标点分段 PCM + 显式停延',
    kind: 'segmented-pcm',
    segments,
    targetSegmentIndex: target ? segments.indexOf(target) : -1,
    comparable: Boolean(target),
    reason: target ? null : '目标词不在有效分段中',
  }
}

export function validateAcousticCase(c) {
  const errors = []
  const word = typeof c?.word === 'string' ? c.word : ''
  const char = typeof c?.char === 'string' ? c.char : ''
  if (!c?.id) errors.push('缺少案例 id')
  if (!word || !Array.from(word).every((item) => HAN.test(item))) errors.push('缺少纯汉字目标词')
  if (Array.from(char).length !== 1 || !HAN.test(char)) errors.push('目标字不是单个汉字')
  if (!Number.isInteger(c.offset) || c.offset < 0 || c.offset >= Array.from(word).length) errors.push('目标字偏移无效')
  if (Array.from(word)[c.offset] !== char) errors.push('目标字与词内偏移不一致')
  const contexts = [...(c.sentences ?? []), ...(c.contexts ?? []), ...(c.advisorySentences ?? [])]
  if (!contexts.length) errors.push('缺少完整反馈原句或真实上下文')
  if (!contexts.every((sentence) => typeof sentence === 'string' && sentence.trim())) errors.push('上下文必须是非空完整原句')
  return errors
}

/** Re-runs the production text chain and keeps the exact U+2060 target group. */
export async function planAcousticCase(c, { assets, frontend, overlayText }) {
  const errors = validateAcousticCase(c)
  if (errors.length) throw new Error(`${c?.id ?? '未知案例'}：${errors.join('；')}`)
  const contexts = []
  for (const [source, sentences] of [
    ['feedback', c.sentences ?? []], ['book', c.contexts ?? []], ['advisory', c.advisorySentences ?? []],
  ]) {
    for (const sentence of sentences) {
      if (contexts.some((item) => item.sentence === sentence)) continue
      const prepared = prepareFrontendSpeechText(sentence, overlayText, frontend)
      const full = planTokenStream(prepared.speechText, assets)
      if (!full.coverage.ok) {
        throw new Error(`${c.id}：完整原句 token 覆盖不全（${full.coverage.phones}/${full.coverage.han}）`)
      }
      const parts = prepared.speechText.split(UTTERANCE_RESET).map((part) => part.trim()).filter(Boolean)
      const targetPartIndex = parts.findIndex((part) => part.replaceAll(WORD_BOUNDARY, '').includes(c.word))
      if (targetPartIndex < 0) throw new Error(`${c.id}：实际组块中无法定位「${c.word}」`)
      const text = parts[targetPartIndex]
      const stream = planTokenStream(text, assets, c.word)
      const range = stream.ranges.find((item) => item.word === c.word)
      if (!range) throw new Error(`${c.id}：token 流中无法定位「${c.word}」`)
      if (stream.phones[c.offset] !== c.phone) {
        throw new Error(`${c.id}：目标音素漂移，期望 ${c.phone}，实际 ${stream.phones[c.offset]}`)
      }
      const target = {
        word: c.word, char: c.char, offset: c.offset, phone: c.phone,
        tokenStart: range.start, tokenEnd: range.end, count: stream.count,
        phones: stream.phones,
      }
      const segmented = segmentedVariant(text, c.word, assets)
      const variants = [
        {
          id: 'current', label: '当前生产方案', kind: 'current',
          tokens: stream.tokens, start: range.start, count: stream.count,
          targetPhones: stream.phones, forbidden: null,
        },
        edgeVariant('lead', stream), edgeVariant('tail', stream), edgeVariant('both', stream),
        resetVariant(text, c.word), segmented,
      ]
      contexts.push({
        source, sentence,
        textChain: {
          normalizedText: prepared.normalizedText,
          plannedText: prepared.plannedText,
          speechText: prepared.speechText,
        },
        actualGroup: {
          partIndex: targetPartIndex,
          partCount: parts.length,
          text,
          parts: parts.map((part, index) => ({ partIndex: index, text: part, target: index === targetPartIndex })),
          split: parts.length > 1,
        },
        tokenStream: {
          tokens: stream.tokens,
          sha256: sha256(JSON.stringify(stream.tokens)),
          inventoryValid: true,
          coverage: stream.coverage,
        },
        fullSentenceCoverage: full.coverage,
        neutralDiagnostics: neutralDiagnostics(stream.tokens, assets.neutrals),
        target,
        variants,
      })
    }
  }
  const neutral = !/[0-5]$/.test(c.phone)
  return {
    id: c.id,
    source: c.source ?? 'unknown',
    status: c.status ?? 'needs-listening',
    word: c.word,
    char: c.char,
    offset: c.offset,
    phone: c.phone,
    note: c.note ?? '',
    contexts,
    diagnostics: {
      iFinal: isIFinalPhone(c.phone),
      untrainedNeutral: neutral && !assets.neutrals.has(c.phone),
      neutralPhone: neutral ? c.phone : null,
    },
    family: planWordFamily(c, assets),
  }
}

export function planWordFamily(c, assets) {
  const words = [...assets.effective.entries()]
    .filter(([word, reading]) => {
      const chars = Array.from(word)
      if (chars.length < 2 || chars.length > 6 || !chars.every((char) => HAN.test(char))) return false
      const phones = phoneticPhones(reading)
      return phones.length === chars.length && chars[c.offset] === c.char && phones[c.offset] === c.phone
    })
    .map(([word, reading]) => ({ word, reading, current: word === c.word }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.word.localeCompare(b.word, 'zh'))
  return {
    char: c.char,
    offset: c.offset,
    phone: c.phone,
    words,
    scope: '同字、同词内偏移、同音素；异读词不纳入',
  }
}

export function compareNativeTokens(context, nativeTokenization) {
  if (!nativeTokenization?.captured) {
    return { ok: false, captured: false, status: 'unmeasurable', reason: '原生前端未返回 token 调试日志' }
  }
  const expected = Array.isArray(context.tokenStream?.tokens) ? context.tokenStream.tokens : []
  const actual = Array.isArray(nativeTokenization.tokens) ? nativeTokenization.tokens : []
  const sentences = nativeTokenization.sentences
  const sentencesValid = Array.isArray(sentences)
    && sentences.length > 0
    && sentences.every((tokens) => Array.isArray(tokens))
  const loggedTokens = sentencesValid ? sentences.flat() : []
  const tokensMatchLog = JSON.stringify(actual) === JSON.stringify(loggedTokens)
  const match = sentencesValid && tokensMatchLog && JSON.stringify(expected) === JSON.stringify(actual)
  const reason = !sentencesValid
    ? '原生 token 日志句结构无效；停止声学比较'
    : !tokensMatchLog
      ? '原生 tokens 与调试日志句不一致；停止声学比较'
      : match ? null : '重建 token 与原生 Matcha 前端不一致；停止声学比较'
  return {
    ok: match,
    captured: true,
    status: match ? 'match' : 'mismatch',
    expected,
    actual,
    expectedPhones: phoneCount(expected),
    actualPhones: phoneCount(actual),
    sentences,
    reason,
  }
}

export function rankAcousticVariants(variants) {
  const comparable = variants.filter((item) =>
    item.comparable !== false && !item.forbidden && item.measurement?.values?.length)
  return [...comparable].sort((left, right) =>
    right.measurement.score - left.measurement.score
    || Number(left.measurement.states.includes('swallowed')) - Number(right.measurement.states.includes('swallowed'))
    || left.id.localeCompare(right.id))
}

function nativeAgreementValid(context) {
  const comparison = context.nativeComparison
  const expected = context.tokenStream?.tokens
  if (comparison?.captured !== true || comparison.ok !== true || comparison.status !== 'match') return false
  if (!Array.isArray(expected) || !Array.isArray(comparison.expected) || !Array.isArray(comparison.actual)) return false
  if (!Array.isArray(comparison.sentences) || !comparison.sentences.length
    || !comparison.sentences.every((tokens) => Array.isArray(tokens))) return false
  return JSON.stringify(expected) === JSON.stringify(comparison.expected)
    && JSON.stringify(expected) === JSON.stringify(comparison.actual)
    && JSON.stringify(comparison.actual) === JSON.stringify(comparison.sentences.flat())
}

export function validateAcousticCaseManifest(manifest) {
  const errors = []
  if (manifest?.protocol !== ACOUSTIC_CASE_PROTOCOL) errors.push('协议不匹配')
  if (!['structural-verify', 'measure'].includes(manifest?.mode)) errors.push('模式无效')
  if (!Array.isArray(manifest?.cases)) return [...errors, 'cases 不是数组']
  const ids = new Set()
  for (const item of manifest.cases) {
    if (ids.has(item.id)) errors.push(`重复案例 ${item.id}`)
    ids.add(item.id)
    if (!Array.isArray(item.contexts) || !item.contexts.length) errors.push(`${item.id}：缺少完整上下文`)
    for (const context of item.contexts ?? []) {
      if (!context.sentence || !context.actualGroup?.text) errors.push(`${item.id}：缺少原句或实际组块`)
      const tokens = context.tokenStream?.tokens
      if (context.tokenStream?.inventoryValid !== true
        || !Array.isArray(tokens)
        || !tokens.length
        || context.tokenStream.sha256 !== sha256(JSON.stringify(tokens))
        || context.fullSentenceCoverage?.ok !== true) {
        errors.push(`${item.id}：token 完整性未通过`)
      }
      const variants = Array.isArray(context.variants) ? context.variants : []
      if (variants.map((variant) => variant.id).join(',') !== ACOUSTIC_CASE_VARIANTS.join(',')) {
        errors.push(`${item.id}：六种比较方案不完整`)
      }
      if (manifest.mode === 'measure') {
        if (!nativeAgreementValid(context)) errors.push(`${item.id}：测量模式缺少可信的原生 token 一致性证据`)
        for (const variant of variants) {
          const required = ['current', 'lead', 'tail', 'both'].includes(variant.id)
          if (variant.comparable === false) {
            if (required || typeof variant.reason !== 'string' || !variant.reason.trim()) {
              errors.push(`${item.id}：${variant.id} 不可比较状态无效`)
            }
            continue
          }
          const values = variant.measurement?.values
          if (!Array.isArray(values)
            || values.length !== context.target?.count
            || !values.every((value) => Number.isFinite(value))
            || !Number.isFinite(variant.measurement?.score)
            || !Array.isArray(variant.measurement?.states)) {
            errors.push(`${item.id}：${variant.id} 缺少有效声学测量`)
          }
        }
      } else if (context.nativeComparison && !nativeAgreementValid(context)) {
        errors.push(`${item.id}：原生 token 不匹配`)
      }
    }
  }
  if (manifest.listeningAccuracy !== null) errors.push('未试听实验不得填写 listeningAccuracy')
  return errors
}

export function renderAcousticCaseSummary(manifest) {
  const lines = [
    '# 山岚统一声学案例报告（advisory）', '',
    `- 协议：${manifest.protocol}`,
    `- 案例 ${manifest.cases.length} · 上下文 ${manifest.cases.reduce((sum, item) => sum + item.contexts.length, 0)}`,
    '- 顺序：完整原句 → 生产文本链与实际 U+2060 组块 → token 完整性 → 原生 token 一致性 → 六方案测量 → 字族/整书回归。',
    '- 贡献 <100ms 记为吞音，>350ms 记为合并；F2、包络和轻声只用于排序。所有候选仍须用户亲耳试听。',
    '', '| 案例 | 语境 | 原生 token | 当前贡献 ms | 声学排序（非听感结论） | 待复听 |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const item of manifest.cases) {
    for (const context of item.contexts) {
      const current = context.variants.find((variant) => variant.id === 'current')
      const ranking = context.advisoryRanking?.map((entry) => entry.id).join(' > ') || '—'
      const values = current?.measurement?.values?.join('/') || '—'
      lines.push(`| ${item.id} | ${context.source}：${context.sentence.replace(/\|/g, '\\|')} | ${context.nativeComparison?.status ?? '未测'} | ${values} | ${ranking} | 是 |`)
    }
  }
  lines.push('', '## 声学诊断（advisory）', '',
    '| 案例 | 语境 | /i/ 风险音节 | 未训练轻声 token | 非 ok 包络方案 |',
    '| --- | --- | --- | ---: | --- |')
  for (const item of manifest.cases) {
    for (const context of item.contexts) {
      const iRisk = (context.iFinal ?? []).filter((entry) => entry.risk)
        .map((entry) => `${entry.phone}@${entry.tokenIndex}`).join(', ') || '—'
      const neutrals = context.neutralDiagnostics?.untrained?.length ?? 0
      const envelope = context.variants.filter((variant) => variant.envelope && variant.envelope.verdict !== 'ok')
        .map((variant) => `${variant.id}:${variant.envelope.verdict}`).join(', ') || '—'
      lines.push(`| ${item.id} | ${context.source} | ${iRisk} | ${neutrals} | ${envelope} |`)
    }
  }
  lines.push('', '## 字族与整书回归', '',
    '字族按同字、同偏移、同音素扩展；异读排除。整书回归只在显式传入 --corpus 时运行，否则报告为 not-run，不冒充已回归。',
    '原生托管数字/字母保留源位置并验证汉字覆盖，但不伪造完整 token，相关组块只做结构回归。',
    '', '| 案例 | 字族词数 | 整书匹配句 | 测量句 | 原生托管跳过 | 状态 |', '| --- | ---: | ---: | ---: | ---: | --- |')
  for (const item of manifest.cases) {
    const regression = item.familyRegression
    lines.push(`| ${item.id} | ${item.family.words.length} | ${regression?.matchedSentences ?? '—'} | ${regression?.measuredSentences ?? '—'} | ${regression?.nativeManagedSentences ?? '—'} | ${regression?.status ?? 'not-run'} |`)
  }
  lines.push('', '> 本报告不修改词典、边界、分组或噪声/静音参数。试听结论请写入 --listening 指定的清单后再决定是否进入修复流程。', '')
  return lines.join('\n')
}
