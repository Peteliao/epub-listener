import { describe, expect, it } from 'vitest'
import { analyse } from '../scripts/ab-stats.mjs'

describe('A/B statistics', () => {
  it('does not call a flat grid significant', () => {
    const result = analyse(
      'flat',
      [
        { label: 'a', values: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3] },
        { label: 'b', values: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3] },
        { label: 'c', values: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3] },
      ],
      7,
    )
    expect(result.F).toBe(0)
    expect(result.significant).toBe(false)
    expect(result.best).toBeNull()
  })

  it('detects a real separation and names the lowest cost group', () => {
    const result = analyse(
      'separated',
      [
        { label: '0.5', values: [0.31, 0.312, 0.309, 0.311, 0.313, 0.31] },
        { label: '0.667', values: [0.3, 0.301, 0.299, 0.302, 0.3, 0.301] },
        { label: '0.8', values: [0.314, 0.313, 0.316, 0.312, 0.315, 0.314] },
      ],
      11,
    )
    expect(result.significant).toBe(true)
    expect(result.permutationP).toBeLessThan(0.05)
    expect(result.etaSquared).toBeGreaterThan(0.5)
    expect(result.best).toBe('0.667')
  })

  it('refuses to pick a winner for a taste metric', () => {
    const result = analyse(
      'taste',
      [
        { label: '0.8', values: [0.13, 0.132, 0.131, 0.133] },
        { label: '1', values: [0.145, 0.144, 0.146, 0.145] },
        { label: '1.2', values: [0.171, 0.17, 0.172, 0.171] },
      ],
      13,
      'none',
    )
    expect(result.significant).toBe(true)
    expect(result.direction).toBe('none')
    expect(result.best).toBeNull()
  })

  it('is reproducible for a fixed seed', () => {
    const groups = [
      { label: 'a', values: [1, 2, 3, 2, 1] },
      { label: 'b', values: [2, 3, 4, 3, 2] },
      { label: 'c', values: [3, 4, 5, 4, 3] },
    ]
    expect(analyse('x', groups, 99).permutationP).toBe(
      analyse('x', groups, 99).permutationP,
    )
  })
})
