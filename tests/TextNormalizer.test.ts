import { describe, expect, it } from 'vitest'
import { normalizeSpeechText } from '../src/core/text/TextNormalizer'

describe('normalizeSpeechText', () => {
  it('removes zero-width characters and control characters', () => {
    expect(normalizeSpeechText('你\u200b好\u0000，世界')).toBe('你好，世界')
  })

  it('collapses spacing while keeping readable punctuation', () => {
    expect(normalizeSpeechText('  第一句。\n\n  第二句！  ')).toBe('第一句。\n第二句！')
  })

  it('normalises ellipsis variants', () => {
    expect(normalizeSpeechText('等等......我想想')).toBe('等等……我想想')
    expect(normalizeSpeechText('等等………我想想')).toBe('等等……我想想')
  })

  it('removes gaps between Han characters that TTS would voice as a syllable', () => {
    expect(normalizeSpeechText('序 言')).toBe('序言')
    expect(normalizeSpeechText('第　一　章')).toBe('第一章')
    expect(normalizeSpeechText('作 者：林 深')).toBe('作者：林深')
  })

  it('keeps spaces that separate Latin words from Chinese text', () => {
    expect(normalizeSpeechText('打开 MacBook Pro 开始阅读')).toBe(
      '打开 MacBook Pro 开始阅读',
    )
  })

  it('joins digits to Han text so the gap is not voiced as a syllable', () => {
    expect(normalizeSpeechText('第 3 章介绍了 2026 年的计划。')).toBe(
      '第3章介绍了2026年的计划。',
    )
    expect(normalizeSpeechText('200 年的「核子冬天」')).toBe(
      '两百年的「核子冬天」',
    )
    expect(normalizeSpeechText('1.5 公尺高')).toBe('1.5公尺高')
  })

  it('reads thousands-separated numbers as Chinese numerals', () => {
    expect(normalizeSpeechText('6,500 万年前')).toBe('六千五百万年前')
    expect(normalizeSpeechText('12,345,678 人')).toBe(
      '一千二百三十四万五千六百七十八人',
    )
    expect(normalizeSpeechText('8,500年')).toBe('八千五百年')
    expect(normalizeSpeechText('5,000年')).toBe('五千年')
    expect(normalizeSpeechText('1,000')).toBe('一千')
    expect(normalizeSpeechText('1,000,000')).toBe('一百万')
    expect(normalizeSpeechText('6,500 years ago')).toBe('6,500 years ago')
  })

  it('reads numeric dates as Chinese numerals', () => {
    expect(normalizeSpeechText('2026-09-12')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('2026/09/12')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('2026/9/12')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('2026.09.12')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('09/12/2026')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('09-12-2026')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('12/09/2026')).toBe('二零二六年十二月九日')
    expect(normalizeSpeechText('12-09-2026')).toBe('二零二六年十二月九日')
    expect(normalizeSpeechText('2026年09月12日')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('2026年9月12号')).toBe('二零二六年九月十二日')
    expect(normalizeSpeechText('09月12日')).toBe('九月十二日')
    expect(normalizeSpeechText('会议定在 2026-09-12 举行。')).toBe(
      '会议定在二零二六年九月十二日举行。',
    )
  })

  it('drops spaces around Chinese punctuation that the voice would pronounce', () => {
    expect(normalizeSpeechText('（与地底爬虫族无关） 为争夺地球铜矿')).toBe(
      '（与地底爬虫族无关）为争夺地球铜矿',
    )
    expect(normalizeSpeechText('「类人族」与「爬虫族」 （与地底爬虫族无关）为争夺地球铜矿')).toBe(
      '「类人族」与「爬虫族」（与地底爬虫族无关）为争夺地球铜矿',
    )
    expect(normalizeSpeechText('他说： “好。”')).toBe('他说：“好。”')
  })

  it('reads a leading 2 before measure words as 两', () => {
    expect(normalizeSpeechText('2 年后')).toBe('两年后')
    expect(normalizeSpeechText('200 年后')).toBe('两百年后')
    expect(normalizeSpeechText('250 人')).toBe('两百五十人')
    expect(normalizeSpeechText('2,000 万年前')).toBe('两千万年前')
    expect(normalizeSpeechText('200 万年')).toBe('两百万年')
    expect(normalizeSpeechText('2 亿年')).toBe('两亿年')
    expect(normalizeSpeechText('2 小时')).toBe('两小时')
    expect(normalizeSpeechText('200 米')).toBe('两百米')
    expect(normalizeSpeechText('2 公斤')).toBe('两公斤')
    expect(normalizeSpeechText('面积2㎡')).toBe('面积两平方米')
    expect(normalizeSpeechText('气温2℃')).toBe('气温两摄氏度')
    expect(normalizeSpeechText('售价$2')).toBe('售价两美元')
  })

  it('keeps 二 for ordinals, dates, tens and decimals', () => {
    expect(normalizeSpeechText('第 2 章')).toBe('第2章')
    expect(normalizeSpeechText('公元200年')).toBe('公元200年')
    expect(normalizeSpeechText('2 月')).toBe('2月')
    expect(normalizeSpeechText('2 号楼')).toBe('2号楼')
    expect(normalizeSpeechText('2 年级')).toBe('2年级')
    expect(normalizeSpeechText('星期2')).toBe('星期2')
    expect(normalizeSpeechText('20 年')).toBe('20年')
    expect(normalizeSpeechText('2026 年')).toBe('2026年')
    expect(normalizeSpeechText('2.5 年')).toBe('2.5年')
    expect(normalizeSpeechText('增长了2%')).toBe('增长了百分之2')
  })

  it('spells out percent and per-mille signs in Chinese text', () => {
    expect(normalizeSpeechText('只有美国人的12%左右')).toBe(
      '只有美国人的百分之12左右',
    )
    expect(normalizeSpeechText('20%的埃及人口生活在赤贫中')).toBe(
      '百分之20的埃及人口生活在赤贫中',
    )
    expect(normalizeSpeechText('增长了 3.5 ％')).toBe('增长了百分之三点五')
    expect(normalizeSpeechText('利率上调了5‰')).toBe('利率上调了千分之5')
    expect(normalizeSpeechText('12%。')).toBe('百分之12。')
    expect(normalizeSpeechText('增长了12.5%')).toBe('增长了百分之十二点五')
    expect(normalizeSpeechText('占比0.75％')).toBe('占比百分之零点七五')
  })

  it('reads fractions, times, negatives and phone numbers', () => {
    expect(normalizeSpeechText('四分之三写作3/4')).toBe('四分之三写作四分之三')
    expect(normalizeSpeechText('只吃了1/2')).toBe('只吃了二分之一')
    expect(normalizeSpeechText('会议3:30开始')).toBe('会议三点半开始')
    expect(normalizeSpeechText('14:05发车')).toBe('十四点零五分发车')
    expect(normalizeSpeechText('9:00开门')).toBe('九点整开门')
    expect(normalizeSpeechText('气温-5℃')).toBe('气温零下5摄氏度')
    expect(normalizeSpeechText('下降了-5%')).toBe('下降了负百分之5')
    expect(normalizeSpeechText('余额-20元')).toBe('余额负20元')
    expect(normalizeSpeechText('3-5天到货')).toBe('3至5天到货')
    expect(normalizeSpeechText('电话13800138000')).toBe(
      '电话一三八零零一三八零零零',
    )
    expect(normalizeSpeechText('座机010-12345678')).toBe(
      '座机零一零一二三四五六七八',
    )
    expect(normalizeSpeechText('热线400-123-4567')).toBe(
      '热线四零零一二三四五六七',
    )
    expect(normalizeSpeechText('满½杯')).toBe('满二分之一杯')
  })

  it('spells out ASCII speed and area units in Chinese text', () => {
    expect(normalizeSpeechText('风速80 km/h')).toBe('风速80公里每小时')
    expect(normalizeSpeechText('速度5m/s')).toBe('速度5米每秒')
    expect(normalizeSpeechText('面积2m²')).toBe('面积两平方米')
    expect(normalizeSpeechText('体积3m³')).toBe('体积3立方米')
    expect(normalizeSpeechText('跑了5km')).toBe('跑了5公里')
    expect(normalizeSpeechText('重2kg')).toBe('重两千克')
    expect(normalizeSpeechText('水位3m')).toBe('水位3米')
  })

  it('spells out temperature, unit and currency symbols in Chinese text', () => {
    expect(normalizeSpeechText('气温25℃')).toBe('气温25摄氏度')
    expect(normalizeSpeechText('气温25°C')).toBe('气温25摄氏度')
    expect(normalizeSpeechText('气温77℉')).toBe('气温77华氏度')
    expect(normalizeSpeechText('房间面积120㎡')).toBe('房间面积120平方米')
    expect(normalizeSpeechText('水量3㎥')).toBe('水量3立方米')
    expect(normalizeSpeechText('票价￥100')).toBe('票价100元')
    expect(normalizeSpeechText('售价$20')).toBe('售价20美元')
  })

  it('spells out maths symbols and circled numbers in Chinese text', () => {
    expect(normalizeSpeechText('尺寸3×4≈12')).toBe('尺寸3乘4约等于12')
    expect(normalizeSpeechText('结果9÷3=3')).toBe('结果9除以3=3')
    expect(normalizeSpeechText('温度在3~5度之间')).toBe('温度在3至5度之间')
    expect(normalizeSpeechText('第①条')).toBe('第1条')
  })

  it('leaves non-Chinese text and already-spoken symbols untouched', () => {
    expect(normalizeSpeechText('50% off, 3×4')).toBe('50% off, 3×4')
    expect(normalizeSpeechText('50% off.')).toBe('50% off.')
    expect(normalizeSpeechText('圆周率约等于3.14。')).toBe('圆周率约等于3.14。')
  })

  it('does not rewrite the display text', () => {
    const display = '圆周率是3.14，约等于百分之九十九。'
    expect(normalizeSpeechText(display)).toBe(display)
  })
})
