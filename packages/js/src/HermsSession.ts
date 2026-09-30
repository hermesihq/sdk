import type { HermsClient } from './HermsClient'
import { notifyIsolated } from './store'
import type { HermsEventListener } from './types'

/**
 * What a store needs from its surroundings: a client to call, and a way to hear
 * real-time events. `HermsSession` implements it, and so does the value a React
 * `<HermsProvider>` puts in context, which is why the stores depend on this shape and
 * not on the class.
 */
export interface HermsStoreHost {
  client: HermsClient
  /** Registers `listener` against the one shared connection; returns the way out. */
  addEventListener: (listener: HermsEventListener) => () => void
}

/**
 * Owns the one real-time connection for a `HermsClient` and fans it out to every store
 * listening.
 *
 * This is the piece `<HermsProvider>` used to be, lifted out of React. The reason it
 * exists is unchanged: a bell, an open panel and a page-level counter are three
 * consumers of one person's inbox, and three `EventSource` connections would be three of
 * the browser's six per-origin sockets plus three server-side subscribers.
 *
 * **`connect()` is reference-counted.** The provider opened the connection in an effect
 * and closed it in that effect's cleanup, which React's Strict Mode runs as
 * connect, disconnect, connect on every mount. A count makes that sequence, and two
 * providers over one client, come out right without either knowing about the other: the
 * connection opens on the first `connect()` and closes only when the last release has
 * been called. Releasing the last one also calls `client.destroy()`, which clears the
 * pending `onTokenExpiring` timer that would otherwise call back into a page that has
 * gone.
 */
export class HermsSession implements HermsStoreHost {
  readonly client: HermsClient
  readonly #listeners = new Set<HermsEventListener>()
  #connections = 0
  #closeStream: (() => void) | null = null

  constructor(client: HermsClient) {
    this.client = client
  }

  addEventListener = (listener: HermsEventListener): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Opens the shared connection if this is the first caller. Returns a function that
   * releases this caller's claim; calling it twice releases once.
   */
  connect(): () => void {
    this.#connections += 1
    if (this.#connections === 1) {
      this.#closeStream = this.client.subscribe((event) => {
        // A copy that skips anyone removed since it was taken, for the reason
        // `StoreBase` does the same: a listener unregistered before it is reached is not
        // called. Isolated too: one store's bug must not stop the others hearing.
        for (const listener of [...this.#listeners]) {
          if (this.#listeners.has(listener)) notifyIsolated(() => listener(event))
        }
      })
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this.#connections -= 1
      if (this.#connections === 0) {
        this.#closeStream?.()
        this.#closeStream = null
        this.client.destroy()
      }
    }
  }
}
