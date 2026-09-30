/**
 * `@hermesihq/js`: Hermesi's in-app inbox for any page, with no framework required.
 *
 * Three layers, all exported from this one entry point:
 *
 * - **`HermsClient`**: the API client. Reads and writes a subscriber's inbox and
 *   preferences, and opens the real-time stream.
 * - **`HermsSession`**: owns the one real-time connection for a client and shares it
 *   between everything listening, so a badge, a panel and a preferences page cost one
 *   connection between them, not three.
 * - **`InboxStore`, `CountsStore`, `PreferencesStore`**: the state a UI renders, held
 *   once. Each exposes `getSnapshot()` and `subscribe(listener)`, which is the pair
 *   React's `useSyncExternalStore` takes and the one a Vue ref, an Angular signal or a
 *   plain `addEventListener`-style page each bridge in a few lines.
 *
 * The stores are deliberately not tied to any rendering library, and a binding for one
 * is a few lines that forward changes into its own reactivity. `@hermesihq/react` is
 * exactly that, over this package.
 */
export { HermsClient } from './HermsClient'
export { decodeSubscriberTokenExp } from './subscriberToken'
export { HERMS_CHANNELS } from './types'
export {
  HermsApiError,
  type HermsCategoryPreference,
  type HermsChannel,
  type HermsChannelPreference,
  type HermsClientOptions,
  type HermsErrorDetail,
  type HermsEventListener,
  type HermsInboxCategory,
  type HermsInboxCounts,
  type HermsInboxItem,
  type HermsInboxListParams,
  type HermsInboxPage,
  type HermsInboxReadStatus,
  type HermsPreferences,
  type HermsPreferenceUpdate,
  type HermsRealtimeEvent,
  type HermsRegisterChannelParams,
} from './types'

export { HermsSession, type HermsStoreHost } from './HermsSession'
export { InboxStore, type InboxFilter, type InboxState } from './InboxStore'
export { CountsStore, type CountsState } from './CountsStore'
export { PreferencesStore, type PreferencesState } from './PreferencesStore'
export type { ReadableStore, StoreListener } from './store'
