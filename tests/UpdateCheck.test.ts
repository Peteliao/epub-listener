import { describe, expect, it, vi } from 'vitest'
import {
  checkForAppUpdate,
  type UpdateRegistrationLike,
  type UpdateWorkerLike,
} from '../src/ui/updateCheck'

function fakeWorker(initial: ServiceWorkerState) {
  const listeners = new Set<() => void>()
  const worker = {
    state: initial,
    addEventListener: vi.fn((_type: 'statechange', listener: () => void) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: 'statechange', listener: () => void) => {
      listeners.delete(listener)
    }),
    transition(next: ServiceWorkerState): void {
      worker.state = next
      for (const listener of [...listeners]) listener()
    },
  }
  return worker satisfies UpdateWorkerLike & {
    transition(next: ServiceWorkerState): void
  }
}

function fakeRegistration(
  overrides: Partial<UpdateRegistrationLike> = {},
): UpdateRegistrationLike & {
  waiting: UpdateWorkerLike | null
  installing: UpdateWorkerLike | null
  update: ReturnType<typeof vi.fn>
} {
  return {
    waiting: null,
    installing: null,
    update: vi.fn(async () => undefined),
    ...overrides,
  } as UpdateRegistrationLike & {
    waiting: UpdateWorkerLike | null
    installing: UpdateWorkerLike | null
    update: ReturnType<typeof vi.fn>
  }
}

describe('主动检查 PWA 更新', () => {
  it('没有 Service Worker 时返回 unavailable', async () => {
    const apply = vi.fn()
    await expect(checkForAppUpdate(null, apply)).resolves.toBe('unavailable')
    expect(apply).not.toHaveBeenCalled()
  })

  it('已有等待中的新版本时直接应用', async () => {
    const registration = fakeRegistration({ waiting: fakeWorker('installed') })
    const apply = vi.fn()

    await expect(checkForAppUpdate(registration, apply)).resolves.toBe('updated')
    expect(apply).toHaveBeenCalledOnce()
    expect(registration.update).not.toHaveBeenCalled()
  })

  it('没有新版本时返回 current', async () => {
    const registration = fakeRegistration()
    const apply = vi.fn()

    await expect(checkForAppUpdate(registration, apply)).resolves.toBe('current')
    expect(registration.update).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
  })

  it('查到新版本并安装完成后自动应用', async () => {
    const worker = fakeWorker('installing')
    const registration = fakeRegistration()
    registration.update = vi.fn(async () => {
      registration.installing = worker
      setTimeout(() => worker.transition('installed'), 0)
    })
    const apply = vi.fn()

    await expect(checkForAppUpdate(registration, apply)).resolves.toBe('updated')
    expect(apply).toHaveBeenCalledOnce()
  })

  it('安装失败时返回 failed 且不应用', async () => {
    const worker = fakeWorker('installing')
    const registration = fakeRegistration()
    registration.update = vi.fn(async () => {
      registration.installing = worker
      setTimeout(() => worker.transition('redundant'), 0)
    })
    const apply = vi.fn()

    await expect(checkForAppUpdate(registration, apply)).resolves.toBe('failed')
    expect(apply).not.toHaveBeenCalled()
  })

  it('下载超时返回 pending，完成后仍由现有自动更新流程接管', async () => {
    const worker = fakeWorker('installing')
    const registration = fakeRegistration()
    registration.update = vi.fn(async () => {
      registration.installing = worker
    })
    const apply = vi.fn()

    await expect(
      checkForAppUpdate(registration, apply, { timeoutMs: 5 }),
    ).resolves.toBe('pending')
    expect(apply).not.toHaveBeenCalled()
  })

  it('检查网络失败时返回 failed', async () => {
    const registration = fakeRegistration()
    registration.update = vi.fn(async () => {
      throw new Error('offline')
    })
    const apply = vi.fn()

    await expect(checkForAppUpdate(registration, apply)).resolves.toBe('failed')
    expect(apply).not.toHaveBeenCalled()
  })
})