import type { AiModelType } from '@/core/tts/AiModel'
import type { BookFormat, TtsEngine } from '@/types'

export const PRONUNCIATION_REPORT_SCHEMA = 1

export interface FeedbackParagraph {
  id: string
  text: string
  speechText: string
  startSentenceIndex: number
  endSentenceIndex: number
  isCurrent: boolean
}

export interface FeedbackVoice {
  engine: TtsEngine
  activeEngine: TtsEngine | null
  activeLang: 'zh' | 'en' | null
  voiceId: string
  voiceLabel: string
  packId: string | null
  packVersion: string
  modelType: AiModelType | null
  /** Curated and per-book overlays only reach the Matcha lexicon. */
  overlaySupported: boolean
  autoBookPolyphones: boolean
  bookLexiconVersion: number
  curatedHash: string
}

export interface FeedbackSnapshot {
  chapterIndex: number
  chapterLabel: string
  chapterHref: string
  sentenceIndex: number
  sentenceEndIndex: number
  paragraphs: FeedbackParagraph[]
  voice: FeedbackVoice
}

export interface PronunciationMark {
  id: string
  char: string
  /** UTF-16 offset in the paragraph text shown to the reader. */
  charIndex: number
  word: string
  wordStart: number
  wordEnd: number
  /** Numeric-tone phones used by the bundled lexicons, e.g. huan2. */
  expectedPinyin: string
  /** Tone-mark label shown in the UI, e.g. huán. */
  expectedLabel: string
}

export interface PronunciationReport {
  schema: number
  id: string
  createdAt: number
  updatedAt: number
  appBuildId: string
  book: {
    id: string
    title: string
    format: BookFormat
    size: number
    fingerprint: string | null
    chapterIndex: number
    chapterHref: string
    chapterLabel: string
  }
  paragraph: {
    text: string
    speechText: string
    startSentenceIndex: number
    endSentenceIndex: number
    textHash: string
  }
  marks: PronunciationMark[]
  note: string
  voice: FeedbackVoice
  includeTitle: boolean
  status: 'local' | 'issue-opened'
  issueUrl: string | null
}

export interface PronunciationReportInput {
  id: string
  createdAt: number
  appBuildId: string
  book: PronunciationReport['book']
  paragraph: FeedbackParagraph
  marks: PronunciationMark[]
  note: string
  voice: FeedbackVoice
  includeTitle: boolean
}
