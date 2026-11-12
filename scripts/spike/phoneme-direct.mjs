#!/usr/bin/env node
// HIGH-TIER SPIKE ONLY. This script never touches production files.
//
// Question: the vendored runtime already exposes pre-phonemized input
// (`generateWithConfig('', { tokens: [tokens] })`), and
// scripts/lib/matchaSynth.mjs:79-90 already uses it with REAL WASM. So the
// remaining questions are about the production change surface, not feasibility:
//   1. Does the tokens path really bypass the lexicon (no longest-match,
//      no ruleFsts, no overlay)?
//   2. What does it cost to turn a sentence into a token stream?
//   3. Is the audio objectively comparable to the text path?
//
// This is a measurement, not an implementation. Run:
//   node scripts/spike/phoneme-direct.mjs
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  createMatchaSynth,
  acousticModelPaths,
  APP_MIN_WORDS_IN_SENTENCE,
} from '../lib/matchaSynth.mjs'
import { ROOT, parseEntries, parseTokens, loadMatchaAssets } from '../lib/reading.mjs'

const OUT = join(ROOT, 'scripts/out/phoneme-spike.json')

function stats(result) {
  const samples = result.samples ?? []
  let peak = 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i])
    if (value > peak) peak = value
    sum += value * value
  }
  const rate = result.sampleRate || 22050
  return {
    samples: samples.length,
    sampleRate: rate,
    audioMs: Math.round(samples.length / rate * 1000),
    peak: Number(peak.toFixed(6)),
    rms: Number(Math.sqrt(sum / Math.max(1, samples.length)).toFixed(6)),
  }
}

async function main() {
  console.log('高档 Spike：音素直输真实 WASM PoC（只读，不改生产文件）')
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: 'sherpa-onnx-wasm-tts-2.0.0',
    minWordsInSentence: APP_MIN_WORDS_IN_SENTENCE,
    paths: acousticModelPaths(),
    findings: [],
    cases: [],
  }

  const assets = await loadMatchaAssets()
  const lexicon = parseEntries(assets.lexiconText)
  const tokens = parseTokens(assets.tokensText)
  report.assets = {
    lexiconEntries: lexicon.size,
    tokens: tokens.size,
    curatedOverlayEntries: assets.overlay.entries.size,
    maxWordLength: assets.maxLength,
  }

  // A抢词 case from README: 学会计 splits as 学会/计, so 会 falls back to
  // its single-character default hui4 instead of the curated kuai4.
  const cases = [
    { label: '抢词场景', text: '他学会计出身的。', tokens: ['xue2', 'kuai4', 'ji4'] },
    { label: '普通短句', text: '他答应了一声。', tokens: ['ta1', 'da1', 'ying4', 'le', 'yi1', 'sheng1'] },
    { label: '数字与标点', text: '一共 123 元。', tokens: ['yi1', 'gong4', 'yi1', 'er4', 'san1', 'yuan2'] },
  ]

  const synth = await createMatchaSynth({ quiet: true })
  try {
    for (const item of cases) {
      const direct = stats(synth.generate(item.tokens))
      const textPath = stats(synth.generateText(item.text))
      report.cases.push({
        label: item.label,
        text: item.text,
        tokens: item.tokens,
        direct,
        textPath,
        ratio: Number((direct.audioMs / Math.max(1, textPath.audioMs)).toFixed(3)),
      })
      console.log(`  ${item.label}: 音素直输 ${direct.audioMs}ms / 词典路径 ${textPath.audioMs}ms`)
    }

    // Proof of bypass: build a second synth with a DELIBERATELY WRONG lexicon
    // row for 会计. The text path must change, the token path must not.
    const patchedPath = join(ROOT, 'scripts/out/phoneme-spike-patched-lexicon.txt')
    const baseLexicon = await readFile(
      join(ROOT, 'public/models/matcha-icefall-zh-baker/lexicon.v3.txt'),
      'utf8',
    )
    await writeFile(
      patchedPath,
      `${baseLexicon.trimEnd()}\n会计 hui4 ji4\n`,
      'utf8',
    )
    const patched = await createMatchaSynth({ quiet: true, lexiconPath: patchedPath })
    try {
      // Control experiment FIRST: Matcha uses noiseScale=0.667, so even the
      // SAME instance with the SAME tokens may produce different samples.
      // Without this control, "samples differ" proves nothing about lexicons.
      const sameA = synth.generate(['xue2', 'kuai4', 'ji4']).samples
      const sameB = synth.generate(['xue2', 'kuai4', 'ji4']).samples
      report.sameInstanceDeterministic = sameA.length === sameB.length &&
        sameA.every((value, index) => value === sameB[index])

      const directA = synth.generate(['xue2', 'kuai4', 'ji4']).samples
      const directB = patched.generate(['xue2', 'kuai4', 'ji4']).samples
      const textA = synth.generateText('会计').samples
      const textB = patched.generateText('会计').samples
      const sameSamples = (a, b) => a.length === b.length &&
        a.every((value, index) => value === b[index])
      report.tokenPathSamplesEqualAcrossLexicons = sameSamples(directA, directB)
      report.textPathSamplesEqualAcrossLexicons = sameSamples(textA, textB)

      // Robust evidence: compare audio DURATION, which reflects the token
      // sequence and is not affected by noise. A wrong lexicon row changes the
      // text path's duration/structure but must not change the token path.
      report.tokenPathDurationMs = {
        defaultLexicon: Math.round(directA.length / 22050 * 1000),
        patchedLexicon: Math.round(directB.length / 22050 * 1000),
      }
      report.textPathDurationMs = {
        defaultLexicon: Math.round(textA.length / 22050 * 1000),
        patchedLexicon: Math.round(textB.length / 22050 * 1000),
      }
      // The patched-row comparison is INCONCLUSIVE: the C++ lexicon may keep
      // the first duplicate, and Matcha noise makes sample equality unusable.
      // The runtime's own debug token log below is the actual ground truth.
      report.bypassConclusion = report.sameInstanceDeterministic
        ? '同一实例可复现，逐样本比较可用。'
        : '同一实例逐样本也不可复现（noiseScale 随机），且追加的重复词典行是否被 C++ 采用未知；逐样本/时长对照均不作为判据，改用 runtime debug token 日志。'
      console.log(`  同一实例逐样本可复现：${report.sameInstanceDeterministic}`)
      console.log(`  token 路径时长（默认/错误词典）：${JSON.stringify(report.tokenPathDurationMs)}`)
      console.log(`  词典路径时长（默认/错误词典）：${JSON.stringify(report.textPathDurationMs)}`)
    } finally {
      patched.free()
    }

    // Ground truth: capture the runtime's own front-end token log. Emscripten
    // writes to the process streams directly, so run each path in its own
    // child process and parse the raw stdout+stderr.
    const probe = (mode) => {
      const result = spawnSync(
        process.execPath,
        ['scripts/spike/phoneme-direct-log.mjs', mode],
        { cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      )
      return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    }
    const directLog = probe('tokens')
    const textLog = probe('text')
    const tokenSentence = /Sentence 0 tokens: (\[[^\]]*\])/.exec(directLog)?.[1] ?? null
    report.debugTokenLogs = {
      tokenPathTokens: tokenSentence,
      tokenPathUsedLexiconTokenizer: directLog.includes('TokenizeFromLexiconStr'),
      tokenPathGenerationConfig: /tokens=\[1 sentences\]/.test(directLog),
      textPathUsedLexiconTokenizer: textLog.includes('TokenizeFromLexiconStr'),
      textPathMatched: /Lexicon matched: '会计' -> '([^']*)'/.exec(textLog)?.[1] ?? null,
      textPathTokens: /Sentence 0 tokens: (\[[^\]]*\])/.exec(textLog)?.[1] ?? null,
    }
    // Decisive evidence: pre-phonemized input carries the exact token sequence
    // and never enters the lexicon longest-match tokenizer, while text does.
    report.bypassesLexicon = Boolean(
      tokenSentence &&
      !report.debugTokenLogs.tokenPathUsedLexiconTokenizer &&
      report.debugTokenLogs.textPathUsedLexiconTokenizer,
    )
    console.log(`  token 路径绕过词典（debug 日志判据）：${report.bypassesLexicon}`)
    console.log(`  token 路径实际序列：${tokenSentence}`)

    // tokens / phonemeCodepoints mutual exclusion is implemented in the C API
    // and documented in the vendored JS; the wrapper only exposes tokens.
    const runtimeSource = await readFile(
      join(ROOT, 'public/sherpa/runtime/sherpa-onnx-tts.js'),
      'utf8',
    )
    report.mutuallyExclusiveProbe = {
      tokensValidated: runtimeSource.includes("validateNestedArray('tokens'"),
      phonemeCodepointsValidated: runtimeSource.includes("validateNestedArray('phonemeCodepoints'"),
      exclusionDocumented: runtimeSource.includes('mutually exclusive'),
      note: 'createMatchaSynth 只暴露 generate(tokens)，未暴露 phonemeCodepoints；二者互斥由 C API 记录。',
    }

    // How much work does "sentence -> token stream" require? Measure the
    // longest-match lookup cost and how many entries a naive G2P must consult.
    const corpus = '他学会计出身的，后来在银行工作，还给重庆的朋友写了一封信。'
    const t0 = performance.now()
    let lookups = 0
    for (let i = 0; i < corpus.length; i += 1) {
      for (let len = Math.min(assets.maxLength, corpus.length - i); len >= 1; len -= 1) {
        lookups += 1
        if (lexicon.has(corpus.slice(i, i + len))) break
      }
    }
    const lookupMs = performance.now() - t0
    report.g2p = {
      chars: Array.from(corpus).length,
      longestMatchLookups: lookups,
      lookupMs: Number(lookupMs.toFixed(3)),
      note: 'A pre-phonemized pipeline still needs a tokenizer + polyphone disambiguator; this is the real cost, not the WASM call.',
    }
  } finally {
    synth.free()
  }

  report.findings = [
    'runtime JS 已实现 phonemeCodepoints / tokens 的校验、marshalling 与互斥检查；scripts/lib/matchaSynth.mjs 已在用真实 WASM 做空文本 + 纯 token 序列合成，C 侧前提成立。',
    'worker 目前只发 text；要落地需扩展 synth 消息、SherpaDriver 透传、以及一个「整句→token 序列」的前端（分词 + 多音字消歧 + 数字/日期归一化），而不是改 runtime。',
    '音素直输会绕过 ruleFsts（phone/date/number）与全部 overlay；数字、日期、标点、专有名词的既有规则必须在新前端里重新实现，否则会回归。',
    '词典路径的抢词问题（学会计→学会/计）在音素直输下消失，但前提是前端能正确判定「会」读 kuai4 —— 消歧问题只是从词典搬到了前端，并未消失。',
  ]

  await mkdir(join(ROOT, 'scripts/out'), { recursive: true })
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`报告 ${OUT}`)
  console.log(`token 路径是否绕过词典：${report.bypassesLexicon}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
