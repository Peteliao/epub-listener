import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  generateBookLexicon,
  isApprovedDivergence,
  type BookLexiconInput,
  type Phone,
} from '@/core/tts/bookLexicon'
import {
  APPROVED_OVERRIDES,
  APPROVED_OVERRIDES_HASH,
  type ApprovedOverridesData,
} from '@/core/tts/approvedOverrides.v1'

const root = process.cwd()
const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/manifest.json'), 'utf8'),
) as {
  packs: Array<{
    id: string
    files: Array<{ name: string; url: string }>
    model: { config: Record<string, string> }
  }>
}
const pack = manifest.packs.find((p) => p.id === 'matcha-icefall-zh-baker')!
const lexFile = pack.files.find((f) => f.name === pack.model.config.lexicon)!
const tokFile = pack.files.find((f) => f.name === 'tokens.txt')!
const lexiconText = readFileSync(resolve(root, 'public', lexFile.url), 'utf8')
const tokensText = readFileSync(resolve(root, 'public', tokFile.url), 'utf8')
const curatedOverlay = readFileSync(
  resolve(root, 'src/core/tts/polyphones.v1.txt'),
  'utf8',
)

function generate(chunks: string[], overrides: Partial<BookLexiconInput> = {}) {
  return generateBookLexicon({
    chunks,
    lexiconText,
    tokensText,
    curatedOverlay,
    ...overrides,
  })
}

describe('构建期白名单常量', () => {
  it('非空且带稳定指纹', () => {
    expect(Object.keys(APPROVED_OVERRIDES.charBases).length).toBeGreaterThan(50)
    expect(APPROVED_OVERRIDES_HASH).toMatch(/^[0-9a-f]{8}$/)
    expect(APPROVED_OVERRIDES.rejectedWords).toContain('长期地')
  })

  it('每个登记音素都是合法 base（无调号、非静音边界）', () => {
    for (const [char, bases] of Object.entries(APPROVED_OVERRIDES.charBases)) {
      expect(Array.from(char)).toHaveLength(1)
      expect(bases.length).toBeGreaterThan(0)
      for (const base of bases) {
        expect(base).toMatch(/^[a-z]+$/)
        expect(base).not.toBe('"')
      }
    }
  })
})

describe('isApprovedDivergence 准入判定', () => {
  const phone = (base: string, tone: number | null = 4): Phone => ({ base, tone })
  const overrides: ApprovedOverridesData = {
    charBases: { 便: ['pian'], 地: ['di'] },
    rejectedWords: ['长期地'],
  }

  it('差异位置的上下文 base 已登记时放行', () => {
    // 占便宜: 便宜读 pian2 yi, 孤立读 bian4 yi2 —— 只考察「便」这一位置。
    expect(isApprovedDivergence(
      '便宜', [phone('pian', 2), phone('yi', 2)], [phone('bian'), phone('yi', 2)], overrides,
    )).toBe(true)
  })

  it('未登记的差异一律拒绝', () => {
    expect(isApprovedDivergence(
      '便宜', [phone('bian', 2), phone('yi', 2)], [phone('pian', 2), phone('yi', 2)], overrides,
    )).toBe(false)
  })

  it('纯声调差异拒绝，变调规则保持完全控制', () => {
    expect(isApprovedDivergence(
      '便宜', [phone('pian', 2), phone('yi', 3)], [phone('pian', 2), phone('yi', 2)], overrides,
    )).toBe(false)
  })

  it('无差异时拒绝（不额外放行）', () => {
    expect(isApprovedDivergence(
      '便宜', [phone('pian', 2), phone('yi', 2)], [phone('pian', 2), phone('yi', 2)], overrides,
    )).toBe(false)
  })

  it('排除词即使差异已登记也拒绝', () => {
    expect(isApprovedDivergence(
      '长期地', [phone('chang', 2), phone('qi', 2), phone('di')],
      [phone('chang', 2), phone('qi', 2), phone('de', 3)], overrides,
    )).toBe(false)
  })

  it('不传白名单时任何差异都拒绝（可一键回退）', () => {
    expect(isApprovedDivergence(
      '便宜', [phone('pian', 2), phone('yi', 2)], [phone('bian'), phone('yi', 2)], undefined,
    )).toBe(false)
  })

  it('任意一个差异位置未登记就整词拒绝', () => {
    expect(isApprovedDivergence(
      '便宜', [phone('pian', 2), phone('xie', 2)], [phone('bian'), phone('yi', 2)], overrides,
    )).toBe(false)
  })
})

describe('白名单准入（低档 ②）', () => {
  it('不传白名单时保持原有严格行为', () => {
    const result = generate(['他把信纸轻轻铺开，读了起来。'], {
      curatedOverlay: curatedOverlay.replace(/^铺开 .*$/m, ''),
    })
    expect(result.entries.map((e) => e.word)).toEqual(['铺开'])
  })

  it('传入白名单不改变既有 OOV 恢复结果', () => {
    const without = generate(['他把信纸轻轻铺开，读了起来。'], {
      curatedOverlay: curatedOverlay.replace(/^铺开 .*$/m, ''),
    })
    const withWhitelist = generate(['他把信纸轻轻铺开，读了起来。'], {
      curatedOverlay: curatedOverlay.replace(/^铺开 .*$/m, ''),
      approvedOverrides: APPROVED_OVERRIDES,
    })
    expect(withWhitelist.overlay).toBe(without.overlay)
  })

  it('确定性：章节顺序不同仍产出逐字相同的 overlay', () => {
    const a = generate(['他答应了一声。', '牛圈里的牛。'], {
      approvedOverrides: APPROVED_OVERRIDES,
    })
    const b = generate(['牛圈里的牛。', '他答应了一声。'], {
      approvedOverrides: APPROVED_OVERRIDES,
    })
    expect(a.overlay).toBe(b.overlay)
  })

  it('排除词即使命中字族白名单也不被放行', () => {
    // 长期地 was explicitly rejected: pinyin-pro reads 地 as di4 there,
    // while the curated table and acoustic model use the neutral particle de.
    const overrides: ApprovedOverridesData = {
      charBases: { ...APPROVED_OVERRIDES.charBases, 地: ['di'] },
      rejectedWords: ['长期地'],
    }
    const result = generate(['一些会占便宜的有钱人长期地用盐不给钱。'], {
      approvedOverrides: overrides,
    })
    expect(result.entries.map((e) => e.word)).not.toContain('长期地')
  })

  it('未登记的差异仍按原规则丢弃', () => {
    const strict: ApprovedOverridesData = { charBases: {}, rejectedWords: [] }
    const result = generate(['他答应了一声。'], { approvedOverrides: strict })
    expect(result).toBeDefined()
    expect(result.entries.every((e) => e.reading)).toBe(true)
  })
})
