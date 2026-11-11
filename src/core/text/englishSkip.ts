export interface SpeechChunkLike {
  engine: 'ai' | 'system'
  lang: 'zh' | 'en'
}

export interface EnglishSkipContext {
  /** User preference. */
  enabled: boolean
  /** The offline AI engine carries Chinese while locked. */
  aiMode: boolean
  hidden: boolean
  ios: boolean
}

/**
 * iOS suspends speechSynthesis the moment the screen locks, while the offline
 * voice keeps playing through the media element. Skipping English chunks is
 * the only way to keep the reading chain moving on-device.
 */
export function shouldSkipEnglishChunk(
  chunk: SpeechChunkLike,
  context: EnglishSkipContext,
): boolean {
  return (
    context.enabled &&
    context.aiMode &&
    context.hidden &&
    context.ios &&
    chunk.engine === 'system' &&
    chunk.lang === 'en'
  )
}
