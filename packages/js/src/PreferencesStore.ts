import type { HermsStoreHost } from './HermsSession'
import { StoreBase } from './store'
import type { HermsPreferences, HermsPreferenceUpdate } from './types'

export interface PreferencesState {
  /** `null` until the first read resolves. */
  preferences: HermsPreferences | null
  isLoading: boolean
  /** The failure of the last read or write, or `null`. Held rather than thrown so a
   *  preference centre can show it beside the controls instead of unmounting them. */
  error: Error | null
}

/**
 * Headless preferences.
 *
 * **No optimistic update, deliberately.** A toggle here is not a like button: turning
 * off a channel is a consent decision, and showing it as done before the server agreed
 * shows somebody they have opted out when they may not have. The server answers `PATCH`
 * with the whole updated state, so the correct view arrives with the write and there is
 * nothing to reconcile. A per-row pending state in the host is a better answer to the
 * latency than a lie.
 *
 * **`error` is state, not an exception.** `setPreference` still rejects, so a caller can
 * `await` it and react per control, but the store also holds the failure so a preference
 * centre can render it without every consumer writing the same try/catch. A failed write
 * leaves the last known-good state in place rather than an empty page.
 *
 * Critical categories arrive with `isCritical: true` and are always delivered. Render
 * them, since a subscriber should see what they receive, but not as a control: an
 * affordance that refuses is worse than none.
 */
export class PreferencesStore extends StoreBase<PreferencesState> {
  readonly #host: HermsStoreHost
  #generation = 0

  constructor(host: HermsStoreHost) {
    super({ preferences: null, isLoading: true, error: null })
    this.#host = host
  }

  /** Reads the settings, and returns the function that discards a read still in flight. */
  connect(): () => void {
    void this.reload()
    return () => {
      this.#generation += 1
    }
  }

  /**
   * Re-read. What a retry button calls. Resolves once the read has settled, whether it
   * worked or not: a failure is held in `error`, never thrown from here, so awaiting this
   * is safe without a `catch`.
   */
  reload = (): Promise<void> => {
    const generation = ++this.#generation
    this.setState({ isLoading: true })

    // One state change per outcome, clearing `isLoading` with it, so no subscriber ever
    // sees "loading" alongside a result. See `InboxStore.refetch`.
    return this.#host.client.getPreferences().then(
      (fresh) => {
        // Guarded like every other late arrival: a disconnect or a newer read mid-flight
        // must not write the old one's result, or its failure, into the new state.
        if (generation !== this.#generation) return
        this.setState({ preferences: fresh, error: null, isLoading: false })
      },
      (caught: unknown) => {
        if (generation !== this.#generation) return
        this.setState({ error: toError(caught), isLoading: false })
      },
    )
  }

  /** Change one setting. Resolves once the server's new state has been applied. */
  setPreference = async (update: HermsPreferenceUpdate): Promise<void> => {
    try {
      // The response is the whole new state, so this replaces rather than patches.
      const fresh = await this.#host.client.updatePreference(update)
      this.setState({ preferences: fresh, error: null })
    } catch (caught) {
      this.setState({ error: toError(caught) })
      // Rethrown as well as held: a host that awaits this needs to know its one toggle
      // failed, and a host that does not still gets `error` for the page.
      throw caught
    }
  }
}

function toError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught))
}
