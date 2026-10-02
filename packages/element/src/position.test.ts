import { describe, expect, it } from 'vitest'
import { computePosition, type PositionInput } from './position'

/**
 * Where the panel goes, as arithmetic. The layout engine is not available to the unit tests, and
 * does not need to be: a position is a function of boxes. Whether the panel really ends up there
 * on screen is the end-to-end suite's.
 */

const viewport = { width: 1000, height: 800 }
const panel = { width: 380, height: 300 }
/** A 36px bell with its right edge at 900 and its top at 100. */
const bell = { left: 864, right: 900, top: 100, bottom: 136 }

function place(overrides: Partial<PositionInput> = {}) {
  return computePosition({ anchor: bell, panel, viewport, placement: 'bottom-end', rtl: false, ...overrides })
}

describe('computePosition', () => {
  it('puts the panel under the bell with the end edges lined up', () => {
    // 8px below the bell; the panel's right edge on the bell's right edge (900 - 380).
    expect(place()).toEqual({ left: 520, top: 144, side: 'bottom' })
  })

  it('lines the start edges up for -start', () => {
    expect(place({ placement: 'bottom-start', anchor: { ...bell, left: 500, right: 536 } })).toMatchObject({ left: 500, top: 144 })
  })

  it('puts the panel above the bell for top-*', () => {
    // Its bottom edge 8px above the bell's top.
    expect(place({ placement: 'top-end', anchor: { ...bell, top: 500, bottom: 536 } })).toEqual({ left: 520, top: 192, side: 'top' })
  })

  it('flips to the other side when there is no room on the one asked for and more on the other', () => {
    const low = { ...bell, top: 700, bottom: 736 }
    // Under: 800 - 736 - 16 = 48px. Over: 700 - 16 = 684px. A 300px panel goes over.
    expect(place({ anchor: low })).toMatchObject({ side: 'top', top: 392 })
  })

  it('does not flip when the other side is no better', () => {
    const middle = { ...bell, top: 50, bottom: 86 }
    // Short viewport: 100px under, 26 over. Staying under, clamped, beats flipping to less room.
    const result = place({ anchor: middle, viewport: { width: 1000, height: 200 } })
    expect(result.side).toBe('bottom')
  })

  it('does not flip when it fits where it was asked to go', () => {
    expect(place({ placement: 'top-end', anchor: { ...bell, top: 500, bottom: 536 } }).side).toBe('top')
    expect(place().side).toBe('bottom')
  })

  it('keeps the panel inside the viewport at the edges', () => {
    // A bell near the left edge, asking for -end: the panel would start at 20 - 380 < 0.
    expect(place({ anchor: { ...bell, left: 4, right: 40 } }).left).toBe(8)
    // A bell near the right edge, asking for -start: the panel would run off the right.
    expect(place({ placement: 'bottom-start', anchor: { ...bell, left: 980, right: 1000 } }).left).toBe(1000 - 8 - 380)
  })

  it('starts at the margin when the panel is larger than the viewport', () => {
    const result = place({ panel: { width: 380, height: 900 }, viewport: { width: 300, height: 800 } })
    expect(result).toMatchObject({ left: 8, top: 8 })
  })

  it('mirrors start and end in a right-to-left page', () => {
    const middle = { ...bell, left: 500, right: 536 }
    // In left-to-right, -end lines the panel's right edge up with the bell's (536 - 380).
    expect(place({ anchor: middle })).toMatchObject({ left: 156 })
    // End of a line is on the left in RTL: -end lines up with the bell's LEFT edge.
    expect(place({ anchor: middle, rtl: true })).toMatchObject({ left: 500 })
    // And -start lines up with the right edge, so the panel extends leftward from it.
    expect(place({ anchor: middle, rtl: true, placement: 'bottom-start' })).toMatchObject({ left: 156 })
  })

  it('honours the offset and the margin it is given', () => {
    expect(place({ offset: 20 }).top).toBe(156)
    expect(place({ margin: 50, anchor: { ...bell, left: 4, right: 40 } }).left).toBe(50)
  })
})
