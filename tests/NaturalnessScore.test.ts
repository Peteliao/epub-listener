import { describe, expect, it } from 'vitest'

async function loadScore(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/naturalnessScore.mjs')
}

const MANIFEST_SHA256 = 'a'.repeat(64)

function fixture(): any {
  return {
    protocol: 'naturalness-v1',
    mode: 'full',
    items: [
      { id: 'c2-comma__legacy-text', sampleId: 'c2-comma', variant: 'legacy-text', file: 'wav/c2-comma-legacy.wav' },
      { id: 'c2-comma__frontend-text', sampleId: 'c2-comma', variant: 'frontend-text', file: 'wav/c2-comma-frontend.wav' },
      { id: 'c4-grid__n05-s08', sampleId: 'c4-grid', variant: 'c4-grid', actualConfig: { noiseScale: 0.5, silenceScale: 0.8 }, file: 'wav/c4-n05-s08.wav' },
      { id: 'c4-grid__n08-s12', sampleId: 'c4-grid', variant: 'c4-grid', actualConfig: { noiseScale: 0.8, silenceScale: 1.2 }, file: 'wav/c4-n08-s12.wav' },
    ],
  }
}

function createSheet(score: any, manifest = fixture()) {
  return score.createNaturalnessScoreSheet({ manifest, manifestSha256: MANIFEST_SHA256, rater: 'liaoh' })
}

function fill(sheet: any) {
  for (const item of sheet.items) {
    item.scores = { naturalness: 4, pause: 3 }
    item.notes = '试听备注'
  }
  for (const sampleId of new Set(sheet.items.map((item: any) => item.sampleId))) {
    sheet.items.find((item: any) => item.sampleId === sampleId).preferred = true
  }
  return sheet
}

describe('P1 自然度评分表', () => {
  it('空白评分表合法但未完成，C4 参数随条目保留', async () => {
    const score = await loadScore()
    const manifest = fixture()
    const sheet = createSheet(score, manifest)
    expect(sheet.items).toHaveLength(4)
    expect(sheet.items[2]).toMatchObject({ noiseScale: 0.5, silenceScale: 0.8 })
    expect(sheet.items[3]).toMatchObject({ noiseScale: 0.8, silenceScale: 1.2 })
    const result = score.validateNaturalnessScoreSheet(sheet, { manifest, manifestSha256: MANIFEST_SHA256 })
    expect(result.ok).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.summary).toBeNull()
  })

  it('完整评分按 C4 噪声与静音组合分别汇总', async () => {
    const score = await loadScore()
    const manifest = fixture()
    const result = score.validateNaturalnessScoreSheet(fill(createSheet(score, manifest)), {
      manifest,
      manifestSha256: MANIFEST_SHA256,
    })
    expect(result).toMatchObject({ ok: true, complete: true, errors: [] })
    expect(result.summary.variants['legacy-text']).toEqual({ count: 1, naturalness: 4, pause: 3 })
    expect(result.summary.variants['c4-grid:n0.5:s0.8']).toEqual({ count: 1, naturalness: 4, pause: 3 })
    expect(result.summary.variants['c4-grid:n0.8:s1.2']).toEqual({ count: 1, naturalness: 4, pause: 3 })
    expect(result.summary.variants['c4-grid']).toBeUndefined()
    expect(result.summary.samples['c4-grid'].preferred).toEqual(['c4-grid:n0.5:s0.8'])
  })

  it('拒绝越界、非整数分数和空评分者', async () => {
    const score = await loadScore()
    const manifest = fixture()
    const sheet = createSheet(score, manifest)
    sheet.items[0].scores.naturalness = 0
    sheet.items[1].scores.pause = 6
    sheet.items[2].scores.naturalness = 1.5
    sheet.rater = ' '
    const result = score.validateNaturalnessScoreSheet(sheet, { manifest, manifestSha256: MANIFEST_SHA256 })
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('必须是 1–5 的整数')
    expect(result.errors.join('\n')).toContain('缺少评分者')
    expect(result.summary).toBeNull()
  })

  it('拒绝重复、缺少和多余的实验 id', async () => {
    const score = await loadScore()
    const manifest = fixture()
    const duplicate = createSheet(score, manifest)
    duplicate.items[1].id = duplicate.items[0].id
    expect(score.validateNaturalnessScoreSheet(duplicate, { manifest, manifestSha256: MANIFEST_SHA256 }).errors.join('\n'))
      .toContain('重复实验 id')

    const missing = createSheet(score, manifest)
    missing.items.pop()
    expect(score.validateNaturalnessScoreSheet(missing, { manifest, manifestSha256: MANIFEST_SHA256 }).errors.join('\n'))
      .toContain('缺少实验 id')

    const extra = createSheet(score, manifest)
    extra.items.push({ ...structuredClone(extra.items[0]), id: 'unexpected' })
    expect(score.validateNaturalnessScoreSheet(extra, { manifest, manifestSha256: MANIFEST_SHA256 }).errors.join('\n'))
      .toContain('未知或多余的实验 id')
  })

  it('拒绝错误清单指纹和被改动的 C4 参数', async () => {
    const score = await loadScore()
    const manifest = fixture()
    const sheet = createSheet(score, manifest)
    const wrongHash = score.validateNaturalnessScoreSheet(sheet, {
      manifest,
      manifestSha256: 'b'.repeat(64),
    })
    expect(wrongHash.ok).toBe(false)
    expect(wrongHash.errors).toContain('评分表与自然度清单指纹不一致')

    sheet.items[2].silenceScale = 1
    const changedConfig = score.validateNaturalnessScoreSheet(sheet, { manifest, manifestSha256: MANIFEST_SHA256 })
    expect(changedConfig.ok).toBe(false)
    expect(changedConfig.errors.join('\n')).toContain('C4 噪声或静音参数与清单不一致')
  })

  it('每个样本必须且只能选择一个偏好方案', async () => {
    const score = await loadScore()
    const manifest = fixture()
    const sheet = fill(createSheet(score, manifest))
    sheet.items[3].preferred = true
    const multiple = score.validateNaturalnessScoreSheet(sheet, { manifest, manifestSha256: MANIFEST_SHA256 })
    expect(multiple.ok).toBe(false)
    expect(multiple.errors).toContain('c4-grid 只能选择一个偏好方案')

    const none = fill(createSheet(score, manifest))
    none.items.filter((item: any) => item.sampleId === 'c2-comma').forEach((item: any) => { item.preferred = false })
    const missingPreference = score.validateNaturalnessScoreSheet(none, { manifest, manifestSha256: MANIFEST_SHA256 })
    expect(missingPreference.ok).toBe(true)
    expect(missingPreference.complete).toBe(false)
    expect(missingPreference.summary).toBeNull()
  })

  it('拒绝缺少必要字段的清单与评分表版本漂移', async () => {
    const score = await loadScore()
    const manifest = fixture()
    delete manifest.items[0].sampleId
    expect(() => createSheet(score, manifest)).toThrow('缺少 sampleId 或 variant')

    const validManifest = fixture()
    const sheet = createSheet(score, validManifest)
    sheet.version = 2
    const result = score.validateNaturalnessScoreSheet(sheet, {
      manifest: validManifest,
      manifestSha256: MANIFEST_SHA256,
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('评分表 version 不匹配')
  })

  it('评分页保留相对音频路径并转义不可信文本', async () => {
    const score = await loadScore()
    const manifest = fixture()
    manifest.items[0].sourceText = '</script><img src=x onerror=alert(1)>'
    const sheet = createSheet(score, manifest)
    sheet.items[0].notes = '" /><script>alert(2)</script>'
    const html = score.renderNaturalnessScoreHtml({ manifest, sheet })
    expect(html).toContain('src="wav/c2-comma-legacy.wav"')
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(2)</script>')
    expect(html).toContain('\\u003c/script\\u003e')
    expect(html).toContain('preload="none"')
    expect(html).toContain("naturalness-score:' + initial.manifestSha256 + ':' + encodeURIComponent(initial.rater)")
    expect(html).toContain("localStorage.setItem(storageKey, JSON.stringify(state))")
  })
})
