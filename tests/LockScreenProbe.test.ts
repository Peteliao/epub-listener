import { describe, expect, it } from 'vitest'
import {
  analyzeProbeEvidence,
  pickProbeSession,
  type ProbeEvidence,
  type ProbeSession,
} from '../src/core/system/LockScreenProbe'

const START = 1_700_000_000_000
const HIDDEN_START = START + 3_000
const HIDDEN_END = HIDDEN_START + 20_000

function makeSession(overrides: Partial<ProbeSession> = {}): ProbeSession {
  return {
    startWall: HIDDEN_START,
    endWall: HIDDEN_END,
    durationMs: HIDDEN_END - HIDDEN_START,
    clipAtHide: 'A',
    timeAtHide: 3.1,
    clipAtShow: 'B',
    timeAtShow: 10.8,
    timerTicks: 20,
    timerMaxGapMs: 1_000,
    workerTicks: 80,
    workerMaxGapMs: 250,
    workerJobDoneWall: START + 7_200,
    ...overrides,
  }
}

function makeEvidence(
  overrides: Partial<ProbeEvidence> = {},
): ProbeEvidence {
  return {
    audioSupported: true,
    workerSupported: true,
    aStartedWall: START,
    aEndedWall: START + 12_100,
    bRequestWall: START + 12_150,
    bRequestHidden: true,
    bPlayRejectedWall: null,
    bEndedWall: null,
    jobRequestedWall: START + 6_000,
    jobDoneWall: START + 7_200,
    sessions: [makeSession()],
    ...overrides,
  }
}

describe('analyzeProbeEvidence', () => {
  it('passes when media, chain and worker all survive', () => {
    expect(analyzeProbeEvidence(makeEvidence()).code).toBe('ok')
  })

  it('reports an unsupported browser', () => {
    expect(
      analyzeProbeEvidence(makeEvidence({ audioSupported: false })).code,
    ).toBe('unsupported')
  })

  it('asks for another run when no lock session was recorded', () => {
    expect(analyzeProbeEvidence(makeEvidence({ sessions: [] })).code).toBe(
      'incomplete',
    )
  })

  it('asks for another run when the lock was too short', () => {
    const session = makeSession({
      endWall: HIDDEN_START + 10_000,
      durationMs: 10_000,
    })
    expect(
      analyzeProbeEvidence(makeEvidence({ sessions: [session] })).code,
    ).toBe('incomplete')
  })

  it('reports media stopped when the audio clock does not move', () => {
    const session = makeSession({
      clipAtShow: 'A',
      timeAtShow: 3.2,
    })
    const verdict = analyzeProbeEvidence(
      makeEvidence({ aEndedWall: null, bRequestWall: null, sessions: [session] }),
    )
    expect(verdict.code).toBe('media-stopped')
  })

  it('reports a frozen page when A ended but B never started', () => {
    const session = makeSession({ clipAtShow: 'A', timeAtShow: 12 })
    const verdict = analyzeProbeEvidence(
      makeEvidence({ bRequestWall: null, sessions: [session] }),
    )
    expect(verdict.code).toBe('js-frozen')
  })

  it('reports a frozen page when A reached the end without an ended event', () => {
    const session = makeSession({ clipAtShow: 'A', timeAtShow: 11.98 })
    const verdict = analyzeProbeEvidence(
      makeEvidence({
        aEndedWall: null,
        bRequestWall: null,
        sessions: [session],
      }),
    )
    expect(verdict.code).toBe('js-frozen')
  })

  it('reports a frozen page when the ended handler only ran on resume', () => {
    const session = makeSession({
      clipAtShow: 'B',
      timeAtShow: 0,
    })
    const verdict = analyzeProbeEvidence(
      makeEvidence({
        aEndedWall: START + 22_000,
        bRequestWall: START + 22_050,
        bRequestHidden: true,
        sessions: [session],
      }),
    )
    expect(verdict.code).toBe('js-frozen')
  })

  it('reports a frozen page when the next clip starts only after unlock', () => {
    const verdict = analyzeProbeEvidence(
      makeEvidence({ bRequestHidden: false }),
    )
    expect(verdict.code).toBe('js-frozen')
  })

  it('reports a blocked chain when background play() is rejected', () => {
    const session = makeSession({ clipAtShow: 'B', timeAtShow: 0 })
    const verdict = analyzeProbeEvidence(
      makeEvidence({
        bPlayRejectedWall: START + 12_200,
        sessions: [session],
      }),
    )
    expect(verdict.code).toBe('chain-blocked')
  })

  it('reports a blocked chain when play() resolved but no audio came out', () => {
    const session = makeSession({ clipAtShow: 'B', timeAtShow: 0 })
    const verdict = analyzeProbeEvidence(
      makeEvidence({ sessions: [session] }),
    )
    expect(verdict.code).toBe('chain-blocked')
  })

  it('reports a frozen worker when its heartbeat stops', () => {
    const session = makeSession({ workerTicks: 0, workerMaxGapMs: null })
    const verdict = analyzeProbeEvidence(
      makeEvidence({ sessions: [session] }),
    )
    expect(verdict.code).toBe('worker-frozen')
  })

  it('reports a frozen worker when the background job never finished', () => {
    const session = makeSession({ workerJobDoneWall: null })
    const verdict = analyzeProbeEvidence(
      makeEvidence({ jobDoneWall: null, sessions: [session] }),
    )
    expect(verdict.code).toBe('worker-frozen')
  })

  it('does not require the worker job when it was not requested while locked', () => {
    const verdict = analyzeProbeEvidence(
      makeEvidence({ jobRequestedWall: null, jobDoneWall: null }),
    )
    expect(verdict.code).toBe('ok')
  })
})

describe('pickProbeSession', () => {
  it('prefers the session that contains the A/B switch', () => {
    const first = makeSession({
      startWall: START,
      endWall: START + 5_000,
      durationMs: 5_000,
    })
    const second = makeSession()
    const picked = pickProbeSession([first, second], START + 12_100)
    expect(picked).toBe(second)
  })

  it('falls back to the longest session', () => {
    const first = makeSession({
      startWall: START,
      endWall: START + 5_000,
      durationMs: 5_000,
    })
    const second = makeSession({
      startWall: START + 10_000,
      endWall: START + 30_000,
      durationMs: 20_000,
    })
    expect(pickProbeSession([first, second], null)).toBe(second)
  })
})
