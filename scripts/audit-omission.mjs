#!/usr/bin/env node
// Dev-only / CI: the P4 "omission" loop for 山岚.
//
// Golden fixtures only prove a character has the right *phone*. Three listener
// reports about 占便宜 were closed while 便 was still inaudible, because:
//   * the acoustic verify case used a hand-copied token stream truncated at
//     「有钱人」 instead of the full feedback sentence;
//   * the gate only asserted recommendation === 'keep', never that the current
//     configuration has zero swallowed syllables;
//   * the acoustic exception stayed `pending-listening` and was never replayed.
//
// This script closes the loop:
//   verify   full feedback sentences -> real runtime token stream -> real WASM
//            syllable contributions -> hard failure on any swallowed/merged
//            syllable, missing repair, or truncated sentence.
//   measure  enumerate EVERY completion-boundary position (the old audit only
//            tried word-final + one fixed internal slot) on >=2 real contexts.
//   apply    write the A/B winner, append a new case to omissionCases.v1.jsonl,
//            rebuild the snapshot, run audit:all, roll back on any failure.
//            The appended case is automatically part of the next verify run:
//            one fix becomes one more permanent regression baseline.
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  ROOT, loadMatchaAssets,
} from './lib/reading.mjs'
import { phoneIndices } from './lib/fusionRisk.mjs'
import { createMatchaSynth } from './lib/matchaSynth.mjs'
import {
  NORMAL_MAX_MS, SWALLOW_MS, summarizeContributions,
} from './lib/acousticScoring.mjs'
import {
  boundaryVariants, caseStream, currentBoundary, inWordBoundaries,
  parseOmissionCases, replayOmission, sentenceCoverage,
} from './lib/omission.mjs'

const CASES = resolve(ROOT, 'src/core/tts/omissionCases.v1.jsonl')
const OVERLAY = resolve(ROOT, 'src/core/tts/polyphones.v1.txt')
const OUT = resolve(ROOT, 'scripts/out/omission-verify.json')
const SUMMARY = resolve(ROOT, 'scripts/out/omission-verify.md')
const CANDIDATES = resolve(ROOT, 'scripts/out/omission-candidates.jsonl')
const MARGIN = 20
const MAX_FIX_CHARS = 4

function parseArgs(argv) {
  const options = {
    verify: false, measure: false, apply: false, audio: false,
    words: null, limit: 20, out: OUT, summary: SUMMARY,
    candidates: CANDIDATES, noGates: false,
  }
  for (const arg of argv) {
    if (arg === '--verify') options.verify = true
    else if (arg === '--measure') options.measure = true
    else if (arg === '--apply') options.apply = true
    else if (arg === '--audio') options.audio = true
    else if (arg === '--no-gates') options.noGates = true
    else if (arg.startsWith('--words=')) options.words = resolve(ROOT, arg.slice(8))
    else if (arg.startsWith('--limit=')) options.limit = numberOption(arg, 20)
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
    else if (arg.startsWith('--candidates=')) options.candidates = resolve(ROOT, arg.slice(13))
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function numberOption(arg, fallback) {
  const value = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function printHelp() {
  console.log(`用法: node scripts/audit-omission.mjs [选项]

山岚「漏读」P4 闭环。用完整反馈原句重建运行时 token 序列，再用真实 WASM
逐个音节测量，确保被反馈的字真的读出来。

  --verify              CI 必需门禁；不写文件、不改覆盖表
  --measure             对案例/外部线索枚举全部完成边界位置并做多上下文 A/B
  --apply               写入已验证修复 + 追加案例 + 重建快照 + 跑全门禁
  --words=<file>        外部线索 JSONL（由 npm run iterate 的 omission 族产出）
  --limit=N             最多测量 N 个词（默认 20）
  --no-gates            --apply 时跳过 audit:all（仅供调试）
  --audio               保存证据 WAV
  --out/--summary/--candidates=<file>  产物路径

安全约束：修复行的音素必须与修复前完全一致，只允许插入一个静音完成边界；
必须在 ≥2 条完整反馈原句上全部音节处于 ${SWALLOW_MS}–${NORMAL_MAX_MS}ms 且
均衡度平均提升 ≥${MARGIN}；四字以上词不自动写入；写回后跑全部门禁，
失败自动回滚。`)
}

async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return []
      try { return [JSON.parse(trimmed)] } catch { return [] }
    })
  } catch { return [] }
}

async function readCases() {
  return parseOmissionCases(await readFile(CASES, 'utf8'))
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' })
}

function measureStream(synth, tokens, start, count, cache) {
  const key = tokens.join('|')
  if (cache.has(key)) return cache.get(key)
  const indices = phoneIndices(tokens, start, count)
  const summary = summarizeContributions(synth.contributions(tokens, indices))
  cache.set(key, summary)
  return summary
}

// ---------------------------------------------------------------- verify ----

async function verify(assets, options) {
  const cases = await readCases()
  const checks = []
  checks.push({
    name: '漏读案例表非空',
    ok: cases.length > 0,
    detail: `${cases.length} 条`,
  })

  // Policy gate. A silent boundary inside a word is heard as a break and makes
  // the syllable after it lose its tone; that exact placement is what made
  // 「便」 audibly wrong on 2026-11-11 after three rounds of "fixed". Only word
  // edges (leading / trailing) are allowed from now on.
  const inWord = inWordBoundaries(assets.overlay.entries)
  checks.push({
    name: '覆盖表没有词内静音边界（只允许词首/词尾）',
    ok: inWord.length === 0,
    detail: inWord.length
      ? inWord.map((item) => `${item.word} ${item.reading}`).join(' | ')
      : '全部边界都在词首或词尾',
  })

  const synth = await createMatchaSynth()
  const results = []
  const advisories = []
  try {
    for (const c of cases) {
      // A `needs-listening` case (or an explicitly listed context) records a
      // spot where the duration proxy disagrees with listening. It is measured
      // and reported on EVERY run (so it cannot silently disappear), but never
      // auto-repaired or counted as a hard gate until a human confirms it.
      // Granularity is per sentence: the 2026-11-11 宜→轻声 fix makes all three
      // syllables of one long book block exceed the 350ms "merged" threshold
      // at once, which cannot be neighbouring phones swallowing each other
      // (the same fix measures cleanly on the other three feedback contexts).
      const caseAdvisory = c.status === 'needs-listening'
      const advisorySentences = c.advisorySentences ?? []
      const replay = replayOmission(c, assets)
      checks.push({ name: `${c.id} 修复未回退且修复前可复现`, ok: replay.ok && replay.reproducible, detail: replay.detail })
      checks.push({
        name: `${c.id} 至少 2 条真实语境（反馈原句 + 书中整块）`,
        ok: (c.sentences?.length ?? 0) + (c.contexts?.length ?? 0) >= 2,
        detail: `${c.sentences?.length ?? 0} 条原句 + ${c.contexts?.length ?? 0} 条书中整块`,
      })
      if (!replay.ok) continue

      const measured = []
      // `sentences` are the listener's quotations; `contexts` are the FULL book
      // sentences the app actually feeds the model. Measuring only the quotation
      // is how 地盘 was reported fixed twice while the full 72-character
      // sentence squashed 「地」 to 105ms.
      const targets = [
        ...(c.sentences ?? []).map((sentence) => ({ sentence, book: false })),
        ...(c.contexts ?? []).map((sentence) => ({ sentence, book: true })),
      ]
      for (const { sentence, book } of targets) {
        const stream = caseStream(sentence, c.word, assets)
        const coverage = sentenceCoverage(stream, sentence)
        const label = book ? '书中整句' : '原句'
        const advisory = caseAdvisory || advisorySentences.includes(sentence)
        checks.push({
          name: `${c.id} ${label}未截断（${sentence.slice(0, 12)}…）`,
          ok: coverage.ok,
          detail: `${coverage.phones}/${coverage.han} 汉字→音素`,
        })
        if (!stream || !coverage.ok) continue
        const summary = measureStream(synth, stream.tokens, stream.range.start, stream.count, new Map())
        measured.push({
          sentence, book,
          values: summary.values, states: summary.states, score: summary.score,
          syllables: stream.tokens.length,
        })
        const detail = `${summary.values.join('/')}ms · ${summary.states.join('/')} · 评分 ${summary.score}`
        if (advisory) {
          advisories.push({
            id: c.id, word: c.word, sentence, detail,
            healthy: summary.states.every((state) => state === 'normal'),
            note: c.note ?? '',
          })
        } else {
          checks.push({
            name: `${c.id} 每个音节都可听（${label} ${sentence.slice(0, 12)}…）`,
            ok: summary.states.every((state) => state === 'normal'),
            detail,
          })
        }
      }
      const boundary = currentBoundary(assets.overlay.entries.get(c.word) ?? '')
      checks.push({
        name: `${c.id} 完成边界位置未漂移`,
        ok: c.repair?.kind === boundary.kind && c.repair?.after === boundary.after,
        detail: `期望 ${c.repair?.kind}@${c.repair?.after}，实际 ${boundary.kind}@${boundary.after}`,
      })
      results.push({
        id: c.id, word: c.word, source: c.source, status: c.status,
        replay, boundary, sentences: measured,
      })
    }
  } finally {
    synth.free()
  }

  const passed = checks.filter((check) => check.ok).length
  const report = {
    generatedAt: new Date().toISOString(),
    verify: true,
    cases: cases.length,
    checks,
    passed,
    total: checks.length,
    results,
    advisories,
    policy: {
      fullFeedbackSentence: true,
      minContributionMs: SWALLOW_MS,
      maxNormalMs: NORMAL_MAX_MS,
      repairMustBePresent: true,
    },
  }
  await mkdir(dirname(options.out), { recursive: true })
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(options.summary, renderVerify(report), 'utf8')
  console.log(`漏读可听性验收：${passed}/${checks.length} 通过 · ${cases.length} 条案例`)
  for (const check of checks) {
    console.log(`  ${check.ok ? '通过' : '未通过'}  ${check.name}  ${check.detail ?? ''}`)
  }
  for (const item of advisories) {
    console.log(`  待复听  ${item.id} ${item.sentence.slice(0, 16)}…  ${item.detail}`)
  }
  if (advisories.length) console.log(`  待复听 ${advisories.length} 条：代理指标与听感未定，不自动改表、不计入硬性门禁`)
  if (passed !== checks.length) process.exitCode = 1
  return report
}

function renderVerify(report) {
  const lines = [
    '# 山岚漏读可听性回归',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 案例 ${report.cases} 条 · 检查 ${report.passed}/${report.total} 通过`,
    '',
    '> 每条案例都从 `omissionCases.v1.jsonl` 读取**完整反馈原句**，现场用当前覆盖表重建',
    '> 运行时 token 序列；汉字与音素必须一一对应，禁止手工抄录截断的 token 序列。',
    `> 真实 WASM 测量每个音节的时长贡献，<${SWALLOW_MS}ms（被吞）或 >${NORMAL_MAX_MS}ms（吞并邻音）即失败。`,
    '',
    '| 案例 | 词 | 原句 | 各音节贡献 (ms) | 判定 | 评分 |',
    '| --- | --- | --- | --- | --- | ---: |',
  ]
  for (const item of report.results) {
    for (const sentence of item.sentences) {
      lines.push(`| ${item.id} | ${item.word} | ${sentence.sentence.replace(/\|/g, '\\|')} | ${sentence.values.join(' / ')} | ${sentence.states.join(' / ')} | ${sentence.score} |`)
    }
  }
  if (report.advisories.length) {
    lines.push('', '## 待复听上下文（每轮持续测量，不自动改表）', '',
      '> 时长代理指标不能替代听感（同「应天」）。这些上下文每轮都会列出，',
      '> 但只有人工复听或多上下文 A/B 有结论后才会升级为硬性门禁。', '',
      '| 案例 | 原句 | 实测 |', '| --- | --- | --- |')
    for (const item of report.advisories) {
      lines.push(`| ${item.id} | ${item.sentence.replace(/\|/g, '\\|')} | ${item.detail.replace(/\|/g, '\\|')} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

// --------------------------------------------------------------- measure ----

async function measure(assets, options) {
  const recorded = await readCases()
  const external = options.words ? await readJsonl(options.words) : []
  const targets = options.words
    ? external.slice(0, options.limit).map((lead) => ({
      id: `lead:${lead.word}`,
      word: lead.word,
      char: lead.char,
      offset: lead.offset ?? 1,
      phone: lead.phone,
      sentences: (lead.sentences ?? lead.evidence ?? [])
        .map((item) => String(item).replace(/^…|…$/g, '')),
      status: 'candidate',
      repair: null,
    }))
    : recorded.slice(0, options.limit)

  const synth = await createMatchaSynth()
  const results = []
  try {
    for (const target of targets) {
      const sentences = [
        ...(target.sentences ?? []),
        ...(target.contexts ?? []),
      ].filter((item) => item.includes(target.word))
      if (sentences.length < 2) {
        console.log(`  ${target.word.padEnd(6)} 跳过：完整反馈原句不足 2 条`)
        results.push({ ...target, accepted: false, reason: '完整反馈原句不足 2 条' })
        continue
      }
      const streams = sentences.map((sentence) => caseStream(sentence, target.word, assets))
      if (streams.some((stream) => !stream)) {
        console.log(`  ${target.word.padEnd(6)} 跳过：反馈原句中无法定位整词`)
        results.push({ ...target, accepted: false, reason: '反馈原句中无法定位整词' })
        continue
      }
      const variants = boundaryVariants(streams[0])
      const trials = variants.map((variant) => {
        const scores = []
        for (const [index, stream] of streams.entries()) {
          const alternative = boundaryVariants(stream)
            .find((item) => item.kind === variant.kind && item.after === variant.after)
          const summary = measureStream(
            synth, alternative.tokens, stream.range.start, stream.count, new Map(),
          )
          scores.push({ index, ...summary })
        }
        return {
          kind: variant.kind, after: variant.after, reading: variant.reading,
          label: variant.label, scores,
          meanScore: Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length * 10) / 10,
          healthy: scores.every((item) => item.states.every((state) => state === 'normal')),
        }
      })
      const current = currentBoundary(assets.overlay.entries.get(target.word) ?? '')
      const currentTrial = trials.find((item) => item.kind === current.kind && item.after === current.after)
        ?? trials[0]
      const eligible = trials.filter((item) => item.kind !== 'tail'
        && Array.from(target.word).length <= MAX_FIX_CHARS
        && item.healthy
        && item.meanScore >= currentTrial.meanScore + MARGIN)
      const best = eligible.sort((a, b) => b.meanScore - a.meanScore)[0] ?? null
      results.push({
        ...target,
        sentences,
        current: { kind: current.kind, after: current.after, meanScore: currentTrial.meanScore },
        trials,
        best: best ? {
          kind: best.kind, after: best.after, reading: best.reading,
          meanScore: best.meanScore,
          baselineMs: currentTrial.scores[0].values,
          fixedMs: best.scores[0].values,
        } : null,
        accepted: Boolean(best),
        reason: best
          ? `全部 ${sentences.length} 条原句音节正常，均衡度 ${currentTrial.meanScore} → ${best.meanScore}`
          : '没有同时满足「全部原句音节正常」且评分提升达标的边界位置',
      })
      console.log(`  ${target.word.padEnd(6)} ${current.kind}@${current.after} ${currentTrial.meanScore} → ${best ? `${best.kind}@${best.after} ${best.meanScore}` : '无可应用修复'}`)
    }
  } finally {
    synth.free()
  }
  await mkdir(dirname(options.candidates), { recursive: true })
  await writeFile(options.candidates,
    results.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
  console.log(`\n候选 ${results.filter((item) => item.accepted).length}/${results.length}，产物 ${options.candidates}`)
  return results
}

// ----------------------------------------------------------------- apply ----

async function applyToOverlay(word, reading, text) {
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex((line) => line.trim().split(/\s+/)[0] === word)
  if (index >= 0) {
    lines[index] = `${word} ${reading}`
    return lines.join('\n')
  }
  return `${text.trimEnd()}\n\n# P4 漏读自迭代产物 ${new Date().toISOString()}\n${word} ${reading}\n`
}

async function applyFix(options, results) {
  const accepted = results.filter((item) => item.accepted && item.best
    && Array.from(item.word).length <= MAX_FIX_CHARS)
  if (!accepted.length) {
    console.log('没有通过多上下文 A/B 的修复，覆盖表保持不变。')
    return { applied: 0 }
  }

  const backups = new Map()
  for (const path of [OVERLAY, CASES]) backups.set(path, await readFile(path, 'utf8'))
  const tag = new Date().toISOString().slice(0, 10)
  try {
    let overlay = backups.get(OVERLAY)
    for (const item of accepted) {
      overlay = await applyToOverlay(item.word, item.best.reading, overlay)
    }
    await writeFile(OVERLAY, overlay, 'utf8')

    const existingIds = new Set((await readCases()).map((item) => item.id))
    const additions = accepted
      .filter((item) => !existingIds.has(`om-auto-${item.word}-${tag}`))
      .map((item) => JSON.stringify({
        id: `om-auto-${item.word}-${tag}`,
        source: `self-iterate-${tag}`,
        status: 'confirmed',
        sentences: item.sentences.slice(0, 3),
        ...(Array.isArray(item.contexts) && item.contexts.length
          ? { contexts: item.contexts.slice(0, 2) }
          : {}),
        word: item.word,
        char: item.char,
        offset: item.offset,
        phone: item.phone,
        repair: {
          kind: item.best.kind,
          after: item.best.after,
          reading: item.best.reading,
        },
        baselineMs: item.best.baselineMs,
        fixedMs: item.best.fixedMs,
        note: `全量递归自迭代：${item.trials.length} 种完成边界位置、${item.sentences.length} 条完整原句真实 WASM A/B，均衡度 ${item.current.meanScore} → ${item.best.meanScore}。`,
      }))
    if (additions.length) {
      await appendFile(CASES, `${additions.join('\n')}\n`, 'utf8')
    }

    const snapshot = run('scripts/build-pronunciation-regression.mjs', [])
    if (snapshot.status !== 0) throw new Error(`快照重建失败：${snapshot.stdout}${snapshot.stderr}`)
    if (!options.noGates) {
      const gates = run('scripts/audit-all.mjs', [])
      if (gates.status !== 0) throw new Error(`读音门禁未通过，已回滚本轮写入：\n${gates.stdout}${gates.stderr}`)
    }
    console.log(`\n已写入 ${accepted.length} 行覆盖、${additions.length} 条新漏读案例；下一次 --verify 自动纳入基线。`)
    return { applied: accepted.length, cases: additions.length }
  } catch (error) {
    for (const [path, content] of backups) await writeFile(path, content, 'utf8')
    const snapshot = run('scripts/build-pronunciation-regression.mjs', [])
    if (snapshot.status !== 0) console.error('回滚后快照重建失败，请手动执行 npm run regression:build')
    throw error
  }
}

// ------------------------------------------------------------------ main ----

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const assets = await loadMatchaAssets()
  if (options.verify) {
    await verify(assets, options)
    return
  }
  const results = options.measure
    ? await measure(assets, options)
    : await readJsonl(options.candidates)
  if (options.apply) await applyFix(options, results)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
