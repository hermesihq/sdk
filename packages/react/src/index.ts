/**
 * `@hermesihq/react`: React bindings for Hermesi's in-app inbox.
 *
 * Two parts, from the one entry point:
 *
 * - **The client surface**, re-exported from `@hermesihq/js` so that
 *   `import { HermsClient } from '@hermesihq/react'` keeps working. It is exactly the
 *   names this package has always exported from there and no more: the stores and the
 *   session are `@hermesihq/js`'s to export, and a React host has the hooks.
 * - **`HermsProvider`, `useUnreadCount`, `useInbox`, `usePreferences` and
 *   `<HermsInbox />`.** The hooks are a thin binding over `@hermesihq/js`'s stores; the
 *   component is a ready bell and panel built on them.
 */
export { HermsClient, HermsApiError, HERMS_CHANNELS, decodeSubscriberTokenExp } from '@hermesihq/js'
export type {
  HermsCategoryPreference,
  HermsChannel,
  HermsChannelPreference,
  HermsClientOptions,
  HermsErrorDetail,
  HermsEventListener,
  HermsInboxCategory,
  HermsInboxCounts,
  HermsInboxItem,
  HermsInboxListParams,
  HermsInboxPage,
  HermsInboxReadStatus,
  HermsPreferences,
  HermsPreferenceUpdate,
  HermsRealtimeEvent,
  HermsRegisterChannelParams,
} from '@hermesihq/js'

export { HermsProvider, useHermsContext, type HermsProviderProps } from './HermsProvider'
export { useUnreadCount, type UseUnreadCountResult } from './useUnreadCount'
export { useInbox, type UseInboxOptions, type UseInboxResult } from './useInbox'
export { usePreferences, type UsePreferencesResult } from './usePreferences'
export { HermsInbox, type HermsInboxProps, type HermsInboxPlacement, type HermsInboxTheme } from './HermsInbox'
export type { HermsLocale } from '@hermesihq/inbox-ui'
