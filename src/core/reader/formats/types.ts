export interface FoliateSection {
  id: string | number
  load: () => string | Promise<string>
  createDocument?: () => Document | Promise<Document>
  size?: number
  linear?: string
  unload?: () => void
}

export interface FoliateTocItem {
  label?: string
  href?: string
  subitems?: FoliateTocItem[]
}

export interface FoliateResolvedTarget {
  index: number
  anchor: (doc: Document) => Element | Range | null
}

/**
 * The subset of the foliate-js "book" interface we rely on. foliate-js is not
 * stable, so keep this surface small and adapt here.
 */
export interface FoliateBookLike {
  sections: FoliateSection[]
  toc?: FoliateTocItem[]
  metadata?: {
    title?: unknown
    author?: unknown
    language?: unknown
  }
  dir?: string
  getCover?: () => Blob | null | Promise<Blob | null>
  resolveHref: (
    href: string,
  ) => FoliateResolvedTarget | undefined | Promise<FoliateResolvedTarget | undefined>
  splitTOCHref?: (href: string) => unknown[] | Promise<unknown[]>
  getTOCFragment?: (doc: Document, id: unknown) => Node | null
  isExternal?: (uri: string) => boolean
  destroy?: () => void
}
