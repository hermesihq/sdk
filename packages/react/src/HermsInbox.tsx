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
  /**
   * Adds an "Archived" control to the panel's header that switches it to the notifications the person has archived, with a way
   * back. Off by default, so that upgrading changes nothing a person sees until the host asks for it. The archived list is only
   * for looking back: its rows have no archive control (there is no way to un-archive), a notification can still be opened and
   * marked read or unread, and the panel returns to the live feed whenever it is closed.
   */
  archivedView?: boolean
  /**
   * Called when something the person did fails: marking a notification read, marking all read, archiving, or marking them
   * seen. Receives an `Error` (a `HermsApiError` when Hermesi refused the request). The component shows nothing itself
   * for these, because the list is the source of truth and the next refresh corrects it; this is how your app finds out,
   * to log it or tell the person. When omitted, the error is logged with `console.error`, so it is never silent and
   * never an unhandled promise rejection. The custom element reports the same failures as a `hermes-error` event.
   */
  onError?: (error: Error) => void
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

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

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
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
 * `aria-expanded`, the panel as a dialog holding a list of buttons with arrow-key
 * navigation, `Home`/`End`, `Escape`-to-close (native to Radix `Popover`,
 * which also returns focus to the trigger), and `Enter`/`Space` (native
 * `<button>` behavior) to activate the focused item.
 */
export function HermsInbox({ placement = 'bottom-end', onItemClick, theme, colorScheme = 'auto', locale, className, archivedView = false, onError }: HermsInboxProps) {
  const { client } = useHermsContext()
  const { unread, unseen } = useUnreadCount()
  // Whether the person has opened the archived list. Only meaningful while the host has the view turned on, so turning it off
  // while it is open is the live feed again, without any state to reset.
  const [showArchived, setShowArchived] = useState(false)
  const archivedOpen = archivedView && showArchived
  const { items, isLoading, isLoadingMore, error, hasMore, loadMore, markRead, markUnread, markAllRead, archive, refetch } = useInbox({ archived: archivedOpen })
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const seenRef = useRef(createSeenTracker())
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Set when the panel opened before there was a notification to focus. Opening has to put
  // focus somewhere at once, so it waits on the panel itself; this remembers that it is
  // waiting, so that the first notification can have it when the list arrives.
  const awaitingList = useRef(false)
  const strings = getHermsInboxStrings(locale)
  const titleId = useId()
  // The latest `onError`, read when a failure arrives and not captured when the action was started, so that a handler that
  // changes between renders is the one that is called, without making every callback below depend on it.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  /** A mutation that was started and not waited for: its failure is reported, never left as an unhandled rejection. */
  const guard = useCallback((promise: Promise<unknown>): void => {
    promise.catch((error: unknown) => {
      const reported = toError(error)
      if (onErrorRef.current) onErrorRef.current(reported)
      else console.error('[hermesi] The inbox could not complete an action.', reported)
    })
  }, [])

  // "Seen" (the bell was opened) is distinct from "read." Marks
  // every currently loaded, not-yet-seen id seen once the panel is open and
  // has items, including any additional ids that arrive later via
  // `loadMore`/live updates while it stays open.
  // Not in the archived list: what is filed away is not new, and reporting it "seen" would be a request for nothing.
  useEffect(() => {
    if (!open || archivedOpen || items.length === 0) return
    const toMark = seenRef.current.take(items)
    if (toMark.length === 0) return
    guard(client.markSeen(toMark))
  }, [open, archivedOpen, items, client, guard])

  useEffect(() => {
    if (open) setActiveIndex(0)
  }, [open, archivedOpen])

  useEffect(() => {
    if (!open) {
      awaitingList.current = false
      return
    }
    if (!awaitingList.current || isLoading) return
    awaitingList.current = false
    // Only if focus is still where opening left it. A person who has already moved on, to
    // Close or to the bell's other controls, is not interrupted by a list arriving.
    if (items.length > 0 && document.activeElement === panelRef.current) itemRefs.current[0]?.focus()
  }, [open, isLoading, items.length])

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
        markRead: (id) => guard(markRead(id)),
        onItemClick,
        navigate: (url) => {
          if (typeof window !== 'undefined') window.location.assign(url)
        },
      })
    },
    [markRead, onItemClick, guard],
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
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // A panel that is opened again is the live feed, not wherever it was left.
          if (!next) setShowArchived(false)
        }}
      >
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
            ref={panelRef}
            tabIndex={-1}
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
              } else if (isLoading) {
                // Nothing to focus yet. Radix would pick the first control in the header and
                // nothing would ever move it; wait on the panel, and the effect above moves
                // focus to the first notification when there is one.
                event.preventDefault()
                awaitingList.current = true
                panelRef.current?.focus()
              }
            }}
          >
            <div className="herms-inbox__header">
              <p className="herms-inbox__title" id={titleId}>{archivedOpen ? strings.archivedTitle : strings.panelTitle}</p>
              <div className="herms-inbox__header-actions">
                {/* One control that is "Archived" on the live feed and "Back" on the archive. It is the same element in both, so
                    a keyboard user who pressed it is still on it when the list changes. */}
                {archivedView && (
                  <button type="button" className="herms-inbox__text-button" onClick={() => setShowArchived((current) => !current)}>
                    {archivedOpen ? strings.backToInbox : strings.archivedView}
                  </button>
                )}
                {!archivedOpen && (
                  <button type="button" className="herms-inbox__text-button" onClick={() => guard(markAllRead())} disabled={unread === 0}>
                    {strings.markAllRead}
                  </button>
                )}
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
              <div className="herms-inbox__state">{archivedOpen ? strings.archivedEmpty : strings.empty}</div>
            ) : (
              <>
                {/* A list of buttons, not an ARIA menu: each row holds two controls (the notification and its archive
                    button), and a menu may own only menu items, so the archive buttons would sit outside the pattern. `role="list"`
                    is explicit because Safari drops list semantics from a list whose bullets are removed. Arrow keys still move
                    between notifications; every control is also reachable with Tab, as in any list of buttons. */}
                <ul className="herms-inbox__list" role="list" aria-label={archivedOpen ? strings.archivedTitle : strings.panelTitle} onKeyDown={handleListKeyDown}>
                  {items.map((item, index) => (
                    <li key={item.id} className="herms-inbox__list-row">
                      <button
                        type="button"
                        ref={(el) => {
                          itemRefs.current[index] = el
                        }}
                        className="herms-inbox__item"
                        data-unread={!item.readAt}
                        onFocus={() => setActiveIndex(index)}
                        onClick={() => handleActivate(item)}
                      >
                        <span className="herms-inbox__item-title">{item.title}</span>
                        {item.body && <span className="herms-inbox__item-body">{item.body}</span>}
                        <span className="herms-inbox__item-meta">{relativeTime(item.createdAt, locale ?? 'en')}</span>
                      </button>
                      {item.readAt && (
                        <button
                          type="button"
                          className="herms-inbox__unread-button"
                          aria-label={`${strings.markUnread}: ${item.title}`}
                          onClick={() => {
                            const target = itemRefs.current[index]
                            const done = markUnread(item.id)
                            guard(done)
                            // The control leaves the row once the notification is unread, and focus would go with it to the
                            // page. It goes to the notification instead, so that someone using the keyboard stays in the list.
                            done.then(() => target?.focus(), () => undefined)
                          }}
                        >
                          <MailIcon />
                        </button>
                      )}
                      {!archivedOpen && (
                        <button
                          type="button"
                          className="herms-inbox__archive-button"
                          aria-label={`${strings.archive}: ${item.title}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            guard(archive(item.id))
                          }}
                        >
                          <ArchiveIcon />
                        </button>
                      )}
                      {item.actions.length > 0 && (
                        // Links, not buttons: they open an address. Outside the notification's own button (a button may not
                        // hold another control) and on a line of their own. Opening one reads the notification, as opening
                        // the notification does.
                        <div className="herms-inbox__actions" role="group" aria-label={`${strings.actions}: ${item.title}`}>
                          {item.actions.map((action, at) => (
                            <a
                              key={at}
                              className="herms-inbox__action"
                              data-style={action.style}
                              href={action.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => {
                                if (!item.readAt) guard(markRead(item.id))
                              }}
                            >
                              {action.label}
                            </a>
                          ))}
                        </div>
                      )}
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
