import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/manifest.json'), 'utf8'),
) as {
  packs: Array<{
    id: string
    lang: string
    name: string
    license: { label: string; commercialUse: boolean }
    totalBytes: number
    model: {
      type: string
      config: Record<string, string | number>
      ruleFsts: string[]
    }
    voices: Array<{ id: string; speakerId: number; sampleRate: number }>
    files: Array<{
      name: string
      url: string
      bytes: number
      sha256: string
      parts?: Array<{ name: string; url: string; bytes: number; sha256: string }>
    }>
  }>
}
const pack = manifest.packs.find((item) => item.id === 'vits-melo-zh-en')!
const packDir = resolve(root, 'public/models/vits-melo-zh-en')

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('Melo voice pack', () => {
  it('is an optional VITS voice and leaves 山岚 as the primary default', () => {
    expect(manifest.packs[0]!.id).toBe('matcha-icefall-zh-baker')
    expect(pack).toMatchObject({
      lang: 'zh',
      name: 'Melo 中英女声',
      license: { label: 'MIT', commercialUse: true },
      model: { type: 'vits' },
    })
    expect(pack.voices).toEqual([
      expect.objectContaining({ id: 'melo-zh', speakerId: 0, sampleRate: 44100 }),
    ])
  })

  it('uses the official int8 model with its own tokens, lexicon and rule FSTs', () => {
    expect(pack.model.config).toMatchObject({
      model: 'model.int8.onnx',
      lexicon: 'lexicon.txt',
      tokens: 'tokens.txt',
      noiseScale: 0.667,
      noiseScaleW: 0.8,
      lengthScale: 1,
    })
    expect(pack.model.ruleFsts).toEqual(['phone.fst', 'date.fst', 'number.fst'])
    const names = new Set(pack.files.map((file) => file.name))
    for (const name of [
      pack.model.config.model,
      pack.model.config.lexicon,
      pack.model.config.tokens,
      ...pack.model.ruleFsts,
    ]) {
      expect(names.has(String(name))).toBe(true)
    }
  })

  it('ships verified assets whose byte counts and hashes match the manifest', () => {
    expect(pack.files.reduce((total, file) => total + file.bytes, 0)).toBe(pack.totalBytes)
    for (const file of pack.files) {
      for (const entry of file.parts ?? [file]) {
        const path = resolve(root, 'public', entry.url)
        const bytes = readFileSync(path)
        expect(statSync(path).size, entry.name).toBe(entry.bytes)
        expect(sha256(bytes), entry.name).toBe(entry.sha256)
      }
    }
  })

  it('splits the model below 50 MB and reconstructs the original ONNX bytes', () => {
    const model = pack.files.find((file) => file.name === 'model.int8.onnx')!
    expect(model.parts).toHaveLength(2)
    expect(model.parts!.every((part) => part.bytes < 50_000_000)).toBe(true)
    expect(existsSync(resolve(root, 'public', model.url))).toBe(false)

    const merged = Buffer.concat(
      model.parts!.map((part) => readFileSync(resolve(root, 'public', part.url))),
    )
    expect(merged.byteLength).toBe(model.bytes)
    expect(sha256(merged)).toBe(model.sha256)
    expect(merged.subarray(0, 4)).toEqual(Buffer.from([0x08, 0x07, 0x12, 0x0d]))
  })

  it('includes the upstream MIT license', () => {
    const license = readFileSync(resolve(packDir, 'LICENSE'), 'utf8')
    expect(license).toContain('Copyright (c) 2024 MyShell.ai')
    expect(license).toContain('Permission is hereby granted, free of charge')
  })
})
