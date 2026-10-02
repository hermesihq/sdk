import type { HermsInboxPlacement } from '@hermesihq/inbox-ui'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PositionInput {
  /** The bell, in viewport coordinates. */
  anchor: Box
  /** The panel's own size. */
  panel: { width: number; height: number }
  viewport: { width: number; height: number }
  placement: HermsInboxPlacement
  /** Right-to-left page: "start" and "end" swap sides. */
  rtl: boolean
  /** Gap between the bell and the panel. */
  offset?: number
  /** Gap kept between the panel and the edge of the viewport. */
  margin?: number
}

export interface Position {
  left: number
  top: number
  /** The side it ended up on, which can differ from the one asked for. */
  side: 'top' | 'bottom'
}

/**
 * Where the panel goes: beside the bell on the requested side, flipped to the other when there
 * is not room and the other has more, and kept inside the viewport.
 *
 * A native popover sits in the top layer at a fixed position and knows nothing about the button
 * that opened it, so this is the part the platform does not do. It is a pure function of boxes
 * on purpose: the layout engine is not available to the unit tests, but arithmetic is.
 *
 * `start` and `end` are logical. In a right-to-left page the panel that asks for `bottom-end`
 * lines up with the bell's left edge, because that is where the end of a line is.
 */
export function computePosition({ anchor, panel, viewport, placement, rtl, offset = 8, margin = 8 }: PositionInput): Position {
  const [preferred, align] = placement.split('-') as ['top' | 'bottom', 'start' | 'end']

  const roomBelow = viewport.height - anchor.bottom - offset - margin
  const roomAbove = anchor.top - offset - margin
  const room = (side: 'top' | 'bottom') => (side === 'bottom' ? roomBelow : roomAbove)
  const opposite = preferred === 'bottom' ? 'top' : 'bottom'
  const side = panel.height > room(preferred) && room(opposite) > room(preferred) ? opposite : preferred

  const top = side === 'bottom' ? anchor.bottom + offset : anchor.top - offset - panel.height

  // The edge of the panel that lines up with the bell: its right edge to the bell's right edge,
  // or its left to the bell's left.
  const alignRight = (align === 'end') !== rtl
  const left = alignRight ? anchor.right - panel.width : anchor.left

  return {
    left: clamp(left, margin, viewport.width - margin - panel.width),
    top: clamp(top, margin, viewport.height - margin - panel.height),
    side,
  }
}

/** `min` wins when the range is empty, so a panel larger than the viewport starts at the margin. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
