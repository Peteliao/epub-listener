import { describe, expect, it } from 'vitest'
import { planSpeechPhrasing } from '../src/core/text/SpeechPhrasing'

const LONG_BUT = '他本来想今天早上去图书馆把上周借的那本关于中国古代建筑史的书还掉可是走到半路发现借书卡忘在家里了。'
const LONG_BECAUSE = '他之所以没有立即回答是因为他需要时间整理自己的思绪并且确认这句话不会伤害到对方。'
const LONG_IF = '如果一个人总是习惯于在遇到问题的时候逃避那么他最终失去的可能不仅仅是解决问题的机会还有改变自己的能力。'

describe('2026-11-23 第十一轮：长句语义停顿', () => {
  it('在长分句的转折/递进连接词前插入一个语义逗号', () => {
    expect(planSpeechPhrasing(LONG_BUT)).toContain('，可是')
    expect(planSpeechPhrasing(LONG_BECAUSE)).toContain('，并且')
    expect(planSpeechPhrasing(LONG_IF)).toContain('，那么')
  })

  it('不改动任何汉字，只增加标点', () => {
    for (const sentence of [LONG_BUT, LONG_BECAUSE, LONG_IF]) {
      const planned = planSpeechPhrasing(sentence)
      expect(planned.replaceAll('，', '')).toBe(sentence.replaceAll('，', ''))
    }
  })

  it('短分句、已有标点、句首连接词不插入', () => {
    expect(planSpeechPhrasing('他不是不想去而是不能去。')).toBe('他不是不想去而是不能去。')
    expect(planSpeechPhrasing('如果下雨，那么我们就不去了。')).toBe('如果下雨，那么我们就不去了。')
    expect(planSpeechPhrasing('但是我还是去了。')).toBe('但是我还是去了。')
    // 之所以 contains 所以; the planner must not split it.
    expect(planSpeechPhrasing(LONG_BECAUSE)).not.toContain('之所，以')
  })

  it('最多一次，且幂等', () => {
    const long = '他本来想今天早上去图书馆把上周借的那本关于中国古代建筑史的书还掉可是走到半路发现借书卡忘在家里了因此只能原路返回并且重新安排时间。'
    const planned = planSpeechPhrasing(long)
    expect(planned.split('，')).toHaveLength(2)
    expect(planSpeechPhrasing(planned)).toBe(planned)
  })
})
