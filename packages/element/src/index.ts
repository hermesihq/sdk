/**
 * `@hermesihq/element`: `<hermes-inbox>`, Hermesi's notification bell and panel as a custom
 * element. Importing this registers it, unless the name is taken.
 *
 * ```html
 * <hermes-inbox public-key="hm_pk_..." api-base-url="https://your-hermesi-host/v1/client"></hermes-inbox>
 * ```
 *
 * `getSubscriberToken` is a function and so cannot be an attribute: set it as a property.
 */
import { HermesInboxElement } from './HermesInbox'

export { HermesInboxElement } from './HermesInbox'
export type { HermesErrorDetail, HermesInboxEventMap, HermesItemClickDetail } from './HermesInbox'
export type { HermsColorScheme, HermsInboxPlacement, HermsLocale } from '@hermesihq/inbox-ui'

declare global {
  interface HTMLElementTagNameMap {
    'hermes-inbox': HermesInboxElement
  }
}

/**
 * Registers the element under `tagName` (default `hermes-inbox`). Does nothing where there is no
 * `customElements` (a server render), and nothing if the name is already taken, so loading this
 * twice, or after a page defined its own element of that name, is not an error.
 *
 * A browser allows a class one name only, so any name after the first gets a subclass.
 */
export function defineHermesInbox(tagName = 'hermes-inbox'): void {
  if (typeof customElements === 'undefined') return
  if (customElements.get(tagName)) return
  const used = [...DEFINED].some((name) => customElements.get(name) === HermesInboxElement)
  customElements.define(tagName, used ? class extends HermesInboxElement {} : HermesInboxElement)
  DEFINED.add(tagName)
}

const DEFINED = new Set<string>()

defineHermesInbox()
