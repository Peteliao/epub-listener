import { BLOCK_TAGS } from './Highlighter'

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'RT', 'RP',
])

function walk(node: Node, parts: string[]): void {
  if (node.nodeType === 3) {
    const text = node.nodeValue
    if (text) parts.push(text)
    return
  }
  if (node.nodeType !== 1) return

  const element = node as Element
  const tag = element.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) return
  if (tag === 'BR') {
    parts.push('\n')
    return
  }

  const block = BLOCK_TAGS.has(tag)
  if (block) parts.push('\n')
  for (const child of element.childNodes) walk(child, parts)
  if (block) parts.push('\n')
}

export function extractDocumentText(doc: Document): string {
  const root = doc.body ?? doc.documentElement
  if (!root) return ''
  const parts: string[] = []
  walk(root, parts)
  return parts
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
