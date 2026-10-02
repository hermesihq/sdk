/**
 * A stand-in for the Popover API, which jsdom does not have.
 *
 * It is exactly as much of the platform as the element calls: `showPopover`, `hidePopover`,
 * `popoverTargetElement` on a button (a click toggles its target, as the browser's invoker
 * does), `beforetoggle` and `toggle` events carrying `newState`, and Escape closing an open
 * popover. It proves the element calls the API correctly. It cannot prove the API does what
 * this says: that is the end-to-end suite's job, in real engines.
 *
 * Not a `.test.` file, so vitest does not collect it.
 */

type PopoverElement = HTMLElement & { _open?: boolean }

const targets = new WeakMap<HTMLButtonElement, HTMLElement | null>()
const open = new Set<HTMLElement>()

function fire(element: HTMLElement, type: 'beforetoggle' | 'toggle', newState: 'open' | 'closed'): void {
  const event = new Event(type) as Event & { newState: string; oldState: string }
  event.newState = newState
  event.oldState = newState === 'open' ? 'closed' : 'open'
  element.dispatchEvent(event)
}

function show(this: HTMLElement): void {
  if (open.has(this)) return
  fire(this, 'beforetoggle', 'open')
  open.add(this)
  // jsdom's default stylesheet hides `[popover]` and cannot see `:popover-open`, so an open one
  // would be inaccessible to a role query. The browser un-hides it; so does this.
  this.style.display = 'block'
  // The real `toggle` is queued as a task, not fired in the call.
  queueMicrotask(() => fire(this, 'toggle', 'open'))
}

function hide(this: HTMLElement): void {
  if (!open.has(this)) return
  fire(this, 'beforetoggle', 'closed')
  open.delete(this)
  this.style.removeProperty('display')
  queueMicrotask(() => fire(this, 'toggle', 'closed'))
}

function onClick(event: Event): void {
  const origin = event.composedPath()[0]
  if (!(origin instanceof Element)) return
  const button = origin.closest('button') as HTMLButtonElement | null
  const target = button && targets.get(button)
  if (!target) return
  if (open.has(target)) hide.call(target)
  else show.call(target)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  for (const element of [...open]) hide.call(element)
}

export function installPopover(): () => void {
  const element = HTMLElement.prototype as unknown as Record<string, unknown>
  const button = HTMLButtonElement.prototype
  element.showPopover = show
  element.hidePopover = hide
  Object.defineProperty(button, 'popoverTargetElement', {
    configurable: true,
    get(this: HTMLButtonElement) {
      return targets.get(this) ?? null
    },
    set(this: HTMLButtonElement, value: HTMLElement | null) {
      targets.set(this, value)
    },
  })
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKeyDown)

  return () => {
    delete element.showPopover
    delete element.hidePopover
    delete (button as unknown as Record<string, unknown>).popoverTargetElement
    document.removeEventListener('click', onClick)
    document.removeEventListener('keydown', onKeyDown)
    open.clear()
  }
}

export function isPopoverOpen(element: Element): boolean {
  return open.has(element as PopoverElement)
}
