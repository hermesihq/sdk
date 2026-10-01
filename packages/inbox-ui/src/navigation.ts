/**
 * Where focus goes when a key is pressed in the list, or `null` if the key is none of the list's.
 * A `null` is the caller's cue to leave the event alone: swallowing a key this does not handle
 * would break Tab.
 */
export function nextActiveIndex(key: string, active: number, length: number): number | null {
  if (length === 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(active + 1, length - 1)
    case 'ArrowUp':
      return Math.max(active - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return length - 1
    default:
      return null
  }
}
