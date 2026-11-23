import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { SEMANTIC_CONNECTIVES } from '@/core/text/SpeechPhrasing'

async function loadExternal(): Promise<any> {
  // @ts-ignore -- dev-only ESM helper has no type declarations
  return import('../scripts/lib/externalData.mjs')
}

const DATA = resolve(process.cwd(), 'scripts/data/bytedance-zh-wiki')

describe('2026-11-23 外部 ByteDance/zh-wiki 派生资料', () => {
  it('精简语料存在且保留来源说明', async () => {
    const { loadG2pContext, loadProsodyBoundaries } = await loadExternal()
    const g2p = loadG2pContext(resolve(DATA, 'g2pContext.v1.jsonl'))
    const prosody = loadProsodyBoundaries(resolve(DATA, 'prosodyBoundary.v1.jsonl'))
    expect(g2p.length).toBeGreaterThanOrEqual(1000)
    expect(prosody.length).toBeGreaterThanOrEqual(100)
    expect(g2p.every((item: any) => item.char && item.reading && item.text)).toBe(true)
    const covered = prosody.filter((item: any) =>
      SEMANTIC_CONNECTIVES.some((word) => String(item.right).startsWith(word))).length
    expect(covered / prosody.length).toBeGreaterThan(0.95)
  })

  it('统一 ü/5 记法后再与项目词典对照', async () => {
    const { normalizeExternalReading, auditG2pContext, summarizeProsody } = await loadExternal()
    expect(normalizeExternalReading('yv3')).toBe('yu3')
    expect(normalizeExternalReading('de5')).toBe('de')

    const assets = { effective: new Map([['银行', 'yin2 hang2']]), maxLength: 2 }
    const examples = [
      { char: '行', reading: 'hang2', text: '他去银行。', index: 3, left: '他去银', right: '。' },
      { char: '行', reading: 'xing2', text: '他去银行。', index: 3, left: '他去银', right: '。' },
    ]
    const result = auditG2pContext(examples, assets)
    expect(result.matches).toBe(1)
    expect(result.mismatches[0].char).toBe('行')
    expect(summarizeProsody([{ left: '甲', right: '，可是乙', level: 3 }]).connectives).toBe(1)
  })
})
