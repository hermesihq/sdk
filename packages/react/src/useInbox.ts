import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { InboxStore } from '@hermesihq/js'
import type { HermsInboxItem, HermsInboxReadStatus } from '@hermesihq/js'
import { useHermsContext } from './HermsProvider'

export interface UseInboxOptions {
  status?: HermsInboxReadStatus
  category?: string
}

export interface UseInboxResult {
  items: HermsInboxItem[]
  isLoading: boolean
  isLoadingMore: boolean
  error: Error | null
  hasMore: boolean
  loadMore: () => void
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  archive: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  refetch: () => void
}

/**
 * Headless, cursor-paginated inbox list state: thin wrappers around `HermsClient`'s own
 * methods that also patch local state, so a consumer never has to manually refetch the
 * whole list after every mutating action.
 *
 * Live-updated on `item.created`: the new item is prepended immediately from the
 * (deliberately minimal: `{id, title, created_at}`) SSE payload so the UI reacts
 * instantly, then reconciled against a fresh first page fetched in the background so the
 * authoritative row (body, category, action_url) lands without a full list
 * reload/flicker.
 *
 * All of that lives in `InboxStore`; this is the binding. The filter is handed to the
 * store rather than being part of what identifies it, so changing tabs reloads the list
 * in place, keeping the rows on screen, instead of discarding the store and blanking the
 * panel.
 */
export function useInbox(options: UseInboxOptions = {}): UseInboxResult {
  const host = useHermsContext()
  const { status, category } = options

  // Only the first render's filter is used to create the store. Later changes go through
  // `setFilter` below, so this memo is keyed on the host alone.
  const store = useMemo(() => new InboxStore(host, { status, category }), [host])

  useEffect(() => store.connect(), [store])
  // A no-op when the filter is the one the store already has, which is the case on the
  // first render: `connect()` above has just loaded it.
  useEffect(() => {
    store.setFilter({ status, category })
  }, [store, status, category])

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  return useMemo(
    () => ({
      ...state,
      // Arrow-function fields on the store: the same references for its whole life, so a
      // consumer's `useCallback`/`memo` dependencies do not churn as the state changes.
      loadMore: store.loadMore,
      markRead: store.markRead,
      markAllRead: store.markAllRead,
      archive: store.archive,
      remove: store.remove,
      refetch: store.refetch,
    }),
    [state, store],
  )
}
