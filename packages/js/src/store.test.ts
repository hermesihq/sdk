// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { StoreBase } from './store'

/**
 * The observable under every store. Small, and it is the piece a framework binding
 * actually touches, so what it promises about identity and notification is the contract
 * `useSyncExternalStore`, a Vue ref and a bare `subscribe` all depend on.
 */

interface State {
  n: number
  label: string
}

class Probe extends StoreBase<State> {
  constructor() {
    super({ n: 0, label: 'a' })
  }
  set(patch: Partial<State>): void {
    this.setState(patch)
  }
  compute(fn: (previous: State) => Partial<State>): void {
    this.setState(fn)
  }
}

describe('snapshots', () => {
  it('keeps the same object until something changes', () => {
    const store = new Probe()
    const first = store.getSnapshot()

    // `useSyncExternalStore` compares with `Object.is`. A snapshot that changed identity
    // on every read would re-render forever; one that was mutated in place would never
    // re-render at all.
    expect(store.getSnapshot()).toBe(first)
    store.set({ n: 1 })
    expect(store.getSnapshot()).not.toBe(first)
    expect(first.n).toBe(0)
  })

  it('does not notify, or replace the snapshot, for an update that changes nothing', () => {
    const store = new Probe()
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSnapshot()

    store.set({ n: 0, label: 'a' })
    store.compute(() => ({}))

    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(before)
  })

  it('notifies once per change, and after the new state is readable', () => {
    const store = new Probe()
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getSnapshot().n))

    store.set({ n: 1 })
    store.set({ n: 2 })

    expect(seen).toEqual([1, 2])
  })

  it('computes an update from the state it is about to replace', () => {
    const store = new Probe()
    store.set({ n: 5 })

    store.compute((previous) => ({ n: previous.n + 1 }))

    expect(store.getSnapshot().n).toBe(6)
  })
})

describe('subscribing', () => {
  it('stops delivering to a listener that has unsubscribed', () => {
    const store = new Probe()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    unsubscribe()
    store.set({ n: 1 })

    expect(listener).not.toHaveBeenCalled()
  })

  it('can be passed around as bare functions', () => {
    const store = new Probe()
    // Bindings hand these to a framework as detached references.
    const { subscribe, getSnapshot } = store
    const listener = vi.fn()

    subscribe(listener)
    store.set({ n: 1 })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getSnapshot().n).toBe(1)
  })

  it('still reaches the others when a listener unsubscribes itself mid-notification', () => {
    const store = new Probe()
    const calls: string[] = []
    const stopFirst = store.subscribe(() => {
      calls.push('first')
      stopFirst()
    })
    store.subscribe(() => calls.push('second'))

    store.set({ n: 1 })
    store.set({ n: 2 })

    expect(calls).toEqual(['first', 'second', 'second'])
  })

  it('does not call a listener that an earlier one unsubscribed', () => {
    const store = new Probe()
    const calls: string[] = []
    let stopSecond: () => void = () => {}
    store.subscribe(() => {
      calls.push('first')
      stopSecond()
    })
    stopSecond = store.subscribe(() => calls.push('second'))

    store.set({ n: 1 })

    // `EventTarget`'s rule. A component that unmounts in response to an update has
    // already asked not to hear the next one; delivering it anyway is an update to
    // something that no longer exists.
    expect(calls).toEqual(['first'])
  })

  it('leaves a listener added during a notification for the next one', () => {
    const store = new Probe()
    const calls: string[] = []
    let added = false
    store.subscribe(() => {
      calls.push('first')
      if (!added) {
        added = true
        store.subscribe(() => calls.push('late'))
      }
    })

    store.set({ n: 1 })
    expect(calls).toEqual(['first'])

    store.set({ n: 2 })
    expect(calls).toEqual(['first', 'first', 'late'])
  })
})

describe('a listener that throws', () => {
  it('does not stop the listeners after it, or break the state change', () => {
    const queued: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (callback: () => void) => queued.push(callback))
    const store = new Probe()
    const after = vi.fn()
    store.subscribe(() => {
      throw new Error('host bug')
    })
    store.subscribe(after)

    expect(() => store.set({ n: 1 })).not.toThrow()

    // The host's bug is theirs to see, but it must not cost the subscribers beside it
    // their update, and the state has changed regardless.
    expect(after).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().n).toBe(1)
    expect(queued).toHaveLength(1)
  })

  it('re-raises the failure so the host still sees it', () => {
    const queued: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (callback: () => void) => queued.push(callback))
    const store = new Probe()
    store.subscribe(() => {
      throw new Error('host bug')
    })

    store.set({ n: 1 })

    // Reported, not swallowed: on a page this is what reaches `window.onerror`, exactly
    // as a throwing event handler would.
    expect(() => queued[0]?.()).toThrow('host bug')
  })
})
