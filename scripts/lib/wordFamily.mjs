// Dev-only: shared data + runtime-path mirrors for the 多音字词组 audit.
//
// The app's own path is:
//   ReaderController -> SherpaDriver.requestBuffer -> preparePronunciationText
//   -> worker.patchLexicon(base + [curated, bookOverlay]) -> Matcha longest match
//   -> WASM -> utteranceParts(U+2060) split -> join 120ms.
//
// The .ts guard cannot be imported from Node (it loads `.txt?raw` via Vite), so
// this module mirrors the two pure transforms. tests/WordFamily.test.ts asserts
// the mirror and the real guard produce byte-identical strings, so the WASM
// measurements in audit-word-family.mjs test the text the app really speaks.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseEntries,
  parseOverlay,
  ROOT,
  tokenizeSpans,
  maxWordLength,
  phoneticPhones,
} from './reading.mjs'
import { sentenceTokens } from './fusionRisk.mjs'
import { sentenceCoverage } from './omission.mjs'

export const WORD_BOUNDARY = '\u200b'
export const UTTERANCE_RESET = '\u2060'
export const HAN = /\p{Script=Han}/u

/** The eight words the listener reported, plus the two already-pinned words. */
export const WORD_FAMILY = Object.freeze([
  {
    word: '小便宜', char: '便', offset: 1, phone: 'pian2', family: '便宜',
    neutral: '宜',
    contexts: [
      { label: '短句', sentence: '他这个人最爱占小便宜。' },
      { label: '整块', sentence: '他这个人最爱占小便宜，一点点亏都不肯吃，大家背后都懒得跟他计较。' },
    ],
  },
  {
    word: '捡便宜', char: '便', offset: 1, phone: 'pian2', family: '便宜',
    neutral: '宜',
    contexts: [
      { label: '短句', sentence: '他只想捡便宜。' },
      { label: '整块', sentence: '别人打仗他躲得远远的，等到分战利品时倒第一个跑来捡便宜，谁也不傻。' },
    ],
  },
  {
    word: '讨便宜', char: '便', offset: 1, phone: 'pian2', family: '便宜',
    neutral: '宜',
    contexts: [
      { label: '短句', sentence: '不要总想着讨便宜。' },
      { label: '整块', sentence: '徐寿辉本想讨便宜，结果反倒把自己赔了进去，账算得一点也不精。' },
    ],
  },
  {
    word: '贪便宜', char: '便', offset: 1, phone: 'pian2', family: '便宜',
    neutral: '宜',
    contexts: [
      { label: '短句', sentence: '他不肯吃亏，只想贪便宜。' },
      { label: '整块', sentence: '他不肯吃亏，只想贪便宜，讨便宜也没讨着，捡便宜倒是很在行。' },
    ],
  },
  {
    word: '便宜货', char: '便', offset: 0, phone: 'pian2', family: '便宜',
    // Real-WASM A/B (scripts/scratch/ab-word-family.mjs): the neutral `yi` made
    // the first two syllables collapse (93/93/128ms short, 46/93/174ms long),
    // while `yi2` stays 244/256/140 and 244/267/197. Third syllable huo4 breaks
    // the two-rising-tone fusion, so this word is a documented exception.
    neutral: '宜', expectedNeutralPhone: 'yi2',
    contexts: [
      { label: '短句', sentence: '这全是便宜货。' },
      { label: '整块', sentence: '那批便宜货看着光鲜，用不了几天就散了架，账房先生直摇头。' },
    ],
  },
  {
    word: '抢地盘', char: '地', offset: 1, phone: 'di4', family: '地盘',
    contexts: [
      { label: '短句', sentence: '他们又去抢地盘。' },
      { label: '整块', sentence: '朱元璋和张士诚都想抢地盘，谁也不肯先退一步，边境上天天有小仗。' },
    ],
  },
  {
    word: '占地盘', char: '地', offset: 1, phone: 'di4', family: '地盘',
    contexts: [
      { label: '短句', sentence: '陈友谅只想占地盘。' },
      { label: '整块', sentence: '陈友谅一路往东占地盘，地盘越大，要养的兵就越多，粮草先撑不住了。' },
    ],
  },
  {
    word: '地盘', char: '地', offset: 0, phone: 'di4', family: '地盘',
    contexts: [
      // A 4-character sentence is too short for duration ablation (-12ms noise);
      // use the confirmed feedback clause instead (20 chars, 233/256ms normal).
      { label: '短句', sentence: '自己只是占了点地盘；' },
      { label: '整块', sentence: '朱元璋对张士诚极为头疼，自己只是占了点地盘；' },
    ],
  },
])

/** Words that must NOT be touched by the family repair. */
export const EXCLUSIONS = Object.freeze([
  { word: '便宜从事', char: '便', offset: 0, phone: 'bian4' },
  { word: '便宜施行', char: '便', offset: 0, phone: 'bian4' },
  { word: '便宜行事', char: '便', offset: 0, phone: 'bian4' },
  { word: '小便', char: '便', offset: 1, phone: 'bian4' },
  { sentence: '长期地用盐不给钱。', char: '地', occurrence: 1, phone: 'de' },
])

export const FEEDBACK_SENTENCE = '正因如此，一些会占便宜的有钱人长期地用盐不给钱。'
export const BOOK_BLOCK = '正因如此，一些会占便宜的有钱人家长期地用盐不给钱，全“记在账上”。'
export const DIPAN_SENTENCE = '朱元璋对张士诚极为头疼，自己只是占了点地盘；'

export function overlayRows(text) {
  return String(text).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

export function readAsset(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/**
 * Mirrors worker.patchLexicon(): drop every base line whose word appears in the
 * overlay, then append the overlay rows verbatim. `curatedFirst` reproduces the
 * pre-fix AiModel.ts order ([curated, bookOverlay]); the fixed order is
 * [bookOverlay-without-curated-words, curated].
 *
 * Returns both the runtime map (parseEntries = last line wins, what Matcha does)
 * and the audit map (parseOverlay = first line wins, what the old gates saw).
 */
export function buildRuntimeLexicon({ lexiconText, curatedText, bookText = '', curatedFirst = false }) {
  const curated = overlayRows(curatedText)
  const curatedWords = new Set(curated.map((line) => line.split(/\s+/)[0]))
  const book = overlayRows(bookText).filter(
    (line) => !curatedWords.has(line.split(/\s+/)[0]),
  )
  const overlayLines = curatedFirst ? [...curated, ...book] : [...book, ...curated]
  const overlayText = overlayLines.join('\n')
  const words = new Set(overlayLines.map((line) => line.split(/\s+/)[0]))
  const kept = String(lexiconText).split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    return trimmed && !trimmed.startsWith('#') && !words.has(trimmed.split(/\s+/)[0])
  })
  const patchedText = `${kept.join('\n')}\n${overlayLines.join('\n')}\n`
  return {
    patchedText,
    overlayText,
    runtimeMap: parseEntries(patchedText),
    auditMap: parseOverlay(overlayText).entries,
    curatedFirst,
    bookRowsShadowed: overlayRows(bookText).length - book.length,
  }
}

/** Mirror of the sorted word lists in pronunciationGuard.ts. */
export function loadWordLists() {
  const read = (relative) => readAsset(relative)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .sort((a, b) => Array.from(b).length - Array.from(a).length || a.localeCompare(b, 'zh'))
  return {
    protectedWords: read('src/core/tts/protectedWords.v1.txt'),
    resetWords: read('src/core/tts/utteranceResets.v1.txt'),
  }
}

/** Mirror of protectPronunciations(): U+200B before protected words. */
export function protectPronunciations(text, words) {
  const source = String(text)
  if (!source) return source
  const sorted = [...words].sort(
    (a, b) => Array.from(b).length - Array.from(a).length || a.localeCompare(b, 'zh'),
  )
  const insertions = []
  const covered = []
  for (const word of sorted) {
    if (!word) continue
    let from = 0
    for (;;) {
      const index = source.indexOf(word, from)
      if (index < 0) break
      from = index + word.length
      if (index === 0 || !HAN.test(source[index - 1])) continue
      if (source[index - 1] === WORD_BOUNDARY) continue
      if (covered.some(([start, end]) => index >= start && index < end)) continue
      insertions.push(index)
      covered.push([index, index + word.length])
    }
  }
  if (!insertions.length) return source
  insertions.sort((a, b) => b - a)
  let result = source
  for (const index of insertions) {
    result = `${result.slice(0, index)}${WORD_BOUNDARY}${result.slice(index)}`
  }
  return result
}

/** Mirror of applyUtteranceResets(): U+2060 before the U+200B of a reset word. */
export function applyUtteranceResets(text, protectedWords, resetWords) {
  const source = String(text)
  if (!source) return source
  const insertions = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== WORD_BOUNDARY) continue
    const longest = protectedWords.find((word) => source.startsWith(word, index + 1))
    if (longest && !resetWords.includes(longest)) continue
    if (!resetWords.some((word) => source.startsWith(word, index + 1))) continue
    if (index === 0 || source[index - 1] === UTTERANCE_RESET) continue
    insertions.push(index)
  }
  let result = source
  for (const index of insertions.reverse()) {
    result = `${result.slice(0, index)}${UTTERANCE_RESET}${result.slice(index)}`
  }
  return result
}

/** Mirror of preparePronunciationText(). */
export function prepareRuntimeText(text, lists = loadWordLists()) {
  return applyUtteranceResets(
    protectPronunciations(text, lists.protectedWords),
    lists.protectedWords,
    lists.resetWords,
  )
}

/** Mirror of worker.utteranceParts(): returns null when no split is needed. */
export function utteranceParts(text) {
  const parts = String(text).split(UTTERANCE_RESET).map((part) => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts : null
}

/**
 * The text the app actually hands the acoustic model. The worker splits at
 * U+2060 and synthesises each part independently, so measuring the WHOLE long
 * sentence is wrong: `min_words_in_sentence=12` then splits a 30-phone stream
 * differently and duration ablation returns noise (negatives, three syllables
 * at >350ms at once). Return only the part containing the target word.
 */
export function appSegments(sentence, word, lists = loadWordLists()) {
  const prepared = prepareRuntimeText(sentence, lists)
  const parts = utteranceParts(prepared)
  if (!parts) return [{ label: '整句一次合成', text: prepared, split: false }]
  return parts
    .map((part, index) => ({ label: `第 ${index + 1} 段（语句重置）`, text: part, split: true }))
    .filter((part) => part.text.includes(word))
}

/** Full token stream for a sentence under a given effective lexicon. */
export function streamFor(sentence, word, effective) {
  const { tokens, ranges } = sentenceTokens(
    sentence, effective, maxWordLength(effective),
  )
  const range = ranges.find((item) => item.word === word)
  if (!range) return null
  const reading = effective.get(word) ?? ''
  const phones = phoneticPhones(reading)
  if (!phones.length || phones.length !== Array.from(word).length) return null
  return { tokens, range, phones, count: phones.length, reading }
}

export function coverageOf(sentence, word, effective) {
  return sentenceCoverage(streamFor(sentence, word, effective), sentence)
}

export function spanOf(sentence, word, effective) {
  return tokenizeSpans(sentence, effective, maxWordLength(effective))
    .some((span) => span.word === word)
}

/**
 * 2026-11-11 seventh round: 「X便 + 宜」被更长的 X便 词条抢走「便」。 These are
 * NOT 便宜-family words; the pián reading belongs to the following 便宜. The
 * real Matcha front end (debug=1) resolved each phrase as `stolen` + 宜 before
 * the curated rows were added, so every one needs its own whole-word entry.
 */
export const STEAL_CASES = Object.freeze([
  { phrase: '不便宜', word: '不便宜', stolen: '不便', stolenReading: 'bu2 bian4' },
  { phrase: '就便宜', word: '就便宜', stolen: '就便', stolenReading: 'jiu4 bian4' },
  { phrase: '以便宜', word: '以便宜', stolen: '以便', stolenReading: 'yi3 bian4' },
  { phrase: '得便宜', word: '得便宜', stolen: '得便', stolenReading: 'de2 bian4' },
  { phrase: '趁便宜', word: '趁便宜', stolen: '趁便', stolenReading: 'chen4 bian4' },
])

/**
 * Genuine `X便 + 宜` contexts: the 便 here really is biàn, so they must never be
 * captured by the steal-case rows. Guarding them keeps the diffusion honest.
 */
export const STEAL_EXCLUSIONS = Object.freeze([
  { phrase: '方便宜人', word: '方便', phone: 'bian4' },
  { phrase: '便宜行事', word: '便宜行事', phone: 'bian4' },
  { phrase: '便宜从事', word: '便宜从事', phone: 'bian4' },
])

/**
 * 2026-11-11 eighth round: single-character 长.
 *
 * The base lexicon's single-char fallback is `zhang3`, and bookLexicon only
 * generates words of >= 2 Han characters, so a standalone/comparative 长 can
 * never be fixed by the per-book overlay. These are the real book contexts
 * (明朝那些事儿, 69 single-char 长 occurrences) that are unambiguously cháng; each
 * needs a multi-character curated row.
 */
export const LONG_CASES = Object.freeze([
  { phrase: '活得比他长就是了。', word: '比他长', phone: 'chang2' },
  { phrase: '活得还要长，也真算是老天开眼。', word: '活得还要长', phone: 'chang2' },
  { phrase: '比明朝的历史还要长，一直到清朝雍正。', word: '历史还要长', phone: 'chang2' },
  { phrase: '待朱允炆年岁稍长，发现他很聪明。', word: '稍长', phone: 'chang2' },
  { phrase: '既然如此，就以己之长，攻彼之短。', word: '之长', phone: 'chang2' },
  { phrase: '时间一长，天也黑了。', word: '时间一长', phone: 'chang2' },
  { phrase: '长此下去怎么得了。', word: '长此下去', phone: 'chang2' },
  { phrase: '时间不长，四处仍然可见。', word: '时间不长', phone: 'chang2' },
  { phrase: '因为她入宫不长，且皇帝之前已。', word: '入宫不长', phone: 'chang2' },
  { phrase: '他们官龄也长，想当年他们中。', word: '官龄也长', phone: 'chang2' },
  { phrase: '而这份合同的年限也实在有点长。', word: '有点长', phone: 'chang2' },
  { phrase: '这场历时极长、影响极大的抗争。', word: '极长', phone: 'chang2' },
  { phrase: '即所谓“一寸长，一寸强”。', word: '一寸长', phone: 'chang2' },
  { phrase: '终于熬了过来，活得比朱元璋长。', word: '比朱元璋长', phone: 'chang2' },
  { phrase: '幸福生活长不了。', word: '长不了', phone: 'chang2' },
  { phrase: '霍维华感觉明熹宗怕是活不长了。', word: '活不长', phone: 'chang2' },
  { phrase: '太有个性的人注定是混不长的。', word: '混不长', phone: 'chang2' },
  { phrase: '因为石部长不但个子高（长八尺）。', word: '长八尺', phone: 'chang2', occurrence: 2 },
  { phrase: '位置险要，东西长十五里，南北宽。', word: '长十五里', phone: 'chang2' },
  { phrase: '这是一列长队，从前到后，长几十里。', word: '长几十里', phone: 'chang2', occurrence: 2 },
  { phrase: '有枪管五个，各长一尺五寸。', word: '长一尺五寸', phone: 'chang2' },
  { phrase: '在漳水两岸筑长堤四十余里。', word: '长堤', phone: 'chang2' },
  { phrase: '拉出了几条长铁索，用火烧红。', word: '长铁索', phone: 'chang2' },
  { phrase: '字长卿，万历二十六年。', word: '长卿', phone: 'chang2' },
  { phrase: '这个女儿，叫做长平公主。', word: '长平公主', phone: 'chang2' },
  { phrase: '怎么从长，喝西北风？', word: '从长', phone: 'chang2' },
])

/**
 * 2026-11-11 ninth round: single-character 地 nouns. The phone is always di4;
 * the failure is acoustic (the final 地 is compressed to 47–81ms and sounds like
 * de). Two or three real contexts per word chose the boundary; 地心/地洞 measured
 * normal with no boundary and are listed to keep them that way.
 */
export const DI_CASES = Object.freeze([
  {
    word: '荒地', boundary: 'tail',
    contexts: ['村里把荒地开垦成了良田。', '这片荒地一直没人耕种。'],
  },
  {
    word: '空地', boundary: 'lead',
    contexts: ['楼前有一片空地可以停车。', '楼后的空地上堆满了杂物。'],
  },
  {
    word: '林地', boundary: 'tail',
    contexts: ['这片林地受到严格保护。', '这片林地归村里所有。'],
  },
  {
    word: '本地', boundary: 'tail',
    contexts: ['这家店只卖本地特产。', '本地特产很受欢迎。'],
  },
  {
    word: '地图', boundary: 'both',
    contexts: ['他打开地图寻找路线。', '墙上挂着一张地图。', '地图上标着路线。'],
  },
  {
    word: '地心', boundary: 'none',
    contexts: ['科学家在研究地心的结构。', '地心的温度非常高。', '地球的地心是滚烫的。'],
  },
  {
    word: '地洞', boundary: 'none',
    contexts: ['兔子钻进地洞里躲了起来。', '这个地洞通向山后。', '地洞里黑漆漆的。'],
  },
])

/** zhǎng contexts that must keep the base reading; broad cháng rows must not eat them. */
export const LONG_EXCLUSIONS = Object.freeze([
  { phrase: '北大校长蒋梦麟', pattern: '^zhang' },
  { phrase: '作为明军总参谋长', pattern: '^zhang' },
  { phrase: '他是机要处处长。', pattern: '^zhang' },
  { phrase: '难道他还长了翅膀？', pattern: '^zhang' },
  { phrase: '复宇，辽东宁远人，生在宁远，长在宁远', pattern: '^zhang' },
  { phrase: '根据明朝规定，皇子长到六岁', pattern: '^zhang' },
  { phrase: '文皇少长习兵，据幽燕形胜', pattern: '^zhang' },
  { phrase: '十几岁正好是少年儿童长身体的时候', pattern: '^zhang' },
  { phrase: '长知识，长见识，长本事', pattern: '^zhang' },
  { phrase: '◆ 不长记性啊', pattern: '^zhang' },
  { phrase: '他指着皇长子', pattern: '^zhang' },
  { phrase: '他成长了，从一个战争的爱好者', pattern: '^zhang' },
])
