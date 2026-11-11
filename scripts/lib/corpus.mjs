// Dev-only corpus readers shared by the pronunciation audits. The app never
// imports this module, so jszip/jsdom stay out of the browser bundle.
import { readFile } from 'node:fs/promises'
import { extname, posix, resolve } from 'node:path'
import JSZip from 'jszip'
import { JSDOM, VirtualConsole } from 'jsdom'

const virtualConsole = new VirtualConsole()

export function chunkSentence(sentence, max = 400) {
  const chars = Array.from(sentence)
  if (chars.length <= max) return [sentence]
  const chunks = []
  for (let index = 0; index < chars.length; index += max) {
    chunks.push(chars.slice(index, index + max).join(''))
  }
  return chunks
}

/** Same sentence boundaries the app and the other audits use. */
export function splitSentences(text, max = 400) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .split(/(?<=[。！？!?；;…\n])/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((sentence) => chunkSentence(sentence, max))
}

export function makeContext(sentence, start, end, radius = 14) {
  const chars = Array.from(sentence)
  const from = Math.max(0, start - radius)
  const to = Math.min(chars.length, end + radius)
  const body = chars.slice(from, to).join('').replace(/\s+/g, ' ')
  return `${from > 0 ? '…' : ''}${body}${to < chars.length ? '…' : ''}`
}

function xmlDocument(xml) {
  return new JSDOM(xml, { contentType: 'text/xml', virtualConsole }).window.document
}

function collectHtmlText(html) {
  const document = new JSDOM(html, { virtualConsole }).window.document
  document.querySelectorAll('script,style,noscript').forEach((element) => element.remove())
  return (document.body?.textContent ?? document.documentElement.textContent ?? '')
    .replace(/\u00a0/g, ' ')
}

async function readEpub(path) {
  const zip = await JSZip.loadAsync(await readFile(path))
  let opfPath = null
  const container = zip.file('META-INF/container.xml')
  if (container) {
    const document = xmlDocument(await container.async('text'))
    opfPath = document.getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ?? null
  }
  if (!opfPath) {
    opfPath = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.opf')) ?? null
  }

  let opfDir = ''
  let hrefs = []
  if (opfPath) {
    const directory = posix.dirname(opfPath)
    opfDir = directory === '.' ? '' : directory
    const opfFile = zip.file(opfPath)
    if (opfFile) {
      const document = xmlDocument(await opfFile.async('text'))
      const items = new Map()
      for (const item of document.getElementsByTagName('item')) {
        const id = item.getAttribute('id')
        const href = item.getAttribute('href')
        if (id && href) items.set(id, href)
      }
      for (const itemref of document.getElementsByTagName('itemref')) {
        const idref = itemref.getAttribute('idref')
        const href = idref ? items.get(idref) : null
        if (href) hrefs.push(href)
      }
    }
  }
  if (!hrefs.length) {
    hrefs = Object.keys(zip.files).filter((name) => /\.x?html?$/i.test(name))
  }

  const sections = []
  for (const href of hrefs) {
    let decoded = href.split('#')[0]
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      // Keep the raw href for malformed percent escapes.
    }
    const entryName = opfDir ? posix.normalize(posix.join(opfDir, decoded)) : posix.normalize(decoded)
    const entry = zip.file(entryName) ?? zip.file(decoded)
    if (!entry) continue
    const text = collectHtmlText(await entry.async('text'))
    if (text.trim()) sections.push(text)
  }
  const text = sections.join('\n')
  return { path, sections: sections.length, chars: Array.from(text).length, text }
}

async function readFb2(path) {
  const document = xmlDocument(await readFile(path, 'utf8'))
  document.querySelectorAll('binary,script,style').forEach((element) => element.remove())
  const text = document.documentElement.textContent ?? ''
  return { path, sections: 1, chars: Array.from(text).length, text }
}

/** Exported feedback JSONL is also a corpus: each report carries its paragraph. */
async function readReports(path) {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/)
  const sections = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    try {
      const text = JSON.parse(trimmed)?.paragraph?.text
      if (typeof text === 'string' && text.trim()) sections.push(text)
    } catch {
      // Ignore malformed lines; loadReports() in the feedback script validates them.
    }
  }
  const text = sections.join('\n')
  return { path, sections: sections.length, chars: Array.from(text).length, text }
}

/**
 * Reads .txt / .md / .epub / .fb2 / .jsonl (exported feedback) into plain text.
 */
export async function loadCorpus(path) {
  const absolute = resolve(path)
  const extension = extname(absolute).toLowerCase()
  if (extension === '.txt' || extension === '.md') {
    const text = await readFile(absolute, 'utf8')
    return { path, sections: 1, chars: Array.from(text).length, text }
  }
  if (extension === '.epub') return readEpub(absolute)
  if (extension === '.fb2') return readFb2(absolute)
  if (extension === '.jsonl') return readReports(absolute)
  throw new Error(`暂不支持 ${extension || '无扩展名'}（支持 .txt/.md/.epub/.fb2/.jsonl）`)
}
