/**
 * "Seen" (the bell was opened) is distinct from "read". Hand this the items on screen and it
 * returns the ids not yet reported, once each: showing a notification marks it seen, and doing
 * it twice is a wasted request, or a count that flickers.
 */
export interface SeenTracker {
  /** Ids in `items` that no earlier call returned. */
  take(items: ReadonlyArray<{ id: string }>): string[]
}

export function createSeenTracker(): SeenTracker {
  const reported = new Set<string>()
  return {
    take(items) {
      const fresh = items.filter((item) => !reported.has(item.id)).map((item) => item.id)
      for (const id of fresh) reported.add(id)
      return fresh
    },
  }
}
