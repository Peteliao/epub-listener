import { describe, expect, it } from 'vitest'
import {
  integerToEnglishWords,
  normalizeEnglishSpeech,
} from '../src/core/text/englishText'

describe('integerToEnglishWords', () => {
  it('spells small and compound numbers', () => {
    expect(integerToEnglishWords(0)).toBe('zero')
    expect(integerToEnglishWords(7)).toBe('seven')
    expect(integerToEnglishWords(21)).toBe('twenty one')
    expect(integerToEnglishWords(100)).toBe('one hundred')
    expect(integerToEnglishWords(123)).toBe('one hundred twenty three')
    expect(integerToEnglishWords(1000)).toBe('one thousand')
    expect(integerToEnglishWords(2500000)).toBe('two million five hundred thousand')
  })

  it('falls back to digit spelling for huge values', () => {
    expect(integerToEnglishWords(10_000_000_000_000_000)).toContain(' ')
  })
})

describe('normalizeEnglishSpeech', () => {
  it('reads years and cardinals', () => {
    expect(normalizeEnglishSpeech('In 1984')).toBe('In nineteen eighty four')
    expect(normalizeEnglishSpeech('1905 was cold')).toBe('nineteen oh five was cold')
    expect(normalizeEnglishSpeech('by 2000')).toBe('by two thousand')
    expect(normalizeEnglishSpeech('in 2026')).toBe('in two thousand twenty six')
    expect(normalizeEnglishSpeech('Chapter 12')).toBe('Chapter twelve')
  })

  it('reads decades', () => {
    expect(normalizeEnglishSpeech('the 1990s')).toBe('the nineteen nineties')
    expect(normalizeEnglishSpeech("the '90s")).toBe('the nineteen nineties')
    expect(normalizeEnglishSpeech('the 2000s')).toBe('the two thousands')
  })

  it('reads decimals, percent, and currency', () => {
    expect(normalizeEnglishSpeech('Pi is 3.14')).toBe('Pi is three point one four')
    expect(normalizeEnglishSpeech('50% off')).toBe('fifty percent off')
    expect(normalizeEnglishSpeech('12.5 percent')).toBe(
      'twelve point five percent',
    )
    expect(normalizeEnglishSpeech('$5')).toBe('five dollars')
    expect(normalizeEnglishSpeech('$1')).toBe('one dollar')
    expect(normalizeEnglishSpeech('$5.99')).toBe(
      'five dollars and ninety nine cents',
    )
    expect(normalizeEnglishSpeech('€20')).toBe('twenty euros')
    expect(normalizeEnglishSpeech('£1')).toBe('one pound')
    expect(normalizeEnglishSpeech('20$')).toBe('twenty dollars')
  })

  it('reads times and ordinals', () => {
    expect(normalizeEnglishSpeech('at 3:30')).toBe('at three thirty')
    expect(normalizeEnglishSpeech('at 9:00')).toBe("at nine o'clock")
    expect(normalizeEnglishSpeech('at 14:05')).toBe('at fourteen oh five')
    expect(normalizeEnglishSpeech('the 1st')).toBe('the first')
    expect(normalizeEnglishSpeech('the 22nd')).toBe('the twenty second')
    expect(normalizeEnglishSpeech('the 11th')).toBe('the eleventh')
    expect(normalizeEnglishSpeech('the 5th')).toBe('the fifth')
  })

  it('reads dates', () => {
    expect(normalizeEnglishSpeech('2026-10-29')).toBe(
      'October twenty ninth, two thousand twenty six',
    )
    expect(normalizeEnglishSpeech('10/29/2026')).toBe(
      'October twenty ninth, two thousand twenty six',
    )
    expect(normalizeEnglishSpeech('January 3')).toBe('January third')
    expect(normalizeEnglishSpeech('Jan. 3')).toBe('January third')
    expect(normalizeEnglishSpeech('May 5th')).toBe('May fifth')
  })

  it('expands abbreviations and symbols', () => {
    expect(normalizeEnglishSpeech('Mr. Smith')).toBe('Mister Smith')
    expect(normalizeEnglishSpeech('Dr. Who')).toBe('Doctor Who')
    expect(normalizeEnglishSpeech('Main St.')).toBe('Main Street')
    expect(normalizeEnglishSpeech('St. Paul')).toBe('Saint Paul')
    expect(normalizeEnglishSpeech('e.g. this')).toBe('for example this')
    expect(normalizeEnglishSpeech('at 5 p.m.')).toBe('at five P M')
    expect(normalizeEnglishSpeech('No. 5')).toBe('Number five')
    expect(normalizeEnglishSpeech('30°C')).toBe('thirty degrees Celsius')
    expect(normalizeEnglishSpeech('3 × 4')).toBe('three times four')
    expect(normalizeEnglishSpeech('salt & pepper')).toBe('salt and pepper')
  })

  it('spells phone numbers digit by digit', () => {
    expect(normalizeEnglishSpeech('5551234')).toBe(
      'five five five one two three four',
    )
  })

  it('keeps ranges and straightens typography', () => {
    expect(normalizeEnglishSpeech('1990-1995')).toBe(
      'nineteen ninety to nineteen ninety five',
    )
    expect(normalizeEnglishSpeech('3-5')).toBe('three to five')
    expect(normalizeEnglishSpeech('don’t')).toBe("don't")
    expect(normalizeEnglishSpeech('well-known')).toBe('well known')
  })

  it('leaves plain English intact', () => {
    expect(normalizeEnglishSpeech('The quick brown fox.')).toBe(
      'The quick brown fox.',
    )
    expect(normalizeEnglishSpeech('   ')).toBe('')
  })
})
