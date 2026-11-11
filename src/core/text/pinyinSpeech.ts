/**
 * Tone-marked pinyin is Latin text, so the language splitter hands it to the
 * English voice. An English model has no Mandarin syllables, and its OOV
 * fallback would spell “zhuó” as letter names. Drop pinyin runs instead, and
 * strip accents from English loanwords so the lexicon can find them.
 */

const TONE_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/u
const LATIN_WORD = /[\p{Script=Latin}\p{M}]+(?:['’][\p{Script=Latin}\p{M}]+)*/gu
const WORD_GAP = /^[\s\-–—/·,，、]*$/u

const SYLLABLES = new Set(
  (
    'a ai an ang ao ' +
    'ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ' +
    'ca cai can cang cao ce cei cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo ' +
    'da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo ' +
    'e ei en eng er ' +
    'fa fan fang fei fen feng fo fou fu ' +
    'ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ' +
    'ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ' +
    'ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ' +
    'ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo ' +
    'la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve ' +
    'ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu ' +
    'na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve ' +
    'o ou ' +
    'pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu ' +
    'qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ' +
    'ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo ' +
    'sa sai san sang sao se sei sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ' +
    'ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo ' +
    'wa wai wan wang wei wen weng wo wu ' +
    'xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ' +
    'ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun ' +
    'za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo'
  ).split(' '),
)

// Neutral-tone syllables that often appear without a mark (看着, 我们, 学生).
// Restricting unmarked members to these keeps ordinary English words out of a
// pinyin run.
const NEUTRAL_SYLLABLES = new Set([
  'a',
  'ba',
  'de',
  'ge',
  'guo',
  'hou',
  'jia',
  'la',
  'lai',
  'le',
  'li',
  'ma',
  'me',
  'men',
  'na',
  'ne',
  'qu',
  'sheng',
  'shi',
  'tou',
  'xi',
  'ya',
  'yi',
  'zhe',
  'zi',
])

// Accented English words that parse as pinyin. They should reach the English
// lexicon without the accent, not be skipped as Mandarin.
const ENGLISH_ACCENTED = new Set([
  'a',
  'amelie',
  'anime',
  'angelique',
  'asi',
  'cecile',
  'celine',
  'cezanne',
  'conge',
  'desiree',
  'einin',
  'elan',
  'eliane',
  'elise',
  'elite',
  'eminence',
  'emilie',
  'etude',
  'genie',
  'helene',
  'lea',
  'mache',
  'malaga',
  'maria',
  'marine',
  'matinee',
  'melee',
  'melanie',
  'melies',
  'menage',
  'meniere',
  'merida',
  'metier',
  'moliere',
  'musica',
  'nee',
  'oceane',
  'panama',
  'pate',
  'piece',
  'pique',
  'piu',
  'puo',
  'puree',
  'realite',
  'rene',
  'renee',
  'resume',
  'roue',
  'sake',
  'saute',
  'sautee',
  'seance',
  'sete',
  'teotihuacan',
  'tete',
  'touche',
  'yucatan',
])

type TokenKind = 'pinyin' | 'neutral' | 'english'

interface Token {
  start: number
  end: number
  text: string
  kind: TokenKind
  remove: boolean
}

function pinyinBase(word: string): string {
  const base = word
    .toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
  return /^[a-z]+$/.test(base) ? base : ''
}

function canSegment(word: string): boolean {
  const memo: Array<boolean | undefined> = new Array(word.length + 1)
  memo[word.length] = true
  const visit = (at: number): boolean => {
    const known = memo[at]
    if (known !== undefined) return known
    let result = false
    for (let size = 1; size <= 6 && at + size <= word.length; size += 1) {
      if (SYLLABLES.has(word.slice(at, at + size)) && visit(at + size)) {
        result = true
        break
      }
    }
    memo[at] = result
    return result
  }
  return visit(0)
}

function classify(text: string): TokenKind {
  const marked = TONE_MARK.test(text.toLowerCase())
  const base = pinyinBase(text)
  if (!base || !canSegment(base)) return 'english'
  if (marked) return ENGLISH_ACCENTED.has(base) ? 'english' : 'pinyin'
  return NEUTRAL_SYLLABLES.has(base) ? 'neutral' : 'english'
}

function stripDiacritics(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
}

export function stripToneMarkedPinyin(input: string): string {
  const text = input.normalize('NFC')
  const tokens: Token[] = []
  for (const match of text.matchAll(LATIN_WORD)) {
    const value = match[0]
    const start = match.index ?? 0
    tokens.push({
      start,
      end: start + value.length,
      text: value,
      kind: classify(value),
      remove: false,
    })
  }
  if (tokens.length === 0) return text

  let sequence: Token[] = []
  const flush = (): void => {
    if (sequence.some((token) => token.kind === 'pinyin')) {
      for (const token of sequence) token.remove = true
    }
    sequence = []
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (
      index > 0 &&
      !WORD_GAP.test(text.slice(tokens[index - 1]!.end, token.start))
    ) {
      flush()
    }
    if (token.kind === 'english') {
      flush()
      continue
    }
    sequence.push(token)
  }
  flush()

  let output = ''
  let cursor = 0
  for (const token of tokens) {
    output += text.slice(cursor, token.start)
    output += token.remove ? ' ' : stripDiacritics(token.text)
    cursor = token.end
  }
  return output + text.slice(cursor)
}
