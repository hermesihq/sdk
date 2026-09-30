import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { CountsStore, type CountsState } from '@hermesihq/js'
import { useHermsContext } from './HermsProvider'

export type UseUnreadCountResult = CountsState

/**
 * Headless. `{unread, unseen, isLoading}`, kept live via the provider's shared
 * subscription: one `getCounts()` call on mount, then recomputed on every
 * `counts.changed` event (real-time push, or the client's own 60s polling fallback) for
 * as long as this component stays mounted.
 *
 * A binding over `CountsStore`, which holds all of that. The store's constructor does
 * nothing, so React discarding a memoised one costs nothing: it is the `connect()` in the
 * effect that starts work.
 */
export function useUnreadCount(): UseUnreadCountResult {
  const host = useHermsContext()
  const store = useMemo(() => new CountsStore(host), [host])

  useEffect(() => store.connect(), [store])

  // The initial state is also the server snapshot: nothing connects during a server
  // render, so this is exactly what the server would produce.
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
