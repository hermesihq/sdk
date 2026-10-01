import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { HermsInboxItem } from '@hermesihq/js'
import { useHermsContext } from './HermsProvider'
import { useInbox } from './useInbox'
import { useUnreadCount } from './useUnreadCount'
import {
  activateItem,
  badgeText,
  classNames,
  colorSchemeAttribute,
  createSeenTracker,
  getHermsInboxStrings,
  nextActiveIndex,
  relativeTime,
  splitPlacement,
  themeVariables,
  type HermsColorScheme,
  type HermsInboxPlacement,
  type HermsInboxTheme,
  type HermsLocale,
} from '@hermesihq/inbox-ui'
import '@hermesihq/inbox-ui/inbox.css'

export type { HermsInboxPlacement, HermsInboxTheme }

export interface HermsInboxProps {
  /** Popover position relative to the bell trigger. Default `bottom-end`. */
  placement?: HermsInboxPlacement
  /** Called when an item is activated (click, or Enter on a focused row).
   * Lets a host app drive its own router (for example
   * `onItemClick={(item) => navigate(item.actionUrl)}`) instead of a hard
   * page navigation. When omitted, activating an item with a non-null
   * `actionUrl` does a plain `window.location.assign` to it. Either way, the
   * item is marked read first. */
  onItemClick?: (item: HermsInboxItem) => void
  /** A couple of the most commonly re-themed CSS custom properties, settable
   * without a host app writing any CSS of its own. Anything else is
   * reachable by overriding `--herms-color-*`/`--herms-radius` variables
   * directly (see `HermsInbox.css`). */
  theme?: HermsInboxTheme
  /** `'auto'` (default) follows the visitor's OS `prefers-color-scheme`;
   * `'light'`/`'dark'` force one regardless of it. */
  colorScheme?: HermsColorScheme
  locale?: HermsLocale
  className?: string
}

function BellIcon() {
  return (
    <svg className="herms-inbox__bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 13h4" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  )
}

/**
 * `<HermsInbox />`: bell trigger + dropdown panel. Built
 * entirely on the headless `useInbox`/`useUnreadCount` hooks; every state
 * (loading, empty, error, populated) renders here, none of it invented by a
 * host app. Accessible: a real `<button>` trigger with `aria-label`/
 * `aria-expanded`, the panel as `role="menu"` with roving-tabindex arrow-key
 * navigation, `Home`/`End`, `Escape`-to-close (native to Radix `Popover`,
 * which also returns focus to the trigger), and `Enter`/`Space` (native
 * `<button>` behavior) to activate the focused item.
 */
export function HermsInbox({ placement = 'bottom-end', onItemClick, theme, colorScheme = 'auto', locale, className }: HermsInboxProps) {
  const { client } = useHermsContext()
  const { unread, unseen } = useUnreadCount()
  const { items, isLoading, isLoadingMore, error, hasMore, loadMore, markRead, markAllRead, archive, refetch } = useInbox()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const seenRef = useRef(createSeenTracker())
  const strings = getHermsInboxStrings(locale)
  const titleId = useId()

  // "Seen" (the bell was opened) is distinct from "read." Marks
  // every currently loaded, not-yet-seen id seen once the panel is open and
  // has items, including any additional ids that arrive later via
  // `loadMore`/live updates while it stays open.
  useEffect(() => {
    if (!open || items.length === 0) return
    const toMark = seenRef.current.take(items)
    if (toMark.length === 0) return
    void client.markSeen(toMark)
  }, [open, items, client])

  useEffect(() => {
    if (open) setActiveIndex(0)
  }, [open])

  const focusItem = useCallback((index: number) => {
    setActiveIndex(index)
    itemRefs.current[index]?.focus()
  }, [])

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      const next = nextActiveIndex(event.key, activeIndex, items.length)
      if (next === null) return
      event.preventDefault()
      focusItem(next)
    },
    [items.length, activeIndex, focusItem],
  )

  const handleActivate = useCallback(
    (item: HermsInboxItem) => {
      activateItem(item, {
        markRead,
        onItemClick,
        navigate: (url) => {
          if (typeof window !== 'undefined') window.location.assign(url)
        },
      })
    },
    [markRead, onItemClick],
  )

  const rootStyle = useMemo<CSSProperties>(() => themeVariables(theme), [theme?.accent, theme?.radius])

  const { side, align } = splitPlacement(placement)
  const rootClassName = classNames('herms-inbox', className)
  // The panel is rendered by Radix in a portal under <body>, so it is not inside the root
  // above and inherits nothing from it. Whatever the root carries so that the stylesheet can
  // theme it, the panel has to carry as well: the theme's inline variables, the forced colour
  // scheme, and the host's class (so that one rule on `className` themes both).
  const panelClassName = classNames('herms-inbox__panel', className)
  const colorSchemeValue = colorSchemeAttribute(colorScheme)

  return (
    <div className={rootClassName} style={rootStyle} data-herms-color-scheme={colorSchemeValue}>
      <span className="herms-inbox__visually-hidden" role="status" aria-live="polite">
        {unread > 0 ? strings.bellLabelWithUnread(unread) : ''}
      </span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="herms-inbox__trigger"
            aria-label={unread > 0 ? strings.bellLabelWithUnread(unread) : strings.bellLabel}
            aria-expanded={open}
          >
            <BellIcon />
            {unseen > 0 && (
              <span className="herms-inbox__badge" aria-hidden="true">
                {badgeText(unseen)}
              </span>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={panelClassName}
            style={rootStyle}
            data-herms-color-scheme={colorSchemeValue}
            // The dialog needs a name of its own. Only the list, the bell and the loading
            // state were named; a dialog without one is announced as just "dialog".
            aria-labelledby={titleId}
            side={side}
            align={align}
            sideOffset={8}
            onOpenAutoFocus={(event) => {
              // Radix's default is to focus the content wrapper itself; we
              // want the first item (or the header when there are none)
              // focused instead, so keyboard users land somewhere useful.
              if (items.length > 0) {
                event.preventDefault()
                itemRefs.current[0]?.focus()
              }
            }}
          >
            <div className="herms-inbox__header">
              <p className="herms-inbox__title" id={titleId}>{strings.panelTitle}</p>
              <div className="herms-inbox__header-actions">
                <button type="button" className="herms-inbox__text-button" onClick={() => void markAllRead()} disabled={unread === 0}>
                  {strings.markAllRead}
                </button>
                <Popover.Close asChild>
                  <button type="button" className="herms-inbox__icon-button" aria-label={strings.close}>
                    <CloseIcon />
                  </button>
                </Popover.Close>
              </div>
            </div>

            {isLoading ? (
              <div role="status" aria-label={strings.loading}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="herms-inbox__skeleton-line" style={{ width: i % 2 === 0 ? '85%' : '65%' }} />
                ))}
              </div>
            ) : error ? (
              <div className="herms-inbox__state" role="alert">
                <AlertIcon />
                <p className="herms-inbox__state-title">{strings.errorTitle}</p>
                <button type="button" className="herms-inbox__text-button" onClick={() => refetch()}>
                  {strings.retry}
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="herms-inbox__state">{strings.empty}</div>
            ) : (
              <>
                <ul className="herms-inbox__list" role="menu" aria-label={strings.panelTitle} onKeyDown={handleListKeyDown}>
                  {items.map((item, index) => (
                    <li key={item.id} className="herms-inbox__list-row" role="none">
                      <button
                        type="button"
                        role="menuitem"
                        ref={(el) => {
                          itemRefs.current[index] = el
                        }}
                        tabIndex={index === activeIndex ? 0 : -1}
                        className="herms-inbox__item"
                        data-unread={!item.readAt}
                        onFocus={() => setActiveIndex(index)}
                        onClick={() => handleActivate(item)}
                      >
                        <span className="herms-inbox__item-title">{item.title}</span>
                        {item.body && <span className="herms-inbox__item-body">{item.body}</span>}
                        <span className="herms-inbox__item-meta">{relativeTime(item.createdAt, locale ?? 'en')}</span>
                      </button>
                      <button
                        type="button"
                        className="herms-inbox__archive-button"
                        aria-label={`${strings.archive}: ${item.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          void archive(item.id)
                        }}
                      >
                        <ArchiveIcon />
                      </button>
                    </li>
                  ))}
                </ul>
                {hasMore && (
                  <button type="button" className="herms-inbox__load-more" onClick={loadMore} disabled={isLoadingMore}>
                    {isLoadingMore ? strings.loadingMore : strings.loadMore}
                  </button>
                )}
              </>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
