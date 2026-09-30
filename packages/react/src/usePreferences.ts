import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { PreferencesStore } from '@hermesihq/js'
import type { HermsPreferences, HermsPreferenceUpdate } from '@hermesihq/js'
import { useHermsContext } from './HermsProvider'

export interface UsePreferencesResult {
  /** `null` until the first read resolves. */
  preferences: HermsPreferences | null
  isLoading: boolean
  /** The failure of the last read or write, or `null`. Kept rather than thrown so a
   *  preference centre can show it beside the controls instead of unmounting them. */
  error: Error | null
  /** Change one setting. Resolves once the server's new state has been applied. */
  setPreference: (update: HermsPreferenceUpdate) => Promise<void>
  /** Re-read, for a retry button. */
  reload: () => Promise<void>
}

/**
 * Headless preferences, the counterpart to `useInbox`.
 *
 * **No optimistic update, deliberately.** A toggle here is not a like button: turning
 * off a channel is a consent decision, and showing it as done before the server agreed is
 * showing somebody they have opted out when they may not have. The server answers `PATCH`
 * with the *whole* updated state, so the correct view arrives with the write and there is
 * nothing to reconcile. A per-row pending state in the host is a better answer to the
 * latency than a lie.
 *
 * **`error` is state, not an exception.** `setPreference` still rejects, so a caller can
 * `await` it and react per-control, but the hook also holds the failure so a preference
 * centre can render it without every consumer writing the same try/catch. A failed write
 * leaves the last known-good state on screen rather than an empty page.
 *
 * Critical categories arrive with `isCritical: true` and are always delivered. Render
 * them (a subscriber should see what they are receiving), but not as a control: an
 * affordance that refuses is worse than none.
 *
 * A binding over `PreferencesStore`, which holds the behaviour above.
 */
export function usePreferences(): UsePreferencesResult {
  const host = useHermsContext()
  const store = useMemo(() => new PreferencesStore(host), [host])

  useEffect(() => store.connect(), [store])

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  return useMemo(
    () => ({ ...state, setPreference: store.setPreference, reload: store.reload }),
    [state, store],
  )
}
