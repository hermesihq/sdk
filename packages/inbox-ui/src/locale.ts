/**
 * `<HermsInbox />`'s own tiny, self-contained EN/FR string table.
 *
 * Deliberately **not** i18next: this package ships to arbitrary host apps
 * (with zero hard dependency on the host app's state library) that may run
 * their own i18n stack, a different one, or none at all. Pulling i18next in
 * as a real dependency here would be exactly the kind of host-app-shaped
 * assumption the SDK is supposed to avoid, for a handful of short strings.
 * `locale` is a prop of `<HermsInbox />`.
 */

import type { HermsLocale } from './types'

export interface HermsInboxStrings {
  bellLabel: string
  bellLabelWithUnread: (count: number) => string
  panelTitle: string
  markAllRead: string
  close: string
  loading: string
  empty: string
  errorTitle: string
  retry: string
  loadMore: string
  loadingMore: string
  archive: string
  unreadDot: string
}

const en: HermsInboxStrings = {
  bellLabel: 'Notifications',
  bellLabelWithUnread: (count) => `Notifications, ${count} unread`,
  panelTitle: 'Notifications',
  markAllRead: 'Mark all as read',
  close: 'Close',
  loading: 'Loading notifications…',
  empty: "You're all caught up",
  errorTitle: "Couldn't load notifications.",
  retry: 'Retry',
  loadMore: 'Load more',
  loadingMore: 'Loading…',
  archive: 'Archive',
  unreadDot: 'Unread',
}

const fr: HermsInboxStrings = {
  bellLabel: 'Notifications',
  bellLabelWithUnread: (count) => `Notifications, ${count} non lues`,
  panelTitle: 'Notifications',
  markAllRead: 'Tout marquer comme lu',
  close: 'Fermer',
  loading: 'Chargement des notifications…',
  empty: 'Vous êtes à jour',
  errorTitle: "Impossible de charger les notifications.",
  retry: 'Réessayer',
  loadMore: 'Charger plus',
  loadingMore: 'Chargement…',
  archive: 'Archiver',
  unreadDot: 'Non lu',
}

const dictionaries: Record<HermsLocale, HermsInboxStrings> = { en, fr }

export function getHermsInboxStrings(locale: HermsLocale | undefined): HermsInboxStrings {
  return dictionaries[locale ?? 'en'] ?? en
}
