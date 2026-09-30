/**
 * The observable every store in this package is built on, and the contract every
 * framework binding consumes.
 *
 * `getSnapshot()` and `subscribe(listener)` are exactly the pair React's
 * `useSyncExternalStore` takes, and they are also what Vue's `shallowRef`, Angular's
 * `signal` bridge, Svelte's store contract and a bare `addEventListener`-style vanilla
 * page each need. That is the whole reason the state lives here rather than in hooks:
 * it is written once, and a binding is a few lines that forward changes into its own
 * reactivity system.
 *
 * **A snapshot is immutable, and its identity changes exactly when its content does.**
 * `useSyncExternalStore` compares snapshots with `Object.is`, so a store that mutated in
 * place would never re-render, and one that returned a fresh object on every read would
 * re-render forever. `setState` therefore replaces the object, and only when a field
 * actually differs: an update that changes nothing notifies nobody, which is also what
 * React's own `setState` does with an identical value.
 */

export type StoreListener = () => void

export interface ReadableStore<T> {
  /** The current state. Same reference until something in it changes. */
  getSnapshot: () => T
  /** Calls `listener` after every change; returns the function that stops it. */
  subscribe: (listener: StoreListener) => () => void
}

export class StoreBase<T extends object> implements ReadableStore<T> {
  #state: T
  readonly #listeners = new Set<StoreListener>()

  constructor(initial: T) {
    this.#state = initial
  }

  // Arrow-function fields, not methods: bindings hand these to a framework as bare
  // function references (`useSyncExternalStore(store.subscribe, store.getSnapshot)`),
  // and a method detached from its instance loses `this`.
  getSnapshot = (): T => this.#state

  subscribe = (listener: StoreListener): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  protected get state(): T {
    return this.#state
  }

  /**
   * Merge `patch` into the state, or compute it from the previous state. Notifies only
   * if at least one field changed by `Object.is`.
   */
  protected setState(patch: Partial<T> | ((previous: T) => Partial<T>)): void {
    const resolved = typeof patch === 'function' ? patch(this.#state) : patch
    let changed = false
    for (const key of Object.keys(resolved) as Array<keyof T>) {
      if (!Object.is(this.#state[key], resolved[key])) {
        changed = true
        break
      }
    }
    if (!changed) return

    this.#state = { ...this.#state, ...resolved }
    // Iterate a copy, so a listener added during this notification waits for the next
    // one, and skip any that has been removed since the copy was taken. That is
    // `EventTarget`'s rule: a listener unsubscribed before it is reached is not called.
    // A bare copy would call it anyway, and a component that has already unmounted would
    // receive an update it asked not to get.
    for (const listener of [...this.#listeners]) {
      if (this.#listeners.has(listener)) notifyIsolated(listener)
    }
  }
}

/**
 * Run one listener so that its failure is neither swallowed nor contagious.
 *
 * Listeners are the host application's code, arbitrary and sometimes wrong. If one
 * throws inside the notify loop, every listener after it is skipped and the exception
 * surfaces inside whichever request happened to be settling, where the store's own
 * promise handling would report it as if *loading* had failed. So each is isolated, and
 * the error is re-raised on a fresh microtask: it still reaches the host's error
 * reporting (`window.onerror`, an uncaught-exception hook) exactly as an event handler's
 * would, but it cannot break the store or the subscribers beside it.
 */
export function notifyIsolated(listener: () => void): void {
  try {
    listener()
  } catch (error) {
    queueMicrotask(() => {
      throw error
    })
  }
}
