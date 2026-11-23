#!/usr/bin/env node
/**
 * Periodic OOV recall audit:
 *
 *   npm run oov:recall -- --corpus=public/sample.epub --sample=20
 *
 * Writes a deterministic sample of OOV words the acoustic detector did NOT
 * flag. This is a human listening queue, not an automatic repair list.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ROOT, loadMatchaAssets } from './lib/reading.mjs'
import { loadCorpus } from './lib/corpus.mjs'
import { collectRecallSample } from './lib/oovRecall.mjs'
import { currentProvenance } from './lib/provenance.mjs'

const OUT = resolve(ROOT, 'scripts/out/oov-recall.jsonl')
const SUMMARY = resolve(ROOT, 'scripts/out/oov-recall.md')

function parseArgs(argv) {
  const options = {
    corpus: 'public/sample.epub',
    sample: 20,
    out: OUT,
    summary: SUMMARY,
  }
  for (const arg of argv) {
    if (arg.startsWith('--corpus=')) options.corpus = arg.slice(9)
    else if (arg.startsWith('--sample=')) options.sample = Number(arg.slice(9)) || 20
    else if (arg.startsWith('--out=')) options.out = resolve(ROOT, arg.slice(6))
    else if (arg.startsWith('--summary=')) options.summary = resolve(ROOT, arg.slice(10))
  }
  return options
}

async function main(options) {
  const [assets, corpus] = await Promise.all([
    loadMatchaAssets(),
    loadCorpus(resolve(ROOT, options.corpus)),
  ])
  const result = collectRecallSample(corpus.text, assets, { sample: options.sample })
  mkdirSync(dirname(options.out), { recursive: true })
  mkdirSync(dirname(options.summary), { recursive: true })
  writeFileSync(
    options.out,
    [
      `# provenance ${JSON.stringify(currentProvenance())}`,
      ...result.sample.map((item) => JSON.stringify(item)),
      '',
    ].join('\n'),
    'utf8',
  )
  const lines = [
    '# OOV 召回抽样（advisory）',
    '',
    `- 语料：${corpus.path}`,
    `- 词典命中：${result.dictionary} 个双字词`,
    `- 探测器命中：${result.found} 个 OOV 声学候选`,
    `- 未命中 OOV：${result.missed} 个（本次抽样 ${result.sample.length} 个）`,
    '',
    '> 未命中不等于错误；这里只列出探测器看不见的词，供定期人工复听。3–6 字词不进入自动声学修复。',
    '',
    '| 词长 | 词典命中 | 探测器命中 | 未命中 |',
    '| ---: | ---: | ---: | ---: |',
  ]
  for (const [length, counts] of Object.entries(result.byLength)) {
    lines.push(`| ${length} | ${counts.dictionary} | ${counts.found} | ${counts.missed} |`)
  }
  lines.push('', '## 本次抽样', '',
    '| 词 | 词长 | 出现 | 证据 |',
    '| --- | ---: | ---: | --- |',
  )
  for (const item of result.sample) {
    lines.push(`| ${item.word} | ${item.length} | ${item.count} | ${String(item.evidence[0] ?? '').replace(/\|/g, '\\|').slice(0, 50)} |`)
  }
  writeFileSync(options.summary, `${lines.join('\n')}\n`, 'utf8')
  console.log(`OOV 召回抽样：found ${result.found} / missed ${result.missed} / sample ${result.sample.length}`)
  console.log(`报告 ${options.summary}`)
}

main(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
