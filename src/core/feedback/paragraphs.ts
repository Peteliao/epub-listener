import { joinSentenceText } from '@/core/text/speechGroups'
import type { FeedbackParagraph } from './types'

export interface GroupableSentenceLike {
  text: string
  speechText: string
  paragraphEnd: boolean
}

interface ParagraphGroup {
  start: number
  end: number
  text: string
  speechText: string
}

function groupParagraphs(
  sentences: readonly GroupableSentenceLike[],
): ParagraphGroup[] {
  const groups: ParagraphGroup[] = []
  let start = 0

  for (let index = 0; index < sentences.length; index += 1) {
    if (!sentences[index]!.paragraphEnd && index < sentences.length - 1) continue
    const slice = sentences.slice(start, index + 1)
    groups.push({
      start,
      end: index,
      text: joinSentenceText(slice.map((sentence) => sentence.text)),
      speechText: joinSentenceText(
        slice.map((sentence) => sentence.speechText),
      ),
    })
    start = index + 1
  }

  return groups
}

/**
 * Returns a small window of paragraphs around the reader's current position.
 * Playback can advance a paragraph or two before the feedback sheet opens, so
 * the previous paragraphs stay selectable.
 */
export function buildFeedbackParagraphs(
  sentences: readonly GroupableSentenceLike[],
  currentSentenceIndex: number,
  chapterHref: string,
  windowSize = 2,
): FeedbackParagraph[] {
  if (!sentences.length) return []

  const groups = groupParagraphs(sentences)
  const target = Math.min(
    Math.max(currentSentenceIndex, 0),
    sentences.length - 1,
  )
  let currentGroup = groups.findIndex(
    (group) => target >= group.start && target <= group.end,
  )
  if (currentGroup < 0) currentGroup = groups.length - 1

  const from = Math.max(0, currentGroup - windowSize)
  const to = Math.min(groups.length - 1, currentGroup + 1)

  return groups.slice(from, to + 1).map((group, offset) => {
    const groupIndex = from + offset
    return {
      id: `${chapterHref}#p${group.start}`,
      text: group.text,
      speechText: group.speechText,
      startSentenceIndex: group.start,
      endSentenceIndex: group.end,
      isCurrent: groupIndex === currentGroup,
    }
  })
}
