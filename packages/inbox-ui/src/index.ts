/**
 * What `<HermsInbox />` (React) and `<hermes-inbox>` (custom element) share.
 *
 * Private: this package is never published. The two published packages bundle it, so a consumer
 * installs neither a third package nor a second copy of the strings. Nothing here may touch the
 * DOM or depend on a framework; both would make it unusable by one of its two users.
 */
export { activateItem, type Activatable, type ActivateOptions } from './activate'
export { badgeText, relativeTime } from './format'
export { getHermsInboxStrings, type HermsInboxStrings } from './locale'
export { nextActiveIndex } from './navigation'
export { createSeenTracker, type SeenTracker } from './seen'
export { classNames, colorSchemeAttribute, splitPlacement, themeVariables } from './theme'
export type { HermsColorScheme, HermsInboxPlacement, HermsInboxTheme, HermsLocale } from './types'
