import type { FoliateBookLike } from '@/core/reader/formats/types'

export function isMOBI(file: Blob): Promise<boolean>

export class MOBI {
  constructor(options: { unzlib: (data: Uint8Array) => Uint8Array })
  open(file: Blob): Promise<FoliateBookLike>
}
