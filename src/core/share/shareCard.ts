import { READER_PALETTES, type ReaderTheme } from '@/types'
import {
  formatListenDuration,
  splitListenDuration,
  type ListeningSnapshot,
} from '@/core/stats/listeningStats'
import {
  SHARE_PATTERN_PIXEL_RATIO,
  SHARE_PATTERN_TILES,
} from './patternTiles'

export const SHARE_URL = 'https://peteliao.github.io/epub-listener/?from=share'
export const SHARE_TITLE = '我的听书时光 · 书声'
export const SHARE_FILE_NAME = 'shusheng-listening.png'

const WIDTH = 1080
const HEIGHT = 1440
const PAD = 88
const SERIF =
  '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", SimSun, Georgia, serif'
const UI =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '')
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  }
}

function alpha(hex: string, opacity: number): string {
  const { r, g, b } = parseHex(hex)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}

function mix(from: string, to: string, ratio: number): string {
  const a = parseHex(from)
  const b = parseHex(to)
  const channel = (x: number, y: number): number =>
    Math.round(x + (y - x) * ratio)
  return `rgb(${channel(a.r, b.r)}, ${channel(a.g, b.g)}, ${channel(a.b, b.b)})`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function truncate(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let result = text
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1)
  }
  return `${result}…`
}

function drawTracking(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  let cursor = x
  for (const char of text) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + spacing
  }
}

function drawBrand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  squareColor: string,
  markColor: string,
): void {
  ctx.save()
  ctx.fillStyle = squareColor
  roundRect(ctx, x, y, size, size, size * 0.28)
  ctx.fill()

  ctx.translate(x + size * 0.2, y + size * 0.2)
  ctx.scale((size * 0.6) / 64, (size * 0.6) / 64)
  ctx.strokeStyle = markColor
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke(
    new Path2D(
      'M16 19c5.5-2.4 10.5-1.2 16 2.2 5.5-3.4 10.5-4.6 16-2.2v27c-5.5-2.4-10.5-1.2-16 2.2-5.5-3.4-10.5-4.6-16-2.2V19z',
    ),
  )
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(32, 21.2)
  ctx.lineTo(32, 48.2)
  ctx.stroke()
  ctx.globalAlpha = 0.8
  ctx.beginPath()
  ctx.moveTo(22, 30)
  ctx.bezierCurveTo(24.4, 29, 26.8, 29.5, 29, 31)
  ctx.moveTo(22, 36.5)
  ctx.bezierCurveTo(24.4, 35.5, 26.8, 36, 29, 37.5)
  ctx.moveTo(39.5, 30)
  ctx.bezierCurveTo(41.7, 29, 44.1, 29.5, 46.5, 31)
  ctx.stroke()
  ctx.restore()
}

function drawStat(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  value: string,
  unit: string,
  label: string,
  foreground: string,
  muted: string,
): void {
  ctx.textAlign = 'left'
  ctx.font = `600 58px ${SERIF}`
  const valueWidth = ctx.measureText(value).width
  ctx.font = `500 24px ${UI}`
  const unitWidth = unit ? ctx.measureText(unit).width + 7 : 0
  const startX = centerX - (valueWidth + unitWidth) / 2

  ctx.fillStyle = foreground
  ctx.font = `600 58px ${SERIF}`
  ctx.fillText(value, startX, 912)

  if (unit) {
    ctx.fillStyle = muted
    ctx.font = `500 24px ${UI}`
    ctx.fillText(unit, startX + valueWidth + 7, 918)
  }

  ctx.fillStyle = muted
  ctx.font = `500 24px ${UI}`
  ctx.textAlign = 'center'
  ctx.fillText(label, centerX, 960)
}

function monthLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}`
}

function dateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

function drawBigNumber(
  ctx: CanvasRenderingContext2D,
  value: string,
  unit: string,
  color: string,
  muted: string,
): void {
  const maxWidth = WIDTH - PAD * 2 - 150
  let fontSize = 264
  ctx.font = `600 ${fontSize}px ${SERIF}`
  while (fontSize > 160 && ctx.measureText(value).width > maxWidth) {
    fontSize -= 8
    ctx.font = `600 ${fontSize}px ${SERIF}`
  }

  ctx.textAlign = 'left'
  ctx.fillStyle = color
  ctx.fillText(value, PAD, 668)
  const valueWidth = ctx.measureText(value).width

  ctx.fillStyle = muted
  ctx.font = `500 54px ${UI}`
  ctx.fillText(unit, PAD + valueWidth + 18, 662)
}

async function drawQr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  const { default: QRCode } = await import('qrcode')
  const canvas = document.createElement('canvas')
  await QRCode.toCanvas(canvas, SHARE_URL, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: size * 2,
    color: { dark: '#241a12', light: '#ffffff' },
  })
  ctx.drawImage(canvas, x, y, size, size)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('分享卡背景加载失败。'))
    image.src = src
  })
}

/**
 * Tiles the theme's PNG motif over the backdrop. The PNG is a 4× copy of the
 * CSS SVG tile, so divide the CSS scale by 4 and enlarge it slightly for an
 * airier, less repetitive card. Solid and gradient themes have no tile and
 * keep the plain gradient backdrop built above.
 */
async function drawPatternTile(
  ctx: CanvasRenderingContext2D,
  theme: ReaderTheme,
): Promise<void> {
  const url = SHARE_PATTERN_TILES[theme]
  if (!url) return
  let image: HTMLImageElement
  try {
    image = await loadImage(url)
  } catch {
    return
  }
  const scale = (WIDTH / 414 / SHARE_PATTERN_PIXEL_RATIO) * 1.15
  ctx.save()
  ctx.scale(scale, scale)
  const pattern = ctx.createPattern(image, 'repeat')
  if (pattern) {
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, WIDTH / scale, HEIGHT / scale)
  }
  ctx.restore()
}

function isCanvasSecurityError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  const message = (error as { message?: unknown }).message
  return (
    name === 'SecurityError' ||
    (typeof message === 'string' && /insecure/i.test(message))
  )
}

export interface ShareCardOptions {
  snapshot: ListeningSnapshot
  theme: ReaderTheme
  includeBook: boolean
  now?: number
}

export async function renderShareCard(
  options: ShareCardOptions,
  safeMode = false,
): Promise<Blob> {
  const { snapshot, includeBook, now = Date.now() } = options
  const palette = READER_PALETTES[options.theme]
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持生成分享卡。')

  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
  background.addColorStop(0, palette.bg)
  background.addColorStop(1, mix(palette.bg, palette.uiBg, 0.85))
  ctx.fillStyle = background
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  if (!safeMode) await drawPatternTile(ctx, options.theme)

  const glow = ctx.createRadialGradient(
    WIDTH * 0.92,
    -HEIGHT * 0.06,
    0,
    WIDTH * 0.92,
    -HEIGHT * 0.06,
    WIDTH * 0.78,
  )
  glow.addColorStop(0, alpha(palette.accent, palette.dark ? 0.18 : 0.12))
  glow.addColorStop(1, alpha(palette.accent, 0))
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  ctx.strokeStyle = alpha(palette.fg, 0.08)
  ctx.lineWidth = 2
  roundRect(ctx, 34, 34, WIDTH - 68, HEIGHT - 68, 34)
  ctx.stroke()

  drawBrand(ctx, PAD, 78, 56, palette.accent, palette.bg)

  ctx.textAlign = 'left'
  ctx.fillStyle = palette.fg
  ctx.font = `600 34px ${SERIF}`
  ctx.fillText('书声', PAD + 76, 112)

  ctx.fillStyle = palette.muted
  ctx.font = `600 14px ${UI}`
  drawTracking(ctx, 'SHUSHENG', PAD + 77, 140, 6)

  ctx.textAlign = 'right'
  ctx.fillStyle = palette.muted
  ctx.font = `400 22px ${UI}`
  ctx.fillText(dateLabel(now), WIDTH - PAD, 112)

  ctx.strokeStyle = alpha(palette.fg, 0.12)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, 196)
  ctx.lineTo(WIDTH - PAD, 196)
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.fillStyle = palette.accent
  ctx.font = `600 26px ${UI}`
  drawTracking(ctx, '我的听书时光', PAD, 290, 9)

  ctx.fillStyle = palette.muted
  ctx.font = `500 28px ${UI}`
  ctx.fillText('累计听书', PAD, 378)

  const split = splitListenDuration(snapshot.totalMs)
  drawBigNumber(ctx, split.value, split.unit, palette.fg, palette.muted)

  ctx.fillStyle = palette.muted
  ctx.font = `400 26px ${UI}`
  const since = snapshot.firstAt ? `自 ${monthLabel(snapshot.firstAt)} 起 · ` : ''
  ctx.fillText(
    truncate(
      ctx,
      `${since}共 ${snapshot.activeDays} 天有听书记录`,
      WIDTH - PAD * 2,
    ),
    PAD,
    744,
  )

  ctx.strokeStyle = alpha(palette.fg, 0.1)
  ctx.beginPath()
  ctx.moveTo(PAD, 814)
  ctx.lineTo(WIDTH - PAD, 814)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(WIDTH * 0.365, 838)
  ctx.lineTo(WIDTH * 0.365, 968)
  ctx.moveTo(WIDTH * 0.635, 838)
  ctx.lineTo(WIDTH * 0.635, 968)
  ctx.stroke()

  const today = splitListenDuration(snapshot.todayMs)
  drawStat(
    ctx,
    WIDTH * 0.22,
    today.value,
    today.unit,
    '今日',
    palette.fg,
    palette.muted,
  )
  drawStat(
    ctx,
    WIDTH * 0.5,
    String(snapshot.streakDays),
    '天',
    '连续',
    palette.fg,
    palette.muted,
  )
  drawStat(
    ctx,
    WIDTH * 0.78,
    String(snapshot.bookCount),
    '本',
    '听过',
    palette.fg,
    palette.muted,
  )

  if (includeBook && snapshot.lastBook) {
    ctx.textAlign = 'left'
    ctx.fillStyle = palette.muted
    ctx.font = `500 23px ${UI}`
    drawTracking(ctx, '最近在听', PAD, 1066, 3)

    ctx.fillStyle = palette.fg
    ctx.font = `600 46px ${SERIF}`
    ctx.fillText(
      truncate(
        ctx,
        `《${snapshot.lastBook.title}》`,
        WIDTH - PAD * 2,
      ),
      PAD,
      1122,
    )
  } else {
    ctx.textAlign = 'left'
    ctx.fillStyle = palette.accent
    ctx.fillRect(PAD, 1060, 4, 62)
    ctx.fillStyle = palette.fg
    ctx.font = `500 36px ${SERIF}`
    ctx.fillText('把碎片时间，听成一本书。', PAD + 24, 1108)
  }

  ctx.fillStyle = palette.dark
    ? alpha(palette.fg, 0.05)
    : alpha(palette.fg, 0.035)
  roundRect(ctx, PAD, 1186, WIDTH - PAD * 2, 176, 26)
  ctx.fill()
  ctx.strokeStyle = alpha(palette.fg, 0.1)
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = '#ffffff'
  roundRect(ctx, PAD + 16, 1198, 152, 152, 14)
  ctx.fill()
  await drawQr(ctx, PAD + 24, 1206, 136)

  ctx.textAlign = 'left'
  ctx.fillStyle = palette.fg
  ctx.font = `600 40px ${SERIF}`
  ctx.fillText('让文字，读给你听。', PAD + 196, 1264)

  ctx.fillStyle = palette.muted
  ctx.font = `400 23px ${UI}`
  ctx.fillText('扫码打开「书声」· 免安装', PAD + 196, 1310)

  ctx.fillStyle = palette.muted
  ctx.font = `400 20px ${UI}`
  ctx.fillText('peteliao.github.io/epub-listener', PAD + 196, 1344)

  try {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('分享卡生成失败，请重试。'))
      }, 'image/png')
    })
  } catch (error) {
    // Last-resort fallback: if WebKit still taints the full canvas, redraw the
    // same card without the vector tile so preview/save never hit a dead end.
    if (!safeMode && isCanvasSecurityError(error)) {
      return renderShareCard(options, true)
    }
    throw error
  }
}

export function buildShareText(snapshot: ListeningSnapshot): string {
  const duration = formatListenDuration(snapshot.totalMs)
  const streak =
    snapshot.streakDays >= 2 ? `，连续 ${snapshot.streakDays} 天` : ''
  return [
    `我在「书声」累计听书 ${duration}${streak}。`,
    '把听书时光，分享给同样爱书的人。',
    SHARE_URL,
  ].join('\n')
}
