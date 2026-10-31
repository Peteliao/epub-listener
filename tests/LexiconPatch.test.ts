import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ManifestFile {
  name: string
  url: string
  bytes: number
  sha256: string
}

interface ManifestPack {
  id: string
  totalBytes: number
  files: ManifestFile[]
  model: { config: Record<string, string> }
}

const root = process.cwd()

const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/manifest.json'), 'utf8'),
) as { packs: ManifestPack[] }

const pack = manifest.packs.find((item) => item.id === 'matcha-icefall-zh-baker')!
const lexiconFile = pack.files.find(
  (file) => file.name === pack.model.config.lexicon,
)!

function readFile(file: ManifestFile): Buffer {
  return readFileSync(resolve(root, 'public', file.url))
}

function parseLexicon(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of buffer.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const space = trimmed.indexOf(' ')
    if (space <= 0) continue
    // sherpa-onnx ignores duplicated words, so the first entry is effective.
    // Intended corrections live in src/core/tts/polyphones.v1.txt instead.
    if (!entries.has(trimmed.slice(0, space))) {
      entries.set(trimmed.slice(0, space), trimmed.slice(space + 1))
    }
  }
  return entries
}

describe('matcha lexicon patch', () => {
  it('matches the manifest byte count and hash', () => {
    const buffer = readFile(lexiconFile)
    expect(buffer.byteLength).toBe(lexiconFile.bytes)
    expect(createHash('sha256').update(buffer).digest('hex')).toBe(
      lexiconFile.sha256,
    )
    expect(pack.files.reduce((total, file) => total + file.bytes, 0)).toBe(
      pack.totalBytes,
    )
  })

  it('contains the corrected polyphone and tone readings', () => {
    const lexicon = parseLexicon(readFile(lexiconFile))
    expect(lexicon.get('了解')).toBe('liao2 jie3')
    expect(lexicon.get('可以')).toBe('ke2 yi3')
    expect(lexicon.get('大夫')).toBe('dai4 fu1')
    expect(lexicon.get('生意')).toBe('sheng1 yi')
    expect(lexicon.get('难得')).toBe('nan2 de')
    expect(lexicon.get('长')).toBe('zhang3')
    expect(lexicon.get('长大')).toBe('zhang3 da4')
    expect(lexicon.get('长者')).toBe('zhang2 zhe3')
    expect(lexicon.get('行长')).toBe('hang2 zhang3')
  })

  it('resolves duplicated entries first-wins, leaving particles to the overlay', () => {
    const lexicon = parseLexicon(readFile(lexiconFile))
    expect(lexicon.get('地')).toBe('di4')
    expect(lexicon.get('得')).toBe('de2')
    expect(lexicon.get('舍得')).toBe('she4 de')
    expect(lexicon.get('过得去')).toBe('guo4 dei3 qu4')
    expect(lexicon.get('忽地')).toBe('hu1 di4')
    expect(lexicon.get('突地')).toBe('tu1 di4')
    expect(lexicon.get('总得')).toBe('zong2 dei3')
  })

  it('keeps 过 as guo4 instead of an untrained neutral phone', () => {
    const lexicon = parseLexicon(readFile(lexiconFile))
    expect(lexicon.get('过')).toBe('guo4')
    expect(lexicon.get('经过')).toBe('jing1 guo4')
    expect(lexicon.get('走过')).toBe('zou3 guo4')
    expect(lexicon.get('信不过')).toBe('xin4 bu4 guo4')
  })

  it('keeps noun and verb readings protected by longer words', () => {
    const lexicon = parseLexicon(readFile(lexiconFile))
    expect(lexicon.get('土地')).toBe('tu3 di4')
    expect(lexicon.get('营地')).toBe('ying2 di4')
    expect(lexicon.get('各地')).toBe('ge4 di4')
    expect(lexicon.get('目的地')).toBe('mu4 di4 di4')
    expect(lexicon.get('克罗地亚')).toBe('ke4 luo2 di4 ya4')
    expect(lexicon.get('在地')).toBe('zai4 di4')
    expect(lexicon.get('得到')).toBe('de2 dao4')
    expect(lexicon.get('彼得')).toBe('bi3 de2')
  })

  it('keeps V+不得 base readings for the overlay to correct', () => {
    const lexicon = parseLexicon(readFile(lexiconFile))
    expect(lexicon.get('怪不得')).toBe('guai4 bu4 de2')
    expect(lexicon.get('舍不得')).toBe('she3 bu4 de2')
    expect(lexicon.get('算不得')).toBe('suan4 bu4 de')
    expect(lexicon.get('不记得')).toBe('bu2 ji4 de2')
    expect(lexicon.get('少不得')).toBe('shao4 bu4 de2')
  })

  it('never uses neutral phones the acoustic model was not trained on', () => {
    const lexicon = parseLexicon(readFile(lexiconFile))
    const untrained = new Set([
      'lai', 'guo', 'sheng', 'huan', 'si', 'ge', 'hou', 'mian',
      'dao', 'nao', 'niang', 'zhuang', 'lao', 'bu',
    ])
    const offenders: string[] = []
    for (const [word, reading] of lexicon) {
      for (const phone of reading.split(' ')) {
        if (untrained.has(phone)) offenders.push(`${word}: ${reading}`)
      }
    }
    expect(offenders).toEqual([])
    expect(lexicon.get('来')).toBe('lai2')
    expect(lexicon.has('下来')).toBe(false)
    expect(lexicon.has('回来')).toBe(false)
    expect(lexicon.has('先生')).toBe(false)
    expect(lexicon.has('喜欢')).toBe(false)
    expect(lexicon.get('意思')).toBe('yi4 si1')
    expect(lexicon.get('这个')).toBe('zhe4 ge4')
  })
})
