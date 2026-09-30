import type { HermsStoreHost } from './HermsSession'
import { StoreBase } from './store'
import type { HermsInboxItem, HermsInboxReadStatus } from './types'

export interface InboxFilter {
  status?: HermsInboxReadStatus
  category?: string
}

export interface InboxState {
  items: HermsInboxItem[]
  isLoading: boolean
  isLoadingMore: boolean
  error: Error | null
  hasMore: boolean
}

/**
 * The cursor-paginated inbox list: the part of this package that holds state rather
 * than reflecting it, and the reason it lives here instead of in a React hook.
 *
 * The rule it keeps is that the SDK reflects server
 * decisions, it does not make them. So every mutation goes to the server first and
 * patches local state with what came back, and a failed mutation rejects instead of
 * being papered over. An optimistic-only update is a UI that disagrees with the inbox on
 * the next page load.
 *
 * **Generations.** Every request that can land after the world has moved on, whether a
 * first page, a further page, or a reconciliation, carries the generation it started
 * under, and is discarded if that has since changed. A generation moves when the list is
 * reloaded, when the filter changes, and when the store is disconnected. Without it, a
 * page-two response for the old filter arriving after the user switched tabs is
 * appended to the new tab's list: rows from one view rendered under another, and
 * nothing in the UI to say so. The React hook this replaces guarded the first page but
 * not the others.
 */
export class InboxStore extends StoreBase<InboxState> {
  readonly #host: HermsStoreHost
  #filter: InboxFilter
  #cursor: string | null = null
  #generation = 0
  #connected = false

  constructor(host: HermsStoreHost, filter: InboxFilter = {}) {
    // `isLoading` starts true so a skeleton renders on the first paint rather than an
    // empty state that flashes into a list.
    super({ items: [], isLoading: true, isLoadingMore: false, error: null, hasMore: false })
    this.#host = host
    this.#filter = { status: filter.status, category: filter.category }
  }

  /**
   * Loads the first page and starts applying live events. Returns the function that
   * stops both. Safe to call again afterwards, which reloads.
   */
  connect(): () => void {
    this.#connected = true
    const stopListening = this.#host.addEventListener((event) => {
      if (event.type !== 'item.created') return
      // The wire keeps this frame deliberately minimal (id, title, created_at), so the
      // row shown immediately is real but partial: no body, category or action url. It is
      // replaced by the authoritative row when the reconciliation below lands.
      const partial: HermsInboxItem = {
        id: event.data.id,
        title: event.data.title,
        body: '',
        actionUrl: null,
        category: null,
        seenAt: null,
        readAt: null,
        createdAt: event.data.created_at,
      }
      // Redelivery is normal on a reconnecting stream, and the reconciliation fetch can
      // race the frame that triggered it. Either would otherwise render one notification
      // twice, with duplicate keys.
      this.setState((previous) =>
        previous.items.some((item) => item.id === partial.id)
          ? {}
          : { items: [partial, ...previous.items] },
      )
      this.#reconcileFirstPage()
    })
    this.refetch()

    return () => {
      this.#connected = false
      // Anything still in flight belongs to a connection nobody is listening to.
      this.#generation += 1
      stopListening()
    }
  }

  /**
   * Change the filter and reload. A no-op when nothing differs, so a binding can call
   * this on every render without paying a request for it.
   *
   * The previous rows stay visible, with `isLoading: true`, until the new first page
   * arrives. That is what the hook did, and it is what a tab switcher wants: the panel
   * does not blank between tabs.
   */
  setFilter(filter: InboxFilter): void {
    if (filter.status === this.#filter.status && filter.category === this.#filter.category) return
    this.#filter = { status: filter.status, category: filter.category }
    if (this.#connected) this.refetch()
  }

  /** Reload the first page. What a Retry button calls. */
  refetch = (): void => {
    const generation = ++this.#generation
    // Any further-page request in flight is now for a list that is being replaced.
    this.setState({ isLoading: true, isLoadingMore: false, error: null })

    // Each outcome is ONE state change that also clears `isLoading`. Setting the result
    // and clearing the flag in two steps (a `.finally`) leaves a moment where the store
    // says "loading" and "failed", or "loading" and "here are your rows", to a
    // subscriber that renders synchronously. A snapshot must never be a state the
    // server did not put us in.
    this.#host.client.listInbox(this.#filter).then(
      (page) => {
        if (generation !== this.#generation) return
        this.#cursor = page.nextCursor
        this.setState({ items: page.items, hasMore: page.hasMore, isLoading: false })
      },
      (error: unknown) => {
        if (generation !== this.#generation) return
        this.setState({
          error: error instanceof Error ? error : new Error('Failed to load inbox.'),
          isLoading: false,
        })
      },
    )
  }

  loadMore = (): void => {
    const { isLoadingMore, hasMore } = this.state
    // A consumer wires this to a scroll handler, where a cursor-less request would
    // re-fetch page one and duplicate every row. Hence the guards, not a convenience.
    if (isLoadingMore || !hasMore || this.#cursor === null) return

    const generation = this.#generation
    this.setState({ isLoadingMore: true })

    this.#host.client.listInbox({ ...this.#filter, cursor: this.#cursor }).then(
      (page) => {
        if (generation !== this.#generation) return
        this.#cursor = page.nextCursor
        this.setState((previous) => ({
          items: [...previous.items, ...page.items],
          hasMore: page.hasMore,
          isLoadingMore: false,
        }))
      },
      (error: unknown) => {
        if (generation !== this.#generation) return
        this.setState({
          error: error instanceof Error ? error : new Error('Failed to load more of the inbox.'),
          isLoadingMore: false,
        })
      },
    )
  }

  // Replaces any row whose id is in a fresh first page with its authoritative version
  // and folds in any brand-new rows that arrived out of order, without disturbing rows
  // loaded from later pages, which the first page never touches.
  #reconcileFirstPage(): void {
    const generation = this.#generation
    this.#host.client
      .listInbox(this.#filter)
      .then((page) => {
        // Skipped, not deferred: a reload that superseded this brings the authoritative
        // rows itself.
        if (generation !== this.#generation) return
        this.setState((previous) => {
          const freshById = new Map(page.items.map((item) => [item.id, item]))
          const merged = previous.items.map((item) => freshById.get(item.id) ?? item)
          const knownIds = new Set(merged.map((item) => item.id))
          const additions = page.items.filter((item) => !knownIds.has(item.id))
          return { items: [...additions, ...merged] }
        })
      })
      .catch(() => {
        // Best-effort: the partial row, or the next `item.created` or a manual refetch,
        // is the fallback.
      })
  }

  markRead = async (id: string): Promise<void> => {
    const updated = await this.#host.client.markRead(id)
    this.setState((previous) => ({
      items: previous.items.map((item) => (item.id === id ? updated : item)),
    }))
  }

  markAllRead = async (): Promise<void> => {
    await this.#host.client.markAllRead()
    const now = new Date().toISOString()
    // Only rows that were unread are stamped: this is "mark the unread ones read", not
    // "restamp everything", and the timestamp is displayed.
    this.setState((previous) => ({
      items: previous.items.map((item) => (item.readAt ? item : { ...item, readAt: now })),
    }))
  }

  archive = async (id: string): Promise<void> => {
    await this.#host.client.archive(id)
    // An exit from the default feed, not a flag shown within it: leaving the row
    // visible would make the button look broken until a reload.
    this.setState((previous) => ({ items: previous.items.filter((item) => item.id !== id) }))
  }

  remove = async (id: string): Promise<void> => {
    await this.#host.client.delete(id)
    this.setState((previous) => ({ items: previous.items.filter((item) => item.id !== id) }))
  }
}
