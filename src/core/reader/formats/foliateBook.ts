import { makeFB2 } from '@/vendor/foliate-js/fb2.js'
import { MOBI } from '@/vendor/foliate-js/mobi.js'
import { unzlibSync } from '@/vendor/foliate-js/vendor/fflate.js'
import type { FoliateBookLike } from './types'

export async function buildFb2Book(buffer: ArrayBuffer): Promise<FoliateBookLike> {
  try {
    return await makeFB2(new Blob([buffer], { type: 'application/xml' }))
  } catch {
    throw new Error('无法解析这本 FB2，文件可能已损坏。')
  }
}

export async function buildMobiBook(buffer: ArrayBuffer): Promise<FoliateBookLike> {
  try {
    const mobi = new MOBI({ unzlib: unzlibSync })
    return await mobi.open(
      new Blob([buffer], { type: 'application/x-mobipocket-ebook' }),
    )
  } catch {
    throw new Error('无法解析这本 MOBI/AZW3，文件可能已损坏或受 DRM 保护。')
  }
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function foliateTitle(book: FoliateBookLike): string {
  const value = book.metadata?.title
  if (typeof value === 'string') return clean(value)
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      if (typeof item === 'string' && item.trim()) return clean(item)
    }
  }
  return ''
}

export function foliateAuthors(book: FoliateBookLike): string {
  const value = book.metadata?.author
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  const names: string[] = []
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      names.push(clean(item))
    } else if (item && typeof item === 'object' && 'name' in item) {
      const name = (item as { name?: unknown }).name
      if (typeof name === 'string' && name.trim()) names.push(clean(name))
    }
  }
  return names.join('、')
}

export function countFoliateSections(book: FoliateBookLike): number {
  return book.sections.filter(
    (section) => typeof section.load === 'function' && section.linear !== 'no',
  ).length
}
