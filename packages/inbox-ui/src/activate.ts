/** The part of a notification that activating it looks at. */
export interface Activatable {
  id: string
  readAt: string | null
  actionUrl: string | null
}

export interface ActivateOptions<T extends Activatable> {
  markRead: (id: string) => unknown
  /** The host's own router. When given, it replaces the hard navigation. */
  onItemClick?: (item: T) => void
  /** The hard navigation, only for an item with somewhere to go and no `onItemClick`. */
  navigate: (url: string) => void
}

/**
 * What clicking a notification (or Enter on it) does. The item is marked read first, whichever
 * way it goes on, and only if it is not already.
 */
export function activateItem<T extends Activatable>(item: T, options: ActivateOptions<T>): void {
  if (!item.readAt) void options.markRead(item.id)
  if (options.onItemClick) {
    options.onItemClick(item)
  } else if (item.actionUrl) {
    options.navigate(item.actionUrl)
  }
}
