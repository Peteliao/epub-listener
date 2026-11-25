import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const compiler = join(root, 'scripts/compile-word-family.mjs')

async function loadCompiler() {
  return await import('../scripts/compile-word-family.mjs') as any
}

function fixtureAssets(extra: Array<[string, string, 'lexicon' | 'overlay']> = []) {
  const lexicon = new Map<string, string>([
    ['一', 'yi1'], ['倒', 'dao4'], ['给', 'gei3'], ['累', 'lei4'], ['抛', 'pao1'],
    ['晕', 'yun1'], ['推', 'tui1'], ['教', 'jiao1'], ['分', 'fen1'], ['发', 'fa1'],
    ['还', 'huan2'], ['躺', 'tang3'], ['晃', 'huang3'], ['起', 'qi3'], ['切', 'qie4'],
    ['倒下', 'dao3 xia4'], ['摔倒', 'shuai1 dao3'], ['晕倒', 'yun1 dao3'],
    ['跌倒', 'die1 dao3'], ['躺倒', 'tang2 dao3'], ['一晃', 'yi4 huang3'],
    ['一切', 'yi2 qie4'], ['交给', 'jiao1 gei3'], ['送给', 'song4 gei3'],
    ['还给', 'huan2 gei3'], ['教给', 'jiao1 gei3'], ['分给', 'fen1 gei3'],
    ['发给', 'fa1 gei3'], ['倒水', 'dao4 shui3'], ['倒茶', 'dao4 cha2'],
    ['给予', 'ji2 yu3'], ['配给', 'pei4 ji3'], ['供给', 'gong1 ji3'],
  ])
  const overlay = new Map<string, string>([['递给', 'di4 gei3']])
  for (const [word, reading, layer] of extra) {
    if (layer === 'overlay') overlay.set(word, reading)
    else lexicon.set(word, reading)
  }
  const effective = new Map(lexicon)
  for (const [word, reading] of overlay) effective.set(word, reading)
  const tokens = new Set<string>()
  for (const reading of effective.values()) {
    for (const phone of reading.split(/\s+/)) if (phone && phone !== '"') tokens.add(phone)
  }
  tokens.add('yi4')
  return { lexicon, overlay: { entries: overlay }, effective, tokens, neutrals: new Set<string>(), maxLength: 4 }
}

function run(args: string[]) {
  return spawnSync(process.execPath, [compiler, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
}

function records(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shusheng-word-family-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('B1 word-family candidate compiler', () => {
  it('生成三类模板，按差异字拆行，并只使用词典/人工表读音', async () => {
    const { compileWordFamily, validateCandidateRows } = await loadCompiler()
    const result = compileWordFamily({ assets: fixtureAssets(), corpora: [] })
    const rows = result.rows

    expect(validateCandidateRows(rows)).toEqual([])
    expect(rows.filter((row: any) => row.word === '一倒').map((row: any) => [row.offset, row.phone]))
      .toEqual([[0, 'yi4'], [1, 'dao3']])
    expect(rows.find((row: any) => row.word === '一抛')).toMatchObject({
      offset: 0, phone: 'yi4', reading: 'yi4 pao1', status: 'candidate', scope: 'word',
    })
    expect(rows.find((row: any) => row.word === '累倒')).toMatchObject({
      offset: 1, phone: 'dao3', reading: 'lei4 dao3', templateKey: 'xDao',
    })
    expect(rows.find((row: any) => row.word === '倒给')).toMatchObject({
      offset: 0, phone: 'dao3', reading: 'dao3 gei3', templateKey: 'vGei',
    })
    const fromOverlay = rows.find((row: any) => row.word === '一递' && row.offset === 1)
    expect(fromOverlay?.readingSources).toContainEqual({ word: '递给', layer: 'overlay', offset: 0, phone: 'di4' })
    expect(rows.every((row: any) => row.context === null && row.evidence.length === 0)).toBe(true)
    expect(rows.every((row: any) => row.note.includes('无真实语境'))).toBe(true)
  })

  it('排除倒水/倒茶及给予/配给等非目标词，X+倒只 dao3，V+给只 gei3', async () => {
    const { compileWordFamily, EXCLUDED_WORDS } = await loadCompiler()
    const result = compileWordFamily({ assets: fixtureAssets(), corpora: [] })
    const words = new Set(result.rows.map((row: any) => row.word))
    for (const word of ['倒水', '倒茶', '倒酒', '给予', '配给', '供给', '自给', '补给', '进给', '仰给', '薪给']) {
      expect(EXCLUDED_WORDS).toContain(word)
      expect(words.has(word), word).toBe(false)
    }
    expect(result.rows.filter((row: any) => row.templateKey === 'xDao').every((row: any) => row.reading.endsWith(' dao3'))).toBe(true)
    expect(result.rows.filter((row: any) => row.templateKey === 'vGei').every((row: any) => row.reading.endsWith(' gei3'))).toBe(true)
  })

  it('effective/overlay 同音整词去重，包括一声调的一-V', async () => {
    const { compileWordFamily } = await loadCompiler()
    const assets = fixtureAssets([
      ['推倒', 'tui1 dao3', 'overlay'],
      ['累倒', 'lei4 dao3', 'lexicon'],
    ])
    const result = compileWordFamily({ assets, corpora: [] })
    const words = new Set(result.rows.map((row: any) => row.word))
    expect(words.has('晕倒')).toBe(false)
    expect(words.has('推倒')).toBe(false)
    expect(words.has('累倒')).toBe(false)
    expect(words.has('一晃')).toBe(false)
    expect(words.has('一切')).toBe(false)
    expect(result.dedup).toContainEqual(expect.objectContaining({ word: '推倒', layer: 'overlay' }))
    expect(result.dedup).toContainEqual(expect.objectContaining({ word: '晕倒', layer: 'lexicon' }))
  })

  it('已有整词异音时拒绝候选，但不把风险冲突当作结构错误', async () => {
    const { compileWordFamily, validateCandidateRows } = await loadCompiler()
    const result = compileWordFamily({
      assets: fixtureAssets([['累倒', 'lei4 dao4', 'overlay']]),
      corpora: [],
    })
    expect(result.rows.some((row: any) => row.word === '累倒')).toBe(false)
    expect(result.conflicts).toContainEqual(expect.objectContaining({
      kind: 'effective-reading', word: '累倒', current: 'lei4 dao4', proposed: 'lei4 dao3', layer: 'overlay',
    }))
    expect(validateCandidateRows(result.rows)).toEqual([])
  })

  it('相同输入重复生成的 JSONL 字节完全一致', async () => {
    const { compileWordFamily, serializeCandidates } = await loadCompiler()
    const assets = fixtureAssets()
    const corpora = [{ source: 'book.txt', text: '他往后一躺。', sentencesList: ['他往后一躺。'] }]
    const first = compileWordFamily({ assets, corpora })
    const second = compileWordFamily({ assets, corpora })
    expect(first).toEqual(second)
    expect(serializeCandidates(first.rows)).toBe(serializeCandidates(second.rows))
  })

  it('语料只补完整语境，不改变候选读音', async () => {
    const { compileWordFamily } = await loadCompiler()
    const assets = fixtureAssets()
    const sentence = '他把水倒给我，又往后一躺，最后累倒在椅子上。'
    const plain = compileWordFamily({ assets, corpora: [] })
    const contextual = compileWordFamily({
      assets,
      corpora: [{ source: 'book.txt', text: sentence, sentencesList: [sentence], sentences: 1 }],
    })
    expect(contextual.rows.map((row: any) => [row.word, row.offset, row.phone, row.reading]))
      .toEqual(plain.rows.map((row: any) => [row.word, row.offset, row.phone, row.reading]))
    for (const word of ['倒给', '一躺', '累倒']) {
      expect(contextual.rows.find((row: any) => row.word === word)?.context).toBe(sentence)
      expect(contextual.rows.find((row: any) => row.word === word)?.evidence).toEqual([sentence])
    }
    expect(contextual.summary.withContext).toBeGreaterThan(0)
    expect(contextual.summary.noRealContext).toBe(false)
  })

  it('astral 字符不破坏整词覆盖的码点偏移判断', async () => {
    const { collectContexts } = await loadCompiler()
    const blocked = '😀一躺倒。'
    const valid = '他往后一躺。'
    const assets = fixtureAssets([['一躺倒', 'yi4 tang3 dao3', 'lexicon']])
    const proposals = [{ word: '一躺', templateKey: 'yiVerb' }]
    expect(collectContexts(proposals, [{
      source: 'book.txt', text: blocked, sentencesList: [blocked],
    }], assets).has('一躺')).toBe(false)
    expect(collectContexts(proposals, [{
      source: 'book.txt', text: valid, sentencesList: [valid],
    }], assets).get('一躺')).toEqual([{ sentence: valid, source: 'book.txt' }])
  })

  it('CLI 默认风险候选为零退出，--verify 拒绝结构损坏的输出', async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, 'candidates.jsonl')
      const report = join(dir, 'report.json')
      const compiled = run([`--out=${out}`, `--report=${report}`])
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0)
      expect(compiled.stdout).toContain('无真实语境')
      const rows = records(await readFile(out, 'utf8'))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.context === null)).toBe(true)

      const verified = run(['--verify', `--out=${out}`, `--report=${report}`])
      expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0)
      expect(verified.stdout).toContain('验证通过')

      rows[0].status = 'approved'
      await writeFile(out, `${recordsText(rows)}\n`, 'utf8')
      const broken = run(['--verify', `--out=${out}`, `--report=${report}`])
      expect(broken.status).not.toBe(0)
      expect(broken.stderr).toContain('输出结构错误')
    })
  }, 30_000)

  it('读取 EPUB 完整章节语境，输出确定且可通过 --verify', async () => {
    await withTempDir(async (dir) => {
      const epub = join(dir, 'book.epub')
      const out = join(dir, 'candidates.jsonl')
      const report = join(dir, 'report.json')
      const sentence = '他把球抛给我，又往后一躺，最后累倒在椅子上。'
      const zip = new JSZip()
      zip.file('mimetype', 'application/epub+zip')
      zip.file('META-INF/container.xml', `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
      zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`)
      zip.file('OEBPS/chapter.xhtml', `<html><body><p>${sentence}</p><p>她正在倒水，也在配给粮食。</p></body></html>`)
      await writeFile(epub, await zip.generateAsync({ type: 'nodebuffer' }))

      const args = [`--corpus=${epub}`, `--out=${out}`, `--report=${report}`]
      const first = run(args)
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0)
      const bytes = await readFile(out, 'utf8')
      const rows = records(bytes)
      for (const word of ['一躺', '累倒']) {
        expect(rows.find((row) => row.word === word)?.context).toBe(sentence)
      }
      expect(rows.some((row) => ['倒水', '配给'].includes(row.word))).toBe(false)

      const second = run(args)
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0)
      expect(await readFile(out, 'utf8')).toBe(bytes)
      const verified = run(['--verify', `--corpus=${epub}`, `--out=${out}`])
      expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0)
      expect(verified.stdout).toContain('真实完整语境')
    })
  }, 30_000)

  it('--corpus 接受目录并递归读取完整句子', async () => {
    await withTempDir(async (dir) => {
      const corpusDir = join(dir, 'corpus')
      await mkdir(join(corpusDir, 'nested'), { recursive: true })
      await writeFile(join(corpusDir, 'a.txt'), '他往后一躺。\n', 'utf8')
      await writeFile(join(corpusDir, 'nested', 'b.txt'), '她累倒了。\n', 'utf8')
      const out = join(dir, 'candidates.jsonl')
      const result = run([`--corpus=${corpusDir}`, `--out=${out}`, `--report=${join(dir, 'report.json')}`])
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const rows = records(await readFile(out, 'utf8'))
      expect(rows.find((row) => row.word === '一躺')?.context).toBe('他往后一躺。')
      expect(rows.find((row) => row.word === '累倒')?.context).toBe('她累倒了。')
    })
  }, 30_000)

  it('package.json 暴露编译与验证脚本', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['compile:word-family']).toBe('node scripts/compile-word-family.mjs')
    expect(pkg.scripts['word-family:verify']).toBe('node scripts/compile-word-family.mjs --verify')
  })
})

function recordsText(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join('\n')
}
