import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  generateBookLexicon,
  MAX_BOOK_OVERLAY_ENTRIES,
  type BookLexiconInput,
} from '@/core/tts/bookLexicon'

interface ManifestFile {
  name: string
  url: string
}

interface ManifestPack {
  id: string
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
const tokensFile = pack.files.find((file) => file.name === 'tokens.txt')!

function readModelFile(file: ManifestFile): string {
  return readFileSync(resolve(root, 'public', file.url), 'utf8')
}

const lexiconText = readModelFile(lexiconFile)
const tokensText = readModelFile(tokensFile)
const curatedOverlay = readFileSync(
  resolve(root, 'src/core/tts/polyphones.v1.txt'),
  'utf8',
)
const curatedWithoutPukai = curatedOverlay.replace(/^铺开 .*$/m, '')

function generate(
  chunks: string[],
  overrides: Partial<BookLexiconInput> = {},
): ReturnType<typeof generateBookLexicon> {
  return generateBookLexicon({
    chunks,
    lexiconText,
    tokensText,
    curatedOverlay,
    ...overrides,
  })
}

describe('generateBookLexicon', () => {
  it('recovers an OOV word whose phrase reading differs from single chars', () => {
    const result = generate(['他把信纸轻轻铺开，读了起来。'], {
      curatedOverlay: curatedWithoutPukai,
    })
    expect(result.entries).toEqual([
      { word: '铺开', reading: 'pu1 kai1', count: 1 },
    ])
    expect(result.overlay).toContain('铺开 pu1 kai1')
    expect(result.stats.entries).toBe(1)
  })

  it('does not touch words already covered by the curated overlay', () => {
    const result = generate(['他把信纸轻轻铺开，读了起来。'])
    expect(result.entries).toEqual([])
    expect(result.overlay).toBe('')
  })

  it('does not touch words the bundled lexicon already knows', () => {
    const result = generate(['校长走进教室，同学们站了起来。'])
    expect(result.entries.map((entry) => entry.word)).not.toContain('校长')
  })

  it('rejects readings that need a neutral phone outside the whitelist', () => {
    const result = generate(['师傅点了点头，没有说话。'])
    expect(result.entries.map((entry) => entry.word)).not.toContain('师傅')
  })

  it('rejects OOV words that contain characters the curated overlay guards', () => {
    const synthetic = {
      lexiconText: ['尽 jin4', '管 guan3', '下 xia4', '雨 yu3'].join('\n'),
      tokensText: ['jin2', 'jin3', 'guan3', 'xia4', 'yu3'].join('\n'),
      curatedOverlay: '',
    }
    const accepted = generate(['尽管下雨。'], synthetic)
    expect(accepted.entries).toEqual([
      { word: '尽管', reading: 'jin2 guan3', count: 1 },
    ])

    const guarded = generate(['尽管下雨。'], {
      ...synthetic,
      curatedOverlay: '尽先 jin3 xian1',
    })
    expect(guarded.entries).toEqual([])
  })

  it('applies 3+3 sandhi to the generated reading', () => {
    const result = generate(['尽管下雨。'], {
      lexiconText: ['尽 jin4', '管 guan3'].join('\n'),
      tokensText: ['jin2', 'guan3'].join('\n'),
      curatedOverlay: '',
    })
    expect(result.entries[0]).toMatchObject({
      word: '尽管',
      reading: 'jin2 guan3',
    })
  })

  it('adds adverbial 地 for patterned and curated stems', () => {
    const result = generate([
      '他剧烈地咳嗽，把书整整齐齐地排好，又小心翼翼地站起来。',
    ])
    const entries = new Map(
      result.entries.map((entry) => [entry.word, entry.reading]),
    )
    expect(entries.get('剧烈地')).toBe('ju4 lie4 de')
    expect(entries.get('整整齐齐地')).toBe('zheng2 zheng3 qi2 qi2 de')
    expect(entries.get('小心翼翼地')).toBe('xiao3 xin1 yi4 yi4 de')
    expect(result.stats.entries).toBe(result.entries.length)
  })

  it('leaves noun 地 compounds alone', () => {
    const result = generate(['他坐在泥地，走过水泥地和工地，回到土地。'])
    const words = result.entries.map((entry) => entry.word)
    for (const noun of ['泥地', '水泥地', '工地', '土地']) {
      expect(words, noun).not.toContain(noun)
    }
    expect(words.filter((word) => word.endsWith('地'))).toEqual([])
  })

  it('normalizes 一 sandhi inside ABAB adverbs', () => {
    const result = generate(['他一下一下地敲，又一笔一笔地写，还一次次地敲门。'])
    const entries = new Map(
      result.entries.map((entry) => [entry.word, entry.reading]),
    )
    expect(entries.get('一下一下地')).toBe('yi2 xia4 yi2 xia4 de')
    expect(entries.get('一笔一笔地')).toBe('yi4 bi3 yi4 bi3 de')
    expect(entries.get('一次次地')).toBe('yi2 ci4 ci4 de')
  })

  it('rejects repeated stems whose readings disagree across positions', () => {
    const result = generate(['他把名单一行一行地念完。'])
    expect(result.entries.map((entry) => entry.word)).not.toContain(
      '一行一行地',
    )
  })

  it('uses the lexicon reading for a known stem before 地', () => {
    const result = generate(['他本能地后退了一步。'])
    const entries = new Map(
      result.entries.map((entry) => [entry.word, entry.reading]),
    )
    expect(entries.get('本能地')).toBe('ben3 neng2 de')
  })

  it('drops words whose phones are missing from tokens.txt', () => {
    const result = generate(['尽管下雨。'], {
      lexiconText: ['尽 jin4', '管 guan3'].join('\n'),
      tokensText: ['jin2'].join('\n'),
      curatedOverlay: '',
    })
    expect(result.entries).toEqual([])
  })

  it('caps the number of entries and reports truncation', () => {
    const result = generate(['尽管处理下雨。'], {
      lexiconText: ['尽 jin4', '管 guan3', '处 chu4', '理 li3'].join('\n'),
      tokensText: ['jin2', 'guan3', 'chu2', 'li3'].join('\n'),
      curatedOverlay: '',
      maxEntries: 1,
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries.length + result.stats.truncated).toBe(2)
    expect(result.stats.truncated).toBe(1)
  })

  it('counts repeated occurrences and keeps the overlay deterministic', () => {
    const first = generate(['尽管下雨。', '尽管很冷。'], {
      lexiconText: ['尽 jin4', '管 guan3'].join('\n'),
      tokensText: ['jin2', 'guan3'].join('\n'),
      curatedOverlay: '',
    })
    const second = generate(['尽管很冷。', '尽管下雨。'], {
      lexiconText: ['尽 jin4', '管 guan3'].join('\n'),
      tokensText: ['jin2', 'guan3'].join('\n'),
      curatedOverlay: '',
    })
    expect(first.entries[0].count).toBe(2)
    expect(first.overlay).toBe(second.overlay)
  })

  it('exposes a sane default cap', () => {
    expect(MAX_BOOK_OVERLAY_ENTRIES).toBe(2000)
  })
})
