import { describe, expect, it, vi } from 'vitest'
import { activateItem, badgeText, classNames, colorSchemeAttribute, createSeenTracker, nextActiveIndex, relativeTime, splitPlacement, themeVariables } from './index'

/**
 * The logic `<HermsInbox />` used to carry inline, now shared with the custom element. The React
 * suite still exercises all of it through the component; these cases pin each rule where it can
 * be seen on its own, which is what the element will lean on.
 */

describe('relativeTime', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('rounds to the largest unit that fits', () => {
    expect(relativeTime(ago(30_000), 'en', now)).toBe('this minute')
    expect(relativeTime(ago(5 * 60_000), 'en', now)).toBe('5 minutes ago')
    expect(relativeTime(ago(3 * 3_600_000), 'en', now)).toBe('3 hours ago')
    expect(relativeTime(ago(2 * 86_400_000), 'en', now)).toBe('2 days ago')
  })

  it('switches unit at the boundaries, not a unit late', () => {
    expect(relativeTime(ago(59_000), 'en', now)).toBe('this minute')
    expect(relativeTime(ago(60_000), 'en', now)).toBe('1 minute ago')
    expect(relativeTime(ago(59 * 60_000), 'en', now)).toBe('59 minutes ago')
    expect(relativeTime(ago(60 * 60_000), 'en', now)).toBe('1 hour ago')
    expect(relativeTime(ago(23 * 3_600_000), 'en', now)).toBe('23 hours ago')
    expect(relativeTime(ago(24 * 3_600_000), 'en', now)).toBe('yesterday')
  })

  it('speaks the locale it is given', () => {
    expect(relativeTime(ago(5 * 60_000), 'fr', now)).toBe('il y a 5 minutes')
  })

  it('does not show a notification from the future as being in the future', () => {
    // A clock a few seconds behind the server's is common, and "in 3 minutes" on something that
    // has already happened reads as a bug.
    expect(relativeTime(new Date(now + 180_000).toISOString(), 'en', now)).toBe('this minute')
  })

  it('returns nothing for a date it cannot read, instead of "NaN"', () => {
    expect(relativeTime('not a date', 'en', now)).toBe('')
  })
})

describe('badgeText', () => {
  it('counts up to 99 and then stops', () => {
    expect(badgeText(1)).toBe('1')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(4000)).toBe('99+')
  })
})

describe('nextActiveIndex', () => {
  it('moves one row at a time and stops at the ends', () => {
    expect(nextActiveIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextActiveIndex('ArrowDown', 2, 3)).toBe(2)
    expect(nextActiveIndex('ArrowUp', 2, 3)).toBe(1)
    expect(nextActiveIndex('ArrowUp', 0, 3)).toBe(0)
  })

  it('jumps to the ends with Home and End', () => {
    expect(nextActiveIndex('Home', 2, 5)).toBe(0)
    expect(nextActiveIndex('End', 0, 5)).toBe(4)
  })

  it('leaves every other key alone, so that Tab still works', () => {
    expect(nextActiveIndex('Tab', 1, 3)).toBeNull()
    expect(nextActiveIndex('a', 1, 3)).toBeNull()
    expect(nextActiveIndex('Enter', 1, 3)).toBeNull()
  })

  it('has nowhere to go in an empty list', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(nextActiveIndex(key, 0, 0)).toBeNull()
  })
})

describe('createSeenTracker', () => {
  it('reports each id once', () => {
    const tracker = createSeenTracker()
    expect(tracker.take([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
    expect(tracker.take([{ id: 'a' }, { id: 'b' }])).toEqual([])
  })

  it('reports only what is new when the list grows', () => {
    const tracker = createSeenTracker()
    tracker.take([{ id: 'a' }])
    expect(tracker.take([{ id: 'c' }, { id: 'a' }, { id: 'd' }])).toEqual(['c', 'd'])
  })

  it('does not share what it has reported between two trackers', () => {
    const one = createSeenTracker()
    const other = createSeenTracker()
    one.take([{ id: 'a' }])
    expect(other.take([{ id: 'a' }])).toEqual(['a'])
  })
})

describe('activateItem', () => {
  const unread = { id: 'n1', readAt: null, actionUrl: '/orders/1' }
  const read = { ...unread, readAt: '2026-09-01T10:00:00Z' }

  function options() {
    return { markRead: vi.fn(), onItemClick: vi.fn(), navigate: vi.fn() }
  }

  it('marks an unread item read, and only an unread one', () => {
    const a = options()
    activateItem(unread, a)
    expect(a.markRead).toHaveBeenCalledWith('n1')

    const b = options()
    activateItem(read, b)
    expect(b.markRead).not.toHaveBeenCalled()
  })

  it('hands the item to the host router, and does not navigate behind its back', () => {
    const o = options()
    activateItem(unread, o)
    expect(o.onItemClick).toHaveBeenCalledWith(unread)
    expect(o.navigate).not.toHaveBeenCalled()
  })

  it('navigates to the action URL when the host gave no router', () => {
    const { onItemClick: _unused, ...o } = options()
    activateItem(unread, o)
    expect(o.navigate).toHaveBeenCalledWith('/orders/1')
  })

  it('goes nowhere for an item with no action URL', () => {
    const { onItemClick: _unused, ...o } = options()
    activateItem({ ...unread, actionUrl: null }, o)
    expect(o.navigate).not.toHaveBeenCalled()
    expect(o.markRead).toHaveBeenCalled()
  })

  it('marks read before it hands over, so a router that unmounts the inbox cannot skip it', () => {
    const order: string[] = []
    activateItem(unread, {
      markRead: () => order.push('markRead'),
      onItemClick: () => order.push('onItemClick'),
      navigate: () => order.push('navigate'),
    })
    expect(order).toEqual(['markRead', 'onItemClick'])
  })
})

describe('theming', () => {
  it('turns the theme into the custom properties the stylesheet reads', () => {
    expect(themeVariables({ accent: '#0a7', radius: '4px' })).toEqual({ '--herms-color-accent': '#0a7', '--herms-radius': '4px' })
  })

  it('leaves out what was not set, so the stylesheet default wins', () => {
    // `toStrictEqual`: a key holding `undefined` is not "left out", and `toEqual` cannot tell.
    expect(themeVariables({ accent: '#0a7' })).toStrictEqual({ '--herms-color-accent': '#0a7' })
    expect(themeVariables({ radius: '4px' })).toStrictEqual({ '--herms-radius': '4px' })
    expect(themeVariables({ accent: '' })).toStrictEqual({})
    expect(themeVariables(undefined)).toStrictEqual({})
  })

  it('writes no attribute for "auto", so the system preference decides', () => {
    expect(colorSchemeAttribute('auto')).toBeUndefined()
    expect(colorSchemeAttribute('dark')).toBe('dark')
    expect(colorSchemeAttribute('light')).toBe('light')
  })

  it('splits every placement into a side and an alignment', () => {
    expect(splitPlacement('bottom-end')).toEqual({ side: 'bottom', align: 'end' })
    expect(splitPlacement('bottom-start')).toEqual({ side: 'bottom', align: 'start' })
    expect(splitPlacement('top-end')).toEqual({ side: 'top', align: 'end' })
    expect(splitPlacement('top-start')).toEqual({ side: 'top', align: 'start' })
  })

  it('joins class names without empty ones', () => {
    expect(classNames('a', undefined, 'b', false, '')).toBe('a b')
    expect(classNames(undefined)).toBe('')
  })
})
