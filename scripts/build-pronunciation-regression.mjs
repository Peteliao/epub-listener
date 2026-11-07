#!/usr/bin/env node
// Builds a layered pronunciation *consistency* snapshot from the curated
// overlay. This is NOT an independent ground truth: each case pins the reading
// the current lexicon + overlay actually produces, so any later edit to either
// file shows up as an explicit, reviewable change instead of a silent drift.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadMatchaAssets, readingAt, ROOT } from './lib/reading.mjs'

const OUT_PATH = join(ROOT, 'tests', 'fixtures', 'pronunciation-regression.jsonl')
const FAMILIES = [
  '长', '还', '载', '着', '地', '得', '差', '薄', '剥', '落',
  '和', '为', '行', '重', '中', '种', '转', '钻', '作', '数',
  '教', '背', '盛', '单', '解', '区', '仇', '六', '应', '与',
  '扎', '涨', '露', '蒙', '难', '宁', '片', '曲', '散', '扫',
  '色', '舍', '似', '宿', '提', '挑', '吐', '吓', '鲜', '相',
  '兴', '血', '咽', '要', '卷', '看', '空', '累', '量', '了',
  '尽', '劲', '将', '间', '济', '几', '会', '哄', '横', '冠',
  '更', '干', '缝', '分', '发', '恶', '倒', '当', '弹', '创',
  '传', '处', '称', '参', '泊', '塞', '澄', '爪', '熨', '臭',
  '勒', '度', '丽', '峙', '解', '炮', '削', '薄', '藏', '晃',
]

function familyOf(word) {
  for (const char of Array.from(word)) {
    if (FAMILIES.includes(char)) return char
  }
  return 'other'
}

const assets = await loadMatchaAssets()
const lines = []
const counts = new Map()
let skipped = 0
let index = 0

for (const [word, reading] of assets.overlay.entries) {
  const chars = Array.from(word)
  const phones = reading.split(/\s+/)
  if (phones.length !== chars.length) {
    skipped += 1
    continue
  }
  const text = `${word}。`
  const readings = []
  let usable = true
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]
    const occurrence =
      chars.slice(0, i + 1).filter((item) => item === char).length
    try {
      const resolved = readingAt(text, char, occurrence, assets.effective)
      if (!resolved.phone) {
        usable = false
        break
      }
      readings.push([char, occurrence, resolved.phone])
    } catch {
      usable = false
      break
    }
  }
  if (!usable) {
    skipped += 1
    continue
  }
  index += 1
  const family = familyOf(word)
  counts.set(family, (counts.get(family) ?? 0) + 1)
  lines.push(
    JSON.stringify({
      id: `reg-${String(index).padStart(4, '0')}`,
      tier: 'overlay-snapshot',
      family,
      word,
      text,
      readings,
    }),
  )
}

const header = [
  '# 山岚覆盖表一致性快照；由 scripts/build-pronunciation-regression.mjs 生成。',
  '# 这不是独立读音真值：改动词典或覆盖表后，请人工复核 diff 再重建本文件。',
]
await writeFile(OUT_PATH, `${header.join('\n')}\n${lines.join('\n')}\n`, 'utf8')

const families = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log(`写入 ${OUT_PATH}`)
console.log(`用例 ${lines.length} 条 / 读音点 ${lines.reduce((n, line) => n + JSON.parse(line).readings.length, 0)} 个 / 字族 ${families.filter(([name]) => name !== 'other').length} 个`)
console.log(`跳过 ${skipped} 条（音素数与字数不符或无法解析）`)
console.log(`覆盖最多的字族：${families.slice(0, 12).map(([name, count]) => `${name}×${count}`).join('、')}`)
