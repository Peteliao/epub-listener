declare module '*.mjs' {
  export interface AbGroup {
    label: string
    values: number[]
  }

  export interface AbAnalysis {
    metric: string
    direction: 'lower' | 'none'
    summary: Array<{
      label: string
      n: number
      mean: number
      std: number
      ci95: [number, number]
    }>
    F: number
    etaSquared: number
    permutationP: number
    permutations: number
    significant: boolean
    best: string | null
    conclusion: string
  }

  export function analyse(
    label: string,
    groups: AbGroup[],
    seed?: number,
    direction?: 'lower' | 'none',
  ): AbAnalysis
}
