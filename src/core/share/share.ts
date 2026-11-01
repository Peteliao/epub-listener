import { SHARE_FILE_NAME, SHARE_TITLE } from './shareCard'

export type ShareResult = 'shared' | 'downloaded' | 'cancelled'

function shareFileName(): string {
  const date = new Date()
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}${String(date.getDate()).padStart(2, '0')}`
  return SHARE_FILE_NAME.replace('.png', `-${stamp}.png`)
}

export function canShareImage(): boolean {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') {
    return false
  }
  if (!navigator.share || !navigator.canShare) return false
  try {
    const probe = new File([new Blob()], 'probe.png', { type: 'image/png' })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

export function downloadBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = shareFileName()
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function shareImageCard(
  blob: Blob,
  text: string,
): Promise<ShareResult> {
  const file = new File([blob], shareFileName(), { type: 'image/png' })
  if (
    navigator.share &&
    navigator.canShare?.({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], text, title: SHARE_TITLE })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'cancelled'
      }
    }
  }
  downloadBlob(blob)
  return 'downloaded'
}

export async function copyShareText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const copied = document.execCommand('copy')
      textarea.remove()
      return copied
    } catch {
      return false
    }
  }
}
