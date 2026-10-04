import { CountsStore, HermsClient, HermsSession, InboxStore, type HermsInboxItem } from '@hermesihq/js'
import {
  activateItem,
  badgeText,
  colorSchemeAttribute,
  createSeenTracker,
  getHermsInboxStrings,
  nextActiveIndex,
  relativeTime,
  type HermsColorScheme,
  type HermsInboxPlacement,
  type HermsInboxStrings,
  type HermsLocale,
  type SeenTracker,
} from '@hermesihq/inbox-ui'
import inboxCss from '@hermesihq/inbox-ui/inbox.css'
import elementCss from './element.css'
import { icon } from './icons'
import { computePosition } from './position'

const PLACEMENTS: readonly HermsInboxPlacement[] = ['bottom-start', 'bottom-end', 'top-start', 'top-end']

export interface HermesItemClickDetail {
  item: HermsInboxItem
}

export interface HermesErrorDetail {
  error: Error
}

/** Where the typed events a page can listen for are named. */
export interface HermesInboxEventMap {
  'hermes-item-click': CustomEvent<HermesItemClickDetail>
  'hermes-open': CustomEvent<null>
  'hermes-close': CustomEvent<null>
  'hermes-error': CustomEvent<HermesErrorDetail>
}

/**
 * `HTMLElement` does not exist on a server. Importing this module there must not throw, because
 * a page's bundle is evaluated by its server render before it is ever shown, so the class
 * extends a stand-in when there is no DOM. Nothing can construct it there either way.
 */
const BaseElement: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement

let sheet: CSSStyleSheet | null | undefined

/** One constructable stylesheet for every instance, or `null` where the engine has none. */
function sharedSheet(): CSSStyleSheet | null {
  if (sheet !== undefined) return sheet
  try {
    const created = new CSSStyleSheet()
    created.replaceSync(`${inboxCss}\n${elementCss}`)
    sheet = created
  } catch {
    sheet = null
  }
  return sheet
}

interface Runtime {
  session: HermsSession
  counts: CountsStore
  inbox: InboxStore
  /** What the runtime was built from, to tell when a change of configuration needs a new one. */
  key: { publicKey: string; apiBaseUrl: string; session: HermsSession | null }
  stop: () => void
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

/**
 * `<hermes-inbox>`: the bell and panel of `@hermesihq/react`'s `<HermsInbox />`, for any page.
 *
 * The data side is `@hermesihq/js`'s stores, exactly as the React component uses them. What this
 * file adds is what React gets from Radix: placing the panel beside the bell, closing it, and
 * giving the focus back. The panel is a native popover, which supplies the top layer, Escape and
 * a click outside; it does not supply focus return, following a scroll, or closing when focus
 * leaves, and those are written here (`tests/platform.spec.ts` in the end-to-end suite measures
 * each of those three in every engine).
 */
export class HermesInboxElement extends BaseElement {
  static readonly observedAttributes = ['public-key', 'api-base-url', 'placement', 'color-scheme', 'locale']

  /** Whether this browser has what the element is built on. Where it does not, nothing is drawn. */
  static get isSupported(): boolean {
    return (
      typeof HTMLElement !== 'undefined' &&
      typeof HTMLElement.prototype.showPopover === 'function' &&
      typeof HTMLButtonElement !== 'undefined' &&
      'popoverTargetElement' in HTMLButtonElement.prototype
    )
  }

  // Properties: they cannot be attributes (a function, an object).
  #getSubscriberToken: (() => string | Promise<string>) | undefined
  #onTokenExpiring: (() => void) | undefined
  #session: HermsSession | null = null

  #runtime: Runtime | null = null
  #seen: SeenTracker = createSeenTracker()
  #activeIndex = 0
  #awaitingList = false
  #lastError: Error | null = null
  #open = false
  #frame = 0

  // Built once, in the constructor, and only ever updated afterwards.
  readonly #root: ShadowRoot | null = null
  readonly #wrapper: HTMLDivElement | null = null
  readonly #live: HTMLSpanElement | null = null
  readonly #bell: HTMLButtonElement | null = null
  readonly #badge: HTMLSpanElement | null = null
  readonly #panel: HTMLDivElement | null = null
  readonly #title: HTMLParagraphElement | null = null
  readonly #markAll: HTMLButtonElement | null = null
  readonly #close: HTMLButtonElement | null = null
  readonly #body: HTMLDivElement | null = null
  readonly #rows = new Map<string, HTMLLIElement>()
  #list: HTMLUListElement | null = null
  #loadMore: HTMLButtonElement | null = null

  constructor() {
    super()
    if (!HermesInboxElement.isSupported) return

    const root = this.attachShadow({ mode: 'open' })
    const shared = sharedSheet()
    if (shared) {
      root.adoptedStyleSheets = [shared]
    } else {
      const style = document.createElement('style')
      style.textContent = `${inboxCss}\n${elementCss}`
      root.append(style)
    }

    const panelId = `herms-panel-${Math.random().toString(36).slice(2, 10)}`
    const titleId = `${panelId}-title`

    const live = document.createElement('span')
    live.className = 'herms-inbox__visually-hidden'
    live.setAttribute('role', 'status')
    live.setAttribute('aria-live', 'polite')

    const bell = document.createElement('button')
    bell.type = 'button'
    bell.className = 'herms-inbox__trigger'
    bell.setAttribute('part', 'trigger')
    bell.setAttribute('aria-haspopup', 'dialog')
    bell.setAttribute('aria-controls', panelId)
    bell.setAttribute('aria-expanded', 'false')
    bell.append(icon('bell'))
    const badge = document.createElement('span')
    badge.className = 'herms-inbox__badge'
    badge.setAttribute('part', 'badge')
    badge.setAttribute('aria-hidden', 'true')
    badge.hidden = true

    const panel = document.createElement('div')
    panel.id = panelId
    panel.className = 'herms-inbox__panel'
    panel.setAttribute('part', 'panel')
    panel.setAttribute('popover', 'auto')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-labelledby', titleId)
    panel.tabIndex = -1

    const title = document.createElement('p')
    title.className = 'herms-inbox__title'
    title.id = titleId
    const markAll = document.createElement('button')
    markAll.type = 'button'
    markAll.className = 'herms-inbox__text-button'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'herms-inbox__icon-button'
    close.append(icon('close'))
    const actions = document.createElement('div')
    actions.className = 'herms-inbox__header-actions'
    actions.append(markAll, close)
    const header = document.createElement('div')
    header.className = 'herms-inbox__header'
    header.append(title, actions)

    const body = document.createElement('div')
    panel.append(header, body)

    const wrapper = document.createElement('div')
    wrapper.className = 'herms-inbox'
    wrapper.append(live, bell, panel)
    bell.append(badge)
    root.append(wrapper)

    this.#root = root
    this.#wrapper = wrapper
    this.#live = live
    this.#bell = bell
    this.#badge = badge
    this.#panel = panel
    this.#title = title
    this.#markAll = markAll
    this.#close = close
    this.#body = body

    // The native invoker: the browser toggles the panel on a click of the bell and leaves the
    // bell out of "a click outside", which a click handler of our own would get wrong (the
    // outside click closes it, then our handler opens it again).
    bell.popoverTargetElement = panel

    panel.addEventListener('beforetoggle', this.#onBeforeToggle as EventListener)
    panel.addEventListener('toggle', this.#onToggle as EventListener)
    root.addEventListener('focusout', this.#onFocusOut as EventListener)
    markAll.addEventListener('click', () => this.#guard(this.#runtime?.inbox.markAllRead()))
    close.addEventListener('click', () => this.close())
    this.#render()
  }

  // ---- configuration ------------------------------------------------------------------------

  get publicKey(): string {
    return this.getAttribute('public-key') ?? ''
  }
  set publicKey(value: string) {
    this.setAttribute('public-key', value)
  }

  get apiBaseUrl(): string {
    return this.getAttribute('api-base-url') ?? ''
  }
  set apiBaseUrl(value: string) {
    this.setAttribute('api-base-url', value)
  }

  get placement(): HermsInboxPlacement {
    const value = this.getAttribute('placement') as HermsInboxPlacement | null
    return value && PLACEMENTS.includes(value) ? value : 'bottom-end'
  }
  set placement(value: HermsInboxPlacement) {
    this.setAttribute('placement', value)
  }

  get colorScheme(): HermsColorScheme {
    const value = this.getAttribute('color-scheme')
    return value === 'light' || value === 'dark' ? value : 'auto'
  }
  set colorScheme(value: HermsColorScheme) {
    this.setAttribute('color-scheme', value)
  }

  get locale(): HermsLocale {
    return this.getAttribute('locale') === 'fr' ? 'fr' : 'en'
  }
  set locale(value: HermsLocale) {
    this.setAttribute('locale', value)
  }

  /** Called before every request for a fresh subscriber token. Required; it cannot be an attribute. */
  get getSubscriberToken(): (() => string | Promise<string>) | undefined {
    return this.#getSubscriberToken
  }
  set getSubscriberToken(value: (() => string | Promise<string>) | undefined) {
    this.#getSubscriberToken = value
    this.#sync()
  }

  /** Called shortly before the held token expires, so the page can refresh it. Optional. */
  get onTokenExpiring(): (() => void) | undefined {
    return this.#onTokenExpiring
  }
  set onTokenExpiring(value: (() => void) | undefined) {
    this.#onTokenExpiring = value
  }

  /**
   * Advanced: an existing `HermsSession` from `@hermesihq/js`, to share one connection and the
   * same stores with the rest of the page. When set, the key, URL and token function are the
   * session's client's, and the attributes are ignored.
   */
  get session(): HermsSession | null {
    return this.#session
  }
  set session(value: HermsSession | null) {
    this.#session = value
    this.#sync()
  }

  get isOpen(): boolean {
    return this.#open
  }

  // ---- methods ------------------------------------------------------------------------------

  open(): void {
    if (!this.#panel || !this.#runtime || this.#open) return
    this.#panel.showPopover()
  }

  close(): void {
    if (!this.#panel || !this.#open) return
    this.#panel.hidePopover()
  }

  /** Loads the first page again. */
  refresh(): void {
    this.#runtime?.inbox.refetch()
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  connectedCallback(): void {
    // A page may set `getSubscriberToken` before this element is defined, which leaves an own
    // property shadowing the accessor above. Move each onto the accessor.
    for (const name of ['getSubscriberToken', 'onTokenExpiring', 'session'] as const) {
      if (Object.prototype.hasOwnProperty.call(this, name)) {
        const value = (this as unknown as Record<string, unknown>)[name]
        delete (this as unknown as Record<string, unknown>)[name]
        ;(this as unknown as Record<string, unknown>)[name] = value
      }
    }
    this.#sync()
  }

  disconnectedCallback(): void {
    // Moving a node in the DOM is a disconnect followed by a connect in the same task. Tearing
    // down at once would close the connection and refetch the list for a node that only moved,
    // so it waits a microtask and looks again.
    queueMicrotask(() => {
      if (!this.isConnected) this.#stop()
    })
  }

  attributeChangedCallback(name: string): void {
    if (name === 'public-key' || name === 'api-base-url') this.#sync()
    else this.#render()
    if (name === 'placement' && this.#open) this.#position()
  }

  // ---- runtime ------------------------------------------------------------------------------

  /** Brings the running state in line with the configuration, whichever order it arrived in. */
  #sync(): void {
    if (!this.#bell) return
    const wanted = this.isConnected ? this.#configuration() : null
    const current = this.#runtime

    if (current && wanted && current.key.publicKey === wanted.publicKey && current.key.apiBaseUrl === wanted.apiBaseUrl && current.key.session === wanted.session) {
      this.#render()
      return
    }
    if (current) this.#stop()
    if (wanted) this.#start(wanted)
    this.#render()
  }

  #configuration(): Runtime['key'] | null {
    if (this.#session) return { publicKey: '', apiBaseUrl: '', session: this.#session }
    if (!this.publicKey || !this.apiBaseUrl || typeof this.#getSubscriberToken !== 'function') return null
    return { publicKey: this.publicKey, apiBaseUrl: this.apiBaseUrl, session: null }
  }

  #start(key: Runtime['key']): void {
    const session =
      key.session ??
      new HermsSession(
        new HermsClient({
          publicKey: key.publicKey,
          apiBaseUrl: key.apiBaseUrl,
          getSubscriberToken: () => {
            const read = this.#getSubscriberToken
            if (!read) throw new Error('<hermes-inbox>: getSubscriberToken was removed.')
            return read()
          },
          onTokenExpiring: () => this.#onTokenExpiring?.(),
        }),
      )
    const counts = new CountsStore(session)
    const inbox = new InboxStore(session)

    const stops = [session.connect(), counts.connect(), inbox.connect(), counts.subscribe(this.#onChange), inbox.subscribe(this.#onChange)]
    this.#runtime = {
      session,
      counts,
      inbox,
      key,
      // Reverse of the order they were started in.
      stop: () => {
        for (const stop of stops.reverse()) stop()
      },
    }
    this.#seen = createSeenTracker()
    this.#lastError = null
  }

  #stop(): void {
    const runtime = this.#runtime
    if (!runtime) return
    this.#runtime = null
    if (this.#open) this.#panel?.hidePopover()
    runtime.stop()
    this.#rows.clear()
    this.#list = null
    this.#loadMore = null
    this.#render()
  }

  #onChange = (): void => {
    this.#render()
    const runtime = this.#runtime
    if (!runtime) return

    const { items, isLoading, error } = runtime.inbox.getSnapshot()
    if (error && error !== this.#lastError) this.#report(error)
    this.#lastError = error

    if (!this.#open) return
    // "Seen" (the bell was opened) is distinct from "read": everything on screen is reported
    // once, including rows that arrive later while the panel stays open.
    const fresh = this.#seen.take(items)
    if (fresh.length > 0) this.#guard(runtime.session.client.markSeen(fresh))

    // The panel opened before the first page arrived and took the focus itself to wait; hand it
    // to the first notification now, unless the person has moved it somewhere else meanwhile.
    if (this.#awaitingList && !isLoading) {
      this.#awaitingList = false
      if (items.length > 0 && this.#root?.activeElement === this.#panel) this.#itemButtons()[0]?.focus()
    }
  }

  // ---- events and reporting -----------------------------------------------------------------

  // The events are dispatched on the host element, which is in the page's tree, so they need to
  // bubble and have no use for `composed` (that is for events fired from inside the shadow root).
  #report(error: unknown): void {
    this.dispatchEvent(new CustomEvent<HermesErrorDetail>('hermes-error', { detail: { error: toError(error) }, bubbles: true }))
  }

  /** A mutation that was started and not waited for: its failure is reported, not left unhandled. */
  #guard(promise: Promise<unknown> | undefined): void {
    promise?.catch((error: unknown) => this.#report(error))
  }

  // ---- opening and closing ------------------------------------------------------------------

  #onBeforeToggle = (event: ToggleEvent): void => {
    if (event.newState === 'open') this.#panel?.setAttribute('data-positioning', '')
  }

  #onToggle = (event: ToggleEvent): void => {
    if (event.newState === 'open') this.#opened()
    else this.#closed()
  }

  #opened(): void {
    const panel = this.#panel!
    this.#open = true
    this.#activeIndex = 0
    this.#bell!.setAttribute('aria-expanded', 'true')
    this.#render()

    // Measured now that it is displayed, and shown only once it is where it belongs.
    this.#position()
    panel.removeAttribute('data-positioning')
    window.addEventListener('scroll', this.#reposition, { capture: true, passive: true })
    window.addEventListener('resize', this.#reposition, { passive: true })

    const runtime = this.#runtime
    if (runtime) {
      const { items, isLoading } = runtime.inbox.getSnapshot()
      if (items.length > 0) {
        this.#itemButtons()[0]?.focus()
      } else if (isLoading) {
        // Nothing to focus yet. Wait on the panel; `#onChange` moves it to the first
        // notification when the list arrives.
        this.#awaitingList = true
        panel.focus()
      } else {
        // Nothing to choose from (empty, or failed): the first control that can take it.
        panel.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
      }
      this.#onChange()
    }
    this.dispatchEvent(new CustomEvent('hermes-open', { bubbles: true }))
  }

  #closed(): void {
    const panel = this.#panel!
    this.#open = false
    this.#awaitingList = false
    this.#bell!.setAttribute('aria-expanded', 'false')
    window.removeEventListener('scroll', this.#reposition, { capture: true })
    window.removeEventListener('resize', this.#reposition)
    cancelAnimationFrame(this.#frame)

    // The platform leaves the focus nowhere when a popover closes. Give it back to the bell if it
    // was inside the panel or has been lost, but not if the person has clicked or tabbed to
    // something else on the page, which is where they meant it to go.
    const inside = this.#root!.activeElement
    const lost = document.activeElement === null || document.activeElement === document.body
    if ((inside && panel.contains(inside)) || (!inside && lost)) this.#bell!.focus()

    this.dispatchEvent(new CustomEvent('hermes-close', { bubbles: true }))
  }

  /** Focus moved out of the element: close, as a menu does. The platform only closes on a click or Escape. */
  #onFocusOut = (event: FocusEvent): void => {
    if (!this.#open) return
    const next = event.relatedTarget as Node | null
    // No target: the window lost focus, or something unfocusable was clicked. Not a reason to close.
    if (!next) return
    if (!this.#root!.contains(next)) this.#panel!.hidePopover()
  }

  // ---- positioning --------------------------------------------------------------------------

  #reposition = (): void => {
    cancelAnimationFrame(this.#frame)
    this.#frame = requestAnimationFrame(() => this.#position())
  }

  #position(): void {
    const panel = this.#panel
    const bell = this.#bell
    if (!panel || !bell || !this.#open) return
    const anchor = bell.getBoundingClientRect()
    const size = panel.getBoundingClientRect()
    const { left, top, side } = computePosition({
      anchor,
      panel: { width: size.width, height: size.height },
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      placement: this.placement,
      rtl: getComputedStyle(this).direction === 'rtl',
    })
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.dataset.side = side
  }

  // ---- rendering ----------------------------------------------------------------------------

  #itemButtons(): HTMLButtonElement[] {
    return [...this.#rows.values()].map((row) => row.querySelector<HTMLButtonElement>('.herms-inbox__item')!)
  }

  /** Draws the current state. Idempotent; the list is updated in place so focus survives it. */
  #render(): void {
    const wrapper = this.#wrapper
    if (!wrapper) return
    const strings = getHermsInboxStrings(this.locale)
    const runtime = this.#runtime
    const counts = runtime?.counts.getSnapshot() ?? { unread: 0, unseen: 0, isLoading: false }
    const state = runtime?.inbox.getSnapshot() ?? { items: [], isLoading: false, isLoadingMore: false, error: null, hasMore: false }

    const scheme = colorSchemeAttribute(this.colorScheme)
    for (const target of [wrapper, this.#panel!]) {
      if (scheme) target.setAttribute('data-herms-color-scheme', scheme)
      else target.removeAttribute('data-herms-color-scheme')
    }

    const label = counts.unread > 0 ? strings.bellLabelWithUnread(counts.unread) : strings.bellLabel
    this.#bell!.setAttribute('aria-label', label)
    this.#bell!.disabled = !runtime
    this.#live!.textContent = counts.unread > 0 ? strings.bellLabelWithUnread(counts.unread) : ''
    this.#badge!.hidden = counts.unseen === 0
    this.#badge!.textContent = counts.unseen > 0 ? badgeText(counts.unseen) : ''

    this.#title!.textContent = strings.panelTitle
    this.#markAll!.textContent = strings.markAllRead
    this.#markAll!.disabled = counts.unread === 0
    this.#close!.setAttribute('aria-label', strings.close)

    this.#renderBody(strings, state)
  }

  #renderBody(strings: HermsInboxStrings, state: ReturnType<InboxStore['getSnapshot']>): void {
    const body = this.#body!
    if (state.isLoading) return this.#showState(body, 'loading', () => this.#loadingState(strings))
    if (state.error) return this.#showState(body, 'error', () => this.#errorState(strings))
    if (state.items.length === 0) return this.#showState(body, 'empty', () => this.#emptyState(strings))

    if (!this.#list || body.dataset.state !== 'list') {
      body.replaceChildren()
      body.dataset.state = 'list'
      delete body.dataset.locale
      this.#rows.clear()
      const list = document.createElement('ul')
      list.className = 'herms-inbox__list'
      // A list of buttons, not an ARIA menu: each row holds two controls, and a menu may own only menu items. `role="list"` is
      // explicit because Safari drops list semantics from a list whose bullets are removed.
      list.setAttribute('role', 'list')
      list.addEventListener('keydown', this.#onListKeyDown as EventListener)
      this.#list = list
      this.#loadMore = null
      body.append(list)
    }
    const list = this.#list
    list.setAttribute('aria-label', strings.panelTitle)

    const wanted = new Set(state.items.map((item) => item.id))
    for (const [id, row] of this.#rows) {
      if (!wanted.has(id)) {
        row.remove()
        this.#rows.delete(id)
      }
    }
    let previous: Element | null = null
    state.items.forEach((item) => {
      let row = this.#rows.get(item.id)
      if (!row) {
        row = this.#createRow(item)
        this.#rows.set(item.id, row)
      }
      this.#updateRow(row, item, strings)
      // Only touch the DOM when a row is out of place: moving a row that holds the focus drops it.
      const expected = previous ? previous.nextElementSibling : list.firstElementChild
      if (expected !== row) list.insertBefore(row, expected)
      previous = row
    })

    if (state.hasMore) {
      if (!this.#loadMore) {
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'herms-inbox__load-more'
        more.addEventListener('click', () => this.#runtime?.inbox.loadMore())
        this.#loadMore = more
        body.append(more)
      }
      this.#loadMore.disabled = state.isLoadingMore
      this.#loadMore.textContent = state.isLoadingMore ? strings.loadingMore : strings.loadMore
    } else if (this.#loadMore) {
      this.#loadMore.remove()
      this.#loadMore = null
    }
  }

  /** Replaces the body with a non-list state, once, so a state that is already shown is left alone. */
  #showState(body: HTMLElement, name: string, build: () => HTMLElement): void {
    // Rebuilt only when the state or the language changes: this runs on every store update, and a
    // Retry button that is replaced under the person's finger loses its focus.
    if (body.dataset.state === name && body.dataset.locale === this.locale) return
    body.dataset.state = name
    body.dataset.locale = this.locale
    body.replaceChildren(build())
    this.#rows.clear()
    this.#list = null
    this.#loadMore = null
  }

  #loadingState(strings: HermsInboxStrings): HTMLElement {
    const box = document.createElement('div')
    box.setAttribute('role', 'status')
    box.setAttribute('aria-label', strings.loading)
    for (const index of [0, 1, 2, 3]) {
      const line = document.createElement('div')
      line.className = 'herms-inbox__skeleton-line'
      line.style.width = index % 2 === 0 ? '85%' : '65%'
      box.append(line)
    }
    return box
  }

  #errorState(strings: HermsInboxStrings): HTMLElement {
    const box = document.createElement('div')
    box.className = 'herms-inbox__state'
    box.setAttribute('role', 'alert')
    const text = document.createElement('p')
    text.className = 'herms-inbox__state-title'
    text.textContent = strings.errorTitle
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'herms-inbox__text-button'
    retry.textContent = strings.retry
    retry.addEventListener('click', () => this.refresh())
    box.append(icon('alert'), text, retry)
    return box
  }

  #emptyState(strings: HermsInboxStrings): HTMLElement {
    const box = document.createElement('div')
    box.className = 'herms-inbox__state'
    box.textContent = strings.empty
    return box
  }

  #createRow(item: HermsInboxItem): HTMLLIElement {
    const row = document.createElement('li')
    row.className = 'herms-inbox__list-row'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'herms-inbox__item'
    button.setAttribute('part', 'item')
    button.append(this.#span('herms-inbox__item-title'), this.#span('herms-inbox__item-meta'))
    button.addEventListener('focus', () => {
      this.#activeIndex = this.#itemButtons().indexOf(button)
    })
    button.addEventListener('click', () => this.#activate(item.id))

    const archive = document.createElement('button')
    archive.type = 'button'
    archive.className = 'herms-inbox__archive-button'
    archive.append(icon('archive'))
    archive.addEventListener('click', () => this.#guard(this.#runtime?.inbox.archive(item.id)))

    row.append(button, archive)
    return row
  }

  #span(className: string): HTMLSpanElement {
    const span = document.createElement('span')
    span.className = className
    return span
  }

  #updateRow(row: HTMLLIElement, item: HermsInboxItem, strings: HermsInboxStrings): void {
    const button = row.firstElementChild as HTMLButtonElement
    const title = button.querySelector('.herms-inbox__item-title')!
    const meta = button.querySelector('.herms-inbox__item-meta')!
    title.textContent = item.title
    // The body is a row of its own only when there is one: a live event carries none until the
    // authoritative row lands, and the React component leaves it out in the same case.
    let body = button.querySelector('.herms-inbox__item-body')
    if (item.body) {
      if (!body) {
        body = this.#span('herms-inbox__item-body')
        button.insertBefore(body, meta)
      }
      body.textContent = item.body
    } else {
      body?.remove()
    }
    meta.textContent = relativeTime(item.createdAt, this.locale)
    button.dataset.unread = String(!item.readAt)
    ;(row.lastElementChild as HTMLButtonElement).setAttribute('aria-label', `${strings.archive}: ${item.title}`)
  }

  // ---- interaction --------------------------------------------------------------------------

  #onListKeyDown = (event: KeyboardEvent): void => {
    const buttons = this.#itemButtons()
    const next = nextActiveIndex(event.key, this.#activeIndex, buttons.length)
    if (next === null) return
    event.preventDefault()
    this.#activeIndex = next
    buttons[next]?.focus()
  }

  #activate(id: string): void {
    const runtime = this.#runtime
    const item = runtime?.inbox.getSnapshot().items.find((candidate) => candidate.id === id)
    if (!runtime || !item) return
    const go = (url: string): void => window.location.assign(url)
    activateItem(item, {
      markRead: (itemId) => this.#guard(runtime.inbox.markRead(itemId)),
      // The host's chance to route the click itself; if it does not call `preventDefault()`, the
      // element navigates, which is what `onItemClick` omitted does in the React component.
      onItemClick: (clicked) => {
        const event = new CustomEvent<HermesItemClickDetail>('hermes-item-click', {
          detail: { item: clicked },
          bubbles: true,
          cancelable: true,
        })
        this.dispatchEvent(event)
        if (!event.defaultPrevented && clicked.actionUrl) go(clicked.actionUrl)
      },
      navigate: go,
    })
  }
}
