import type { HermsStoreHost } from './HermsSession'
import { StoreBase } from './store'
import type { HermsInboxCounts } from './types'

export interface CountsState extends HermsInboxCounts {
  isLoading: boolean
}

/**
 * The unread badge: `{unread, unseen, isLoading}`, kept live.
 *
 * One `getCounts()` when connected, then replaced wholesale on every `counts.changed`
 * event, whether that arrives over the stream or from the client's own sixty-second
 * polling fallback. The store does not care which; that distinction lives in
 * `HermsClient.subscribe`.
 */
export class CountsStore extends StoreBase<CountsState> {
  readonly #host: HermsStoreHost

  constructor(host: HermsStoreHost) {
    super({ unread: 0, unseen: 0, isLoading: true })
    this.#host = host
  }

  /**
   * Starts fetching and listening. Returns the function that stops both. Safe to call
   * again after stopping, which is what a framework's development-mode double mount
   * does.
   */
  connect(): () => void {
    let cancelled = false
    this.setState({ isLoading: true })

    this.#host.client.getCounts().then(
      (fresh) => {
        if (!cancelled) this.setState({ unread: fresh.unread, unseen: fresh.unseen, isLoading: false })
      },
      () => {
        // Best-effort initial read: the badge stays at its last known value (0 on the
        // first connect) until a `counts.changed` event or a reconnect succeeds. A badge
        // that showed an error would be louder than the thing it is counting.
        if (!cancelled) this.setState({ isLoading: false })
      },
    )

    const stopListening = this.#host.addEventListener((event) => {
      if (event.type === 'counts.changed') {
        this.setState({ unread: event.data.unread, unseen: event.data.unseen })
      }
    })

    return () => {
      cancelled = true
      stopListening()
    }
  }
}
