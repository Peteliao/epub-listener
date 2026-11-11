#!/usr/bin/env node
// Dev-only / CI: word-family pronunciation audit for the 山岚 (matcha) voice.
//
// DIFFERENT APPROACH (2026-11-11, 6th round).
// The previous five rounds all asked "which phone should this word get?" and
// validated with hand-copied token streams. `pian2` / `di4` were always correct,
// so every gate stayed green while the listener heard a garbled syllable.
// This gate instead rebuilds the *runtime data path* word by word:
//   1. worker.patchLexicon's final dictionary (base lines dropped, overlay
//      rows appended in AiModel.ts order, Matcha map = LAST line wins);
//   2. preparePronunciationText's U+200B / U+2060 markers and the resulting
//      longest-match token stream (sentenceCoverage forbids truncated streams);
//   3. real WASM synthesis: per-phone duration ablation + audible WAV from
//      generateText() on the marked text, split exactly like the worker.
//
// Modes:
//   --verify    hard gate (default): structure + lexicon + token + runtime +
//               real-WASM per-word syllable checks; exit 1 on any failure
//   --baseline  report the current (possibly broken) state without failing,
//               used to reproduce why the earlier fixes did not take effect
//   --measure   also measure every context and emit the full numeric report
//   --audio     write before/after WAVs + listen.html to scripts/out/audio/
//   --static    skip WASM (fast structural debugging)
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pinyin } from 'pinyin-pro'
import {
  ROOT,
  loadMatchaAssets,
  parseEntries,
  parseOverlay,
  phoneticPhones,
  readingAt,
  TRAINED_NEUTRAL_PHONES,
} from './lib/reading.mjs'
import { phoneIndices } from './lib/fusionRisk.mjs'
import { currentBoundary } from './lib/omission.mjs'
import { summarizeContributions } from './lib/acousticScoring.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import {
  WORD_FAMILY,
  EXCLUSIONS,
  STEAL_CASES,
  STEAL_EXCLUSIONS,
  LONG_CASES,
  LONG_EXCLUSIONS,
  DI_CASES,
  FEEDBACK_SENTENCE,
  BOOK_BLOCK,
  DIPAN_SENTENCE,
  WORD_BOUNDARY,
  UTTERANCE_RESET,
  buildRuntimeLexicon,
  loadWordLists,
  prepareRuntimeText,
  utteranceParts,
  streamFor,
  coverageOf,
  spanOf,
  overlayRows,
  readAsset,
  appSegments,
} from './lib/wordFamily.mjs'

const OUT_DIR = join(ROOT, 'scripts', 'out')
const AUDIO_DIR = join(OUT_DIR, 'audio', 'word-family')
const LEXICON_DIR = join(OUT_DIR, 'word-family')
const HISTORICAL_CURATED = ['大便宜', '占便宜', '地盘', '地盘之争']
const FAMILY_WORDS = WORD_FAMILY.map((item) => item.word)
// A pinyin-pro-style per-book overlay, used ONLY as a reproducible probe of the
// merge-order defect. It is never written into the app's assets; the word-by-word
// checks below use the real current dictionary (no per-book overlay on a fresh
// checkout). Note pinyin-pro emits `yi0` here while tokens.txt / the trained
// neutral list only contain `yi` — an untrained neutral is exactly the kind of
// garbled/silent syllable the listener reported.
const PROBE_BOOK_OVERLAY = [
  ...FAMILY_WORDS.map((word) => `${word} ${pinyin(word, { toneType: 'num', type: 'array' }).join(' ')}`),
  '便宜 pian2 yi',
].join('\n')

function parseArgs(argv) {
  const options = {
    mode: 'verify', audio: false, static: false,
    out: join(OUT_DIR, 'word-family-report.json'),
    summary: join(OUT_DIR, 'word-family-report.md'),
  }
  for (const arg of argv) {
    if (arg === '--baseline') options.mode = 'baseline'
    else if (arg === '--measure') options.mode = 'measure'
    else if (arg === '--verify') options.mode = 'verify'
    else if (arg === '--audio') options.audio = true
    else if (arg === '--static') options.static = true
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node scripts/audit-word-family.mjs [--verify|--baseline|--measure] [--audio] [--static]

  --verify    必需门禁：运行时词典/整词命中/标记/排除项 + 真实 WASM 逐词音节验收
  --baseline  只输出归因与现状（修复前用它复现「判通过却仍读怪音」）
  --measure   逐词测量全部语境并输出完整数值
  --audio     生成修复前后 WAV 与 listen.html
  --static    跳过 WASM（仅调试静态检查）
产物：scripts/out/word-family-report.json / .md、scripts/out/audio/word-family/`)
      process.exit(0)
    }
  }
  if (options.mode === 'measure' || options.mode === 'baseline') options.audio = options.audio || false
  return options
}

function check(list, group, name, ok, detail) {
  list.push({ group, name, ok: Boolean(ok), detail })
}

/** Count voiced energy islands in a waveform (see verify-listening-fixes.mjs). */
function voicedIslands(samples, rate) {
  const win = Math.floor(0.02 * rate)
  const envelope = []
  for (let i = 0; i + win < samples.length; i += win) {
    let energy = 0
    for (let j = i; j < i + win; j += 1) energy += samples[j] * samples[j]
    envelope.push(Math.sqrt(energy / win))
  }
  const threshold = Math.max(...envelope) * 0.25
  let count = 0
  let above = false
  let gaps = 0
  for (const value of envelope) {
    if (value > threshold) {
      if (!above) count += 1
      above = true
      gaps = 0
    } else if (above) {
      gaps += 1
      if (gaps >= 3) above = false
    }
  }
  return count
}

/** Insert 120ms of silence between utterance parts, mirroring joinUtteranceAudio. */
function joinParts(rendered, rate) {
  const gap = new Float32Array(Math.round(rate * 0.12))
  const total = rendered.reduce((sum, part) => sum + part.length, 0)
    + gap.length * (rendered.length - 1)
  const joined = new Float32Array(total)
  let offset = 0
  for (const part of rendered) {
    joined.set(part, offset)
    offset += part.length + gap.length
  }
  return joined
}

/** Render the text the app actually sends, including the U+2060 split. */
function renderPrepared(synth, prepared) {
  const parts = utteranceParts(prepared)
  if (!parts) {
    return synth.generateText(prepared.replaceAll(UTTERANCE_RESET, '')).samples
  }
  return joinParts(parts.map((part) => synth.generateText(part).samples), synth.sampleRate)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()
  const curatedText = readAsset('src/core/tts/polyphones.v1.txt')
  const aiModelText = readAsset('src/core/tts/AiModel.ts')
  const lists = loadWordLists()
  const checks = []
  const attribution = {}

  // ---- 1. Structural: the overlay merge order ----------------------------
  // Runtime (worker.patchLexicon + Matcha map) uses LAST-line-wins; the audit
  // helpers (reading.mjs parseOverlay) used FIRST-line-wins. With the old
  // AiModel.ts order [curated, bookOverlay] a per-book row silently overrode a
  // hand-verified row in the app while every gate still saw the curated row.
  const legacy = buildRuntimeLexicon({
    lexiconText: assets.lexiconText,
    curatedText,
    bookText: PROBE_BOOK_OVERLAY,
    curatedFirst: true,
  })
  const shadowed = FAMILY_WORDS.filter((word) => {
    const inBook = overlayRows(PROBE_BOOK_OVERLAY).some((line) => line.split(/\s+/)[0] === word)
    const inCurated = assets.overlay.entries.has(word)
    return inBook && inCurated
      && legacy.runtimeMap.get(word) !== legacy.auditMap.get(word)
  })
  attribution.mergeOrder = {
    app: 'worker.patchLexicon: base rows removed, overlay rows appended, Matcha map = last line wins',
    audit: 'scripts/lib/reading.mjs parseOverlay: first line wins',
    aiModelUsesDedupMerge: /mergeLexiconOverlays\s*\(/.test(aiModelText),
    wordsWhereAuditDisagreedWithRuntimeUnderOldOrder: shadowed,
    note: shadowed.length
      ? '旧顺序下整书 overlay 覆盖人工表，而门禁读到的是人工表：音素门禁全绿但 App 读怪音'
      : '当前顺序下两模型一致',
    legacyProbe: Object.fromEntries(FAMILY_WORDS.map((word) => [word, {
      appHeard: legacy.runtimeMap.get(word) ?? null,
      gateSaw: legacy.auditMap.get(word) ?? null,
      neutralPhoneTrained: TRAINED_NEUTRAL_PHONES.has(
        (legacy.runtimeMap.get(word) ?? '').split(/\s+/).filter((p) => p && p !== '"').slice(-1)[0] ?? '',
      ),
    }])),
  }
  check(checks, '结构', 'AiModel 用去重合并，人工覆盖表优先于整书自动生成表',
    attribution.mergeOrder.aiModelUsesDedupMerge,
    attribution.mergeOrder.aiModelUsesDedupMerge
      ? 'mergeLexiconOverlays 已接线'
      : '仍是 [polyphoneOverlay, bookOverlay] 直接拼接，整书表可盖掉人工表')

  // Behaviour-level check against the REAL runtime function when Node supports
  // type stripping (Node >= 22.18). vitest covers the same function in CI.
  let mergeFn = null
  try {
    const module = await import(new URL('../src/core/tts/pinyinTones.ts', import.meta.url).href)
    mergeFn = module.mergeLexiconOverlays ?? null
  } catch {
    mergeFn = null
  }
  if (mergeFn) {
    const probeCurated = [
      ...FAMILY_WORDS.map((word) => `${word} ${assets.overlay.entries.get(word) ?? assets.lexicon.get(word) ?? '?'}`),
    ].filter((line) => !line.endsWith('?')).join('\n')
    const merged = mergeFn(probeCurated, PROBE_BOOK_OVERLAY)
    const runtimeMap = parseEntries(merged)
    const auditMap = parseOverlay(merged).entries
    const conflicts = FAMILY_WORDS.filter((word) =>
      assets.overlay.entries.has(word)
      && (runtimeMap.get(word) !== assets.overlay.entries.get(word)
        || auditMap.get(word) !== assets.overlay.entries.get(word)))
    check(checks, '结构', '人工表读音在运行时与审计模型下都生效（真实 mergeLexiconOverlays 行为）',
      conflicts.length === 0,
      conflicts.length ? `冲突：${conflicts.join('、')}` : `${FAMILY_WORDS.length} 个词均无冲突`)
    attribution.mergeProbe = { conflicts, runtimeRows: runtimeMap.size }
  } else {
    attribution.mergeProbe = { skipped: 'Node 不支持直接导入 .ts；由 tests/WordFamily.test.ts 保证' }
  }

  // The real current runtime dictionary: fresh checkout / CI has no per-book
  // overlay (it is generated per book at read time), so only the curated table
  // is appended. The PROBE above is confined to the legacy-order attribution.
  const runtime = buildRuntimeLexicon({
    lexiconText: assets.lexiconText,
    curatedText,
    bookText: '',
    curatedFirst: false,
  })
  attribution.dictionary = {
    baseRows: Object.fromEntries(FAMILY_WORDS.map((word) => [word, assets.lexicon.get(word) ?? null])),
    curatedRows: Object.fromEntries(FAMILY_WORDS.map((word) => [word, assets.overlay.entries.get(word) ?? null])),
    effectiveRows: Object.fromEntries(FAMILY_WORDS.map((word) => [word, runtime.runtimeMap.get(word) ?? null])),
    historicallyCurated: HISTORICAL_CURATED,
    wordsNeverCuratedBefore: FAMILY_WORDS.filter((word) => !HISTORICAL_CURATED.includes(word)),
    pinyinProReference: Object.fromEntries(FAMILY_WORDS.map((word) => [
      word, pinyin(word, { toneType: 'num', type: 'array' }).join(' '),
    ])),
  }

  // ---- 2. Final dictionary, word by word ---------------------------------
  for (const item of WORD_FAMILY) {
    const reading = runtime.runtimeMap.get(item.word)
    const phones = phoneticPhones(reading ?? '')
    const ok = Boolean(reading)
      && assets.overlay.entries.has(item.word)
      && phones.length === Array.from(item.word).length
      && phones[item.offset] === item.phone
      && !phones.includes('"')
    check(checks, '词典', `${item.word} 最终词典读音（${item.char}=${item.phone}）`, ok,
      `基础=${attribution.dictionary.baseRows[item.word] ?? '无整词行'} · 人工=${assets.overlay.entries.get(item.word) ?? '缺覆盖行'} · 生效=${reading ?? '缺'}`)
    if (item.neutral) {
      const expected = item.expectedNeutralPhone ?? 'yi'
      const neutralPhone = phones[item.offset + 1]
      check(checks, '词典', `${item.word} 「${item.neutral}」= ${expected}（逐词 A/B 结论）`,
        neutralPhone === expected,
        `实际=${neutralPhone ?? '无'} · ${expected === 'yi'
          ? `训练过的轻声=${TRAINED_NEUTRAL_PHONES.has('yi')}`
          : '第三音节 huo4 已打断连读，轻声实测反被吞'}`)
      if (expected === 'yi') {
        check(checks, '词典', `${item.word} 不再有两个阳平 pian2+yi2 连读`,
          !phones.includes('yi2'), phones.join(' '))
      }
    }
    check(checks, '词典', `${item.word} 无词内静音边界`,
      !/(^\s*[^"\s]+\s+")|("\s+[^"\s]+\s+")/.test(reading ?? ''), reading ?? '')
  }

  // ---- 3. Whole-word match + non-truncated token streams -----------------
  for (const item of WORD_FAMILY) {
    for (const context of item.contexts) {
      const hit = spanOf(context.sentence, item.word, runtime.runtimeMap)
      const coverage = coverageOf(context.sentence, item.word, runtime.runtimeMap)
      check(checks, '整词命中', `${item.word} ${context.label} 整词命中且原句未截断`,
        hit && coverage.ok,
        `整词=${hit} · ${coverage.phones}/${coverage.han} 汉字→音素`)
    }
  }
  const feedbackStream = streamFor(FEEDBACK_SENTENCE, '占便宜', runtime.runtimeMap)
  check(checks, '整词命中', '完整反馈原句「长期地用盐不给钱」中占便宜整词命中且原句未截断',
    Boolean(feedbackStream) && coverageOf(FEEDBACK_SENTENCE, '占便宜', runtime.runtimeMap).ok,
    feedbackStream ? `${feedbackStream.tokens.length} tokens · ${feedbackStream.phones.join(' ')}` : '未命中')
  if (feedbackStream) {
    check(checks, '整词命中', '反馈原句中「便」= pian2、「宜」= 轻声 yi',
      feedbackStream.phones[1] === 'pian2' && feedbackStream.phones[2] === 'yi',
      feedbackStream.phones.join(' '))
  }
  const bookStream = streamFor(BOOK_BLOCK, '占便宜', runtime.runtimeMap)
  check(checks, '整词命中', '书中整块中「便」正确读出（原句未截断）',
    Boolean(bookStream) && bookStream.phones[1] === 'pian2'
      && coverageOf(BOOK_BLOCK, '占便宜', runtime.runtimeMap).ok,
    bookStream ? bookStream.phones.join(' ') : '未命中')
  const dipanStream = streamFor(DIPAN_SENTENCE, '地盘', runtime.runtimeMap)
  check(checks, '整词命中', '地盘反馈原句中「地」= di4',
    Boolean(dipanStream) && dipanStream.phones[0] === 'di4' && spanOf(DIPAN_SENTENCE, '地盘', runtime.runtimeMap),
    dipanStream ? dipanStream.phones.join(' ') : '未命中')

  // ---- 4. Runtime text preparation (U+200B / U+2060) ---------------------
  attribution.runtimeText = {}
  for (const item of WORD_FAMILY) {
    const sentence = item.contexts[1].sentence
    const prepared = prepareRuntimeText(sentence, lists)
    attribution.runtimeText[item.word] = {
      sentence,
      prepared: prepared.replaceAll(WORD_BOUNDARY, '⟦B⟧').replaceAll(UTTERANCE_RESET, '⟦R⟧'),
      split: Boolean(utteranceParts(prepared)),
    }
    const hasBoundary = prepared.includes(WORD_BOUNDARY + item.word)
      || prepared.includes(WORD_BOUNDARY + '地盘')
      || item.word === '地盘'
    check(checks, '运行时文本', `${item.word} 插入整词保护 U+200B`,
      hasBoundary && prepared.includes(WORD_BOUNDARY),
      attribution.runtimeText[item.word].prepared)
    if (item.family === '地盘') {
      check(checks, '运行时文本', `${item.word} 长句触发语句重置 U+2060（两段合成）`,
        prepared.includes(UTTERANCE_RESET) && Boolean(utteranceParts(prepared)),
        `重置=${prepared.includes(UTTERANCE_RESET)} · 段数=${utteranceParts(prepared)?.length ?? 1}`)
    } else {
      check(checks, '运行时文本', `${item.word} 不误触发语句重置`,
        !prepared.includes(UTTERANCE_RESET), '便宜族属音素连读，不进重置词表')
    }
  }
  const feedbackPrepared = prepareRuntimeText(FEEDBACK_SENTENCE, lists)
  check(checks, '运行时文本', '反馈原句只插 U+200B、不切语句',
    feedbackPrepared.includes(WORD_BOUNDARY) && !feedbackPrepared.includes(UTTERANCE_RESET),
    feedbackPrepared.replaceAll(WORD_BOUNDARY, '⟦B⟧').replaceAll(UTTERANCE_RESET, '⟦R⟧'))

  // ---- 5. Exclusions -----------------------------------------------------
  for (const exclusion of EXCLUSIONS) {
    if (exclusion.word) {
      const reading = runtime.runtimeMap.get(exclusion.word) ?? ''
      const phones = phoneticPhones(reading)
      check(checks, '排除项', `${exclusion.word} 仍读 ${exclusion.phone}（未被词族扩散误伤）`,
        phones[exclusion.offset] === exclusion.phone, reading)
    } else {
      let actual = null
      try { actual = readingAt(exclusion.sentence, exclusion.char, exclusion.occurrence, runtime.runtimeMap).phone } catch { /* no match */ }
      check(checks, '排除项', `「${exclusion.char}」在「长期地」仍是助词轻声 ${exclusion.phone}`,
        actual === exclusion.phone, `实际=${actual}`)
    }
  }
  check(checks, '排除项', '裸词「便宜」仍是标准 pian2 yi',
    runtime.runtimeMap.get('便宜') === 'pian2 yi', runtime.runtimeMap.get('便宜') ?? '')
  check(checks, '排除项', '单字「地」兜底仍是 de（不新增单字覆盖）',
    runtime.runtimeMap.get('地') === 'de' && !assets.overlay.entries.has('地'),
    runtime.runtimeMap.get('地') ?? '')
  check(checks, '排除项', '保护词表不含裸词「便宜」（不切断「占便宜」）',
    !lists.protectedWords.includes('便宜'), lists.protectedWords.join('、'))
  check(checks, '排除项', '重置词表不含便宜族（音素问题不靠韵律重置）',
    WORD_FAMILY.filter((item) => item.family === '便宜')
      .every((item) => !lists.resetWords.includes(item.word)),
    lists.resetWords.join('、'))

  // ---- 4b. X便 + 宜 steal contexts (2026-11-11 seventh round) ------------
  attribution.stealCases = []
  for (const item of STEAL_CASES) {
    const result = readingAt(item.phrase, '便', 1, runtime.runtimeMap)
    attribution.stealCases.push({ ...item, actualWord: result.word, actualPhone: result.phone })
    check(checks, '抢词', `${item.phrase}：「便」不被「${item.stolen}」抢走`,
      result.phone === 'pian2' && result.word === item.word,
      `${result.word} -> ${result.phone}（修复前 ${item.stolen} -> ${item.stolenReading}）`)
  }
  attribution.stealExclusions = []
  for (const item of STEAL_EXCLUSIONS) {
    const result = readingAt(item.phrase, '便', 1, runtime.runtimeMap)
    attribution.stealExclusions.push({ ...item, actualWord: result.word, actualPhone: result.phone })
    check(checks, '抢词', `${item.phrase}：真正的 X便+宜 仍读 bian4`,
      result.phone === item.phone && result.word === item.word,
      `${result.word} -> ${result.phone}`)
  }

  // ---- 4c. Single-character 长 contexts (2026-11-11 eighth round) ---------
  attribution.longCases = []
  for (const item of LONG_CASES) {
    const result = readingAt(item.phrase, '长', item.occurrence ?? 1, runtime.runtimeMap)
    attribution.longCases.push({ ...item, actualWord: result.word, actualPhone: result.phone })
    check(checks, '单字长', `${item.phrase.slice(0, 18)}：长=${item.phone}`,
      result.phone === item.phone,
      `${result.word} -> ${result.phone}（期望 ${item.word} -> ${item.phone}）`)
  }
  attribution.longExclusions = []
  for (const item of LONG_EXCLUSIONS) {
    const result = readingAt(item.phrase, '长', 1, runtime.runtimeMap)
    attribution.longExclusions.push({ ...item, actualWord: result.word, actualPhone: result.phone })
    check(checks, '单字长', `${item.phrase.slice(0, 18)}：长=zhǎng（排除项）`,
      new RegExp(item.pattern).test(result.phone),
      `${result.word} -> ${result.phone}`)
  }

  // ---- 4d. Single-character 地 contexts (2026-11-11 ninth round) ----------
  attribution.diCases = []
  for (const item of DI_CASES) {
    const result = readingAt(item.contexts[0], '地', 1, runtime.runtimeMap)
    const boundary = currentBoundary(runtime.runtimeMap.get(item.word) ?? '')
    attribution.diCases.push({
      ...item, actualWord: result.word, actualPhone: result.phone, actualBoundary: boundary.kind,
    })
    check(checks, '单字地', `${item.word} 整词命中且读 di4`,
      result.word === item.word && result.phone === 'di4',
      `${result.word} -> ${result.phone}`)
    check(checks, '单字地', `${item.word} 边界为 ${item.boundary}`,
      boundary.kind === item.boundary, `实际 ${boundary.kind}`)
  }

  attribution.whyPreviousFixesFailed = [
    `人工表历史上只有 ${HISTORICAL_CURATED.join(' / ')} 四行；${attribution.dictionary.wordsNeverCuratedBefore.join(' / ')} 从未进表，基础词典「便宜」族全是 pian2 yi2 两个阳平连读，`,
    'AiModel.ts 把人工表拼在整书自动生成 overlay 之前，worker.patchLexicon 后写覆盖：整书表一旦含同名词即生效，而审计侧 parseOverlay 是首行生效，门禁永远看不到 App 实际用的那一行；',
    'pinyin-pro 对裸词「便宜」给出 bian4 yi2（scripts/out/audit-ming3.txt:445），对词族给出 yi0；yi0 既不在 tokens.txt 也不在 trainedNeutrals.v1.txt，整书自动读音一旦生效就是未训练轻声/怪音；',
    '黄金集 / compile-overlay / 回归快照只校验音素与覆盖表行，omissionCases 与 self-iterate 的 VERIFY_SENTENCES 只登记占便宜、地盘两条，8 个词从未被任何门禁测量；',
    '验收用手抄的、可能截断的 token 序列，从未走 preparePronunciationText 的 U+200B / U+2060，也没对 8 个词逐条做真实 WASM 音节可听性检查。',
    '结论：前五轮都在「该读哪个音 / 加什么边界」里打转，而病根在数据链路与声学「有没有真正发出这个音节」，音素一直正确所以门禁连续判通过。',
  ]

  // ---- 6. Real WASM ------------------------------------------------------
  const acoustic = []
  const advisories = []
  const audioItems = []
  if (!options.static) {
    await mkdir(LEXICON_DIR, { recursive: true })
    const runtimeLexiconPath = join(LEXICON_DIR, 'lexicon-runtime.txt')
    await writeFile(runtimeLexiconPath, runtime.patchedText, 'utf8')
    // Repair-before dictionary: drop only the rows this round adds, keeping the
    // historical 占便宜 / 大便宜 / 地盘 / 地盘之争 fixes intact.
    const newlyAdded = FAMILY_WORDS.filter((word) => !HISTORICAL_CURATED.includes(word))
    const legacyCurated = overlayRows(curatedText)
      .filter((line) => !newlyAdded.includes(line.split(/\s+/)[0]))
      .join('\n')
    const before = buildRuntimeLexicon({
      lexiconText: assets.lexiconText, curatedText: legacyCurated, bookText: '',
    })
    const legacyLexiconPath = join(LEXICON_DIR, 'lexicon-before.txt')
    await writeFile(legacyLexiconPath, before.patchedText, 'utf8')

    const synth = await createMatchaSynth({ quiet: true, lexiconPath: runtimeLexiconPath })
    try {
      const measureTargets = options.mode === 'measure'
        ? WORD_FAMILY.flatMap((item) => item.contexts.map((context) => ({ ...context, item })))
        : WORD_FAMILY.map((item) => ({ ...item.contexts[0], item }))
      for (const { label, sentence, item } of measureTargets) {
        // Measure the sequence the app really sends, not the whole sentence.
        // U+2060 splits a long sentence into two independently synthesised
        // utterances; a whole-sentence ablation is noisy and can even be negative.
        const segments = appSegments(sentence, item.word, lists)
        if (!segments.length) {
          check(checks, '声学', `${item.word} ${label} 真实 WASM 音节可听`, false, 'App 送入段中找不到目标词')
          continue
        }
        for (const segment of segments) {
          const stream = streamFor(segment.text, item.word, runtime.runtimeMap)
          if (!stream) {
            check(checks, '声学', `${item.word} ${label} 真实 WASM 音节可听`, false, '无法构造 token 序列')
            continue
          }
          const indices = phoneIndices(stream.tokens, stream.range.start, stream.count)
          const summary = summarizeContributions(synth.contributions(stream.tokens, indices))
          const name = `${item.word} ${label}·${segment.label}`
          const isAdvisory = label === '整块' && !segment.split
          const entry = { word: item.word, label: name, sentence: segment.text,
            phones: stream.phones, split: segment.split, advisory: isAdvisory, ...summary }
          acoustic.push(entry)
          const detail = `${summary.values.join('/')}ms · ${summary.states.join('/')} · 评分 ${summary.score}`
          // A 25–30-phone unsplit sentence is split differently by the front
          // end (min_words_in_sentence=12), so single-phone ablation there is a
          // proxy that disagrees with listening. List it every run, never claim
          // it as a hard pass, never auto-edit the overlay from it.
          if (isAdvisory) {
            advisories.push({ ...entry, detail,
              note: '长句一次合成的音节消融受前端分句影响，代理指标与听感未定，待复听；真实文本前端 WAV 已生成' })
          } else {
            check(checks, '声学', `${name} 真实 WASM 每个音节可听（100–350ms）`,
              summary.states.every((state) => state === 'normal'), detail)
          }
        }
        // Independent of ablation: synthesise the word through the REAL text
        // front end and count voiced energy islands. The documented root cause
        // of 便宜 was `pian2+yi2` collapsing into ONE 659ms continuous rising
        // tone, so >=2 islands is the direct waveform-level proof that the
        // syllables are separate. Island count is not a per-syllable counter
        // (adjacent voiced syllables commonly merge into one energy island).
        const isolated = synth.generateText(`${item.word}。`).samples
        const islands = voicedIslands(isolated, synth.sampleRate)
        acoustic.push({ word: item.word, label: `${item.word} 单独念·波形`,
          islands, expected: Array.from(item.word).length, kind: 'waveform' })
        check(checks, '声学', `${item.word} 真实文本前端单独念：不是融成一段的连续怪音`,
          islands >= 2,
          `独立浊音段 ${islands}（≥2） · 音节 ${Array.from(item.word).length}`)
      }
      // 2026-11-11 ninth round: measure the 地 syllable itself in every DI case
      // context (2 per word in verify, all contexts in --measure).
      for (const item of DI_CASES) {
        const contexts = options.mode === 'measure' ? item.contexts : item.contexts.slice(0, 2)
        for (const sentence of contexts) {
          for (const segment of appSegments(sentence, item.word, lists)) {
            const stream = streamFor(segment.text, item.word, runtime.runtimeMap)
            if (!stream) {
              check(checks, '声学', `${item.word} 单字地 ${sentence.slice(0, 10)}…`, false, '无法构造 token 序列')
              continue
            }
            const offset = [...item.word].indexOf('地')
            const indices = phoneIndices(stream.tokens, stream.range.start, stream.count)
            const summary = summarizeContributions(synth.contributions(stream.tokens, [indices[offset]]))
            acoustic.push({ word: item.word, label: `${item.word} 单字地`, sentence: segment.text,
              phones: stream.phones, ...summary })
            check(checks, '声学', `${item.word} 单字地可听（${sentence.slice(0, 10)}…）`,
              summary.states[0] === 'normal',
              `${summary.values[0]}ms ${summary.states[0]}`)
          }
        }
      }
      for (const [label, sentence, word, advisory] of [
        ['反馈原句', FEEDBACK_SENTENCE, '占便宜', false],
        // Project policy (README 2026-11-11, om-0001 advisorySentences): all
        // three syllables of this long book block exceed 350ms at once, which
        // cannot be neighbouring phones swallowing each other. Measure and list
        // it EVERY run, but never claim it as a hard pass and never auto-edit
        // the overlay from this proxy.
        ['书中整块', BOOK_BLOCK, '占便宜', true],
        ['地盘原句', DIPAN_SENTENCE, '地盘', false],
      ]) {
        // 地盘 is in utteranceResets: the app synthesises the reset tail as its
        // own utterance. Measuring the raw sentence with the new tail boundary
        // would report 34ms, a sequence the app never plays. Use appSegments.
        for (const segment of appSegments(sentence, word, lists)) {
          const stream = streamFor(segment.text, word, runtime.runtimeMap)
          if (!stream) continue
          const indices = phoneIndices(stream.tokens, stream.range.start, stream.count)
          const summary = summarizeContributions(synth.contributions(stream.tokens, indices))
          const name = `${label}·${segment.label}`
          const entry = { word, label: name, sentence: segment.text, phones: stream.phones, ...summary }
          acoustic.push({ ...entry, advisory })
          const detail = `${summary.values.join('/')}ms · ${summary.states.join('/')}`
          if (advisory) {
            advisories.push({ ...entry, detail, note: '三个音节同时 >350ms，代理指标与听感未定，待复听；不计入硬性门禁' })
          } else {
            check(checks, '声学', `${name} 真实 WASM 每个音节可听`,
              summary.states.every((state) => state === 'normal'), detail)
          }
        }
      }

      if (options.audio) {
        await mkdir(AUDIO_DIR, { recursive: true })
        const legacySynth = await createMatchaSynth({ quiet: true, lexiconPath: legacyLexiconPath })
        try {
          attribution.waveform = Object.fromEntries(WORD_FAMILY.map((item) => [item.word, {
            beforeIslands: voicedIslands(
              legacySynth.generateText(`${item.word}。`).samples, legacySynth.sampleRate),
            afterIslands: voicedIslands(
              synth.generateText(`${item.word}。`).samples, synth.sampleRate),
          }]))
          const cases = [
            ...WORD_FAMILY.map((item) => ({ item, label: item.contexts[1].label, sentence: item.contexts[1].sentence })),
            { item: { word: '占便宜', family: '便宜' }, label: '反馈原句', sentence: FEEDBACK_SENTENCE },
            { item: { word: '占便宜', family: '便宜' }, label: '书中整块', sentence: BOOK_BLOCK },
            { item: { word: '地盘', family: '地盘' }, label: '地盘原句', sentence: DIPAN_SENTENCE },
          ]
          for (const { item, label, sentence } of cases) {
            const prepared = prepareRuntimeText(sentence, lists)
            const after = renderPrepared(synth, prepared)
            synth.save(join(AUDIO_DIR, `after-${item.word}-${label}.wav`), { samples: after, sampleRate: synth.sampleRate })
            audioItems.push({ word: item.word, label, variant: 'after', sentence,
              file: `after-${item.word}-${label}.wav`, ms: Math.round(after.length / synth.sampleRate * 1000) })
            const beforeSamples = renderPrepared(legacySynth, prepared)
            legacySynth.save(join(AUDIO_DIR, `before-${item.word}-${label}.wav`), { samples: beforeSamples, sampleRate: legacySynth.sampleRate })
            audioItems.push({ word: item.word, label, variant: 'before', sentence,
              file: `before-${item.word}-${label}.wav`, ms: Math.round(beforeSamples.length / legacySynth.sampleRate * 1000) })
          }
        } finally {
          legacySynth.free()
        }
        await writeListenHtml(audioItems)
      }
    } finally {
      synth.free()
    }
  }

  const passed = checks.filter((item) => item.ok).length
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    wordFamily: FAMILY_WORDS,
    checks,
    passed,
    total: checks.length,
    acoustic,
    advisories,
    audio: audioItems,
    attribution,
    policy: {
      engine: 'matcha (山岚) only',
      minContributionMs: 100,
      maxNormalMs: 350,
      boundariesOnlyAtWordEdges: true,
      fullFeedbackSentence: true,
    },
  }
  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await mkdir(dirname(options.summary), { recursive: true })
  await writeFile(options.summary, renderMarkdown(report), 'utf8')

  console.log(`词组逐条验收：${passed}/${checks.length} 通过 · ${FAMILY_WORDS.length} 个词 · ${acoustic.length} 条真实 WASM 测量`)
  for (const item of checks) {
    console.log(`  ${item.ok ? '通过' : '未通过'}  [${item.group}] ${item.name}  ${item.detail}`)
  }
  for (const item of advisories) {
    console.log(`  待复听  ${item.label} ${item.detail} · ${item.note}`)
  }
  console.log(`报告 ${options.out}`)
  if (options.audio) console.log(`试听 ${join(AUDIO_DIR, 'listen.html')}`)
  if (options.mode === 'verify' && passed !== checks.length) process.exitCode = 1
}

function renderMarkdown(report) {
  const lines = [
    '# 多音字词组逐条验收（山岚 matcha）',
    '',
    `生成时间 ${report.generatedAt} · 模式 ${report.mode} · ${report.passed}/${report.total} 通过`,
    '',
    '## 逐词结果',
    '',
    '| 词条 | 基础词典 | 人工覆盖（最终生效） | 音素断言 | 整词命中 | 运行时标记 | WASM 音节 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const word of report.wordFamily) {
    const base = report.attribution.dictionary.baseRows[word] ?? '无整词行'
    const curated = report.attribution.dictionary.curatedRows[word] ?? '缺覆盖行'
    const pick = (group, suffix) => {
      const hit = report.checks.find((item) => item.name.startsWith(`${word} ${suffix}`) && item.group === group)
      return hit ? (hit.ok ? '✓' : '✗') : '—'
    }
    const acoustic = report.acoustic.filter(
      (item) => item.word === word && item.kind !== 'waveform' && !item.advisory,
    )
    const states = acoustic.length
      ? (acoustic.every((item) => item.states.every((state) => state === 'normal')) ? '✓' : '✗')
        + ' ' + acoustic.map((item) => item.values.join('/')).join(' · ')
      : '—'
    lines.push(`| ${word} | ${base} | ${curated} | ${pick('词典', '最终词典读音')} | ${pick('整词命中', '短句')} | ${pick('运行时文本', '插入整词保护')} | ${states} |`)
  }
  lines.push('', '## 抢词语境（X便 + 宜）', '',
    '| 语境 | 修复前真实前端 | 整词覆盖后 | 结论 |',
    '| --- | --- | --- | --- |')
  for (const item of report.attribution.stealCases) {
    lines.push(`| ${item.phrase} | ${item.stolen} -> ${item.stolenReading} + 宜 | ${item.actualWord} -> ${item.actualPhone} | ${item.actualPhone === 'pian2' ? '✓' : '✗'} |`)
  }
  lines.push('', '排除项（真正的 X便 + 宜，必须保持 bian4）：', '')
  for (const item of report.attribution.stealExclusions) {
    lines.push(`- ${item.phrase}：${item.actualWord} -> ${item.actualPhone}（期望 ${item.word} -> ${item.phone}）`)
  }
  lines.push('', '## 单字「长」上下文（第八轮）', '',
    '| 语境 | 期望 | 实际 | 结论 |',
    '| --- | --- | --- | --- |')
  for (const item of report.attribution.longCases) {
    lines.push(`| ${item.phrase} | ${item.phone} | ${item.actualWord} -> ${item.actualPhone} | ${item.actualPhone === item.phone ? '✓' : '✗'} |`)
  }
  lines.push('', '排除项（必须保持 zhǎng）：', '')
  for (const item of report.attribution.longExclusions) {
    lines.push(`- ${item.phrase}：${item.actualWord} -> ${item.actualPhone}`)
  }
  lines.push('', '## 单字「地」上下文（第九轮）', '',
    '| 词 | 边界 | 语境 | 地 (ms) | 结论 |',
    '| --- | --- | --- | ---: | --- |')
  for (const item of report.attribution.diCases) {
    const rows = report.acoustic.filter(
      (entry) => entry.word === item.word && entry.kind !== 'waveform',
    )
    for (const row of rows) {
      lines.push(`| ${item.word} | ${item.actualBoundary} | ${row.sentence} | ${row.values[0]} | ${row.states[0]} |`)
    }
    if (!rows.length) lines.push(`| ${item.word} | ${item.actualBoundary} | — | — | — |`)
  }
  lines.push('', '## 适用词条范围', '',
    '- 单字「地」（第九轮）：荒地 / 空地 / 林地 / 本地 / 地图 按逐词语境 A/B 加边界；地心 / 地洞 实测无边界即 normal，保持原样；未收录地词由 reserved 基数修复（只允许人工表已钉的 di4）与 BOOK_LEXICON_VERSION=6 处理，状语助词「地」仍读 de。',
    '- 单字「长」（第八轮）：比较/长度/时间语境按真实书本上下文补多字覆盖行；校长/参谋长/处长/长了/长在/长到/长身体 等 zhǎng 语境保持原样，不做单字全局覆盖。',
    '- 纳入修复与逐词验收：小便宜、捡便宜、讨便宜、贪便宜（便=pian2，宜=训练过的轻声 yi）；便宜货（便=pian2，「宜」按逐词 A/B 保留 yi2）；抢地盘、占地盘、地盘（地=di4）。',
    '- 抢词语境（第七轮）：不便宜、就便宜、以便宜、得便宜、趁便宜——前端会先命中「不便 / 就便 / 以便 / 得便 / 趁便」而把「便」读成 bian4，整词钉住后才回到 pian2。',
    '- 守住但不改：占便宜、大便宜、地盘之争、地点、完整反馈原句与书中整块。',
    '- 明确排除：便宜从事 / 便宜施行 / 便宜行事、小便、状语助词「长期地」的 de、单字「便 / 地」覆盖、piper 小雅 / 初晴 / AISHELL-3 词典、系统语音与英文音色。',
    '', '## 此前修复未生效的原因（运行时数据链路归因）', '')
  for (const reason of report.attribution.whyPreviousFixesFailed) lines.push(`- ${reason}`)
  lines.push('', '## 待复听（不冒充通过、不据代理指标自动改表）', '')
  for (const item of report.advisories) {
    lines.push(`- ${item.label}：${item.detail} — ${item.note}`)
  }
  lines.push('', '## 全部检查', '')
  for (const item of report.checks) lines.push(`- ${item.ok ? '✓' : '✗'} [${item.group}] ${item.name} — ${item.detail}`)
  return `${lines.join('\n')}\n`
}

async function writeListenHtml(items) {
  const escape = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const { readFile } = await import('node:fs/promises')
  const words = [...new Set(items.map((item) => item.word))]
  let sections = ''
  for (const word of words) {
    let rows = ''
    for (const item of items.filter((entry) => entry.word === word)) {
      const b64 = (await readFile(join(AUDIO_DIR, item.file))).toString('base64')
      rows += `<div class="card"><div class="label">${escape(item.variant === 'before' ? '修复前' : '修复后')} · ${escape(item.label)}</div><audio controls preload="none" src="data:audio/wav;base64,${b64}"></audio><div class="meta">${escape(item.sentence)} · ${item.ms}ms</div></div>`
    }
    sections += `<section class="group"><h2>${escape(word)}</h2><p class="note">${escape(word.includes('便宜') ? '重点听「便」是不是清晰的 pián，有没有被吞或拖成一个怪音。' : '重点听「地」是不是下降的 dì，而不是含混的 de。')}</p><div class="grid">${rows}</div></section>`
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>多音字词组修复前后 · 逐词复听</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#1c2430;line-height:1.6}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}h1{font-size:22px;margin:0 0 6px}.lead{color:#5a6675;font-size:14px;margin:0 0 24px}
.group{background:#fff;border:1px solid #e3e7ec;border-radius:14px;padding:20px;margin-bottom:18px}h2{font-size:17px;margin:0 0 8px}.note{font-size:13px;color:#6a7686;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.card{border:1px solid #e3e7ec;border-radius:10px;padding:12px;background:#fcfdfe}
.label{font-size:13px;font-weight:600;margin-bottom:10px}audio{width:100%;height:36px}.meta{font-size:11px;color:#8a94a3;margin-top:8px}</style></head><body><div class="wrap">
<h1>多音字词组修复前后 · 逐词复听</h1><p class="lead">全部走真实文本前端（最终词典 + U+200B / U+2060 标记 + WASM 分段合成），与 App 朗读路径一致。每组先听「修复前」再听「修复后」。</p>
${sections}</div></body></html>`
  await writeFile(join(AUDIO_DIR, 'listen.html'), html, 'utf8')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
