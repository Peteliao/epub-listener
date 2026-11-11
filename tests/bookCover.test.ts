import { describe, expect, it } from 'vitest'
import { extractBookCover, readFoliateCover } from '@/core/library/bookCover'
import type { FoliateBookLike } from '@/core/reader/formats/types'

function fakeBook(
  getCover: () => Blob | null | Promise<Blob | null>,
): FoliateBookLike {
  return {
    sections: [],
    resolveHref: () => undefined,
    getCover,
  }
}

describe('readFoliateCover', () => {
  it('returns an image cover blob', async () => {
    const cover = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    await expect(readFoliateCover(fakeBook(() => cover))).resolves.toBe(cover)
  })

  it('accepts format-less MOBI cover blobs', async () => {
    const cover = new Blob([new Uint8Array([1, 2, 3])])
    await expect(readFoliateCover(fakeBook(() => cover))).resolves.toBe(cover)
  })

  it('rejects empty and non-image blobs', async () => {
    await expect(
      readFoliateCover(fakeBook(() => new Blob([], { type: 'image/png' }))),
    ).resolves.toBeNull()
    await expect(
      readFoliateCover(fakeBook(() => new Blob(['x'], { type: 'text/plain' }))),
    ).resolves.toBeNull()
  })

  it('swallows getCover failures', async () => {
    await expect(
      readFoliateCover(
        fakeBook(() => {
          throw new Error('broken cover')
        }),
      ),
    ).resolves.toBeNull()
  })
})

describe('extractBookCover', () => {
  it('does not parse TXT books for a cover', async () => {
    await expect(extractBookCover('txt', new ArrayBuffer(0))).resolves.toBeNull()
  })
})
