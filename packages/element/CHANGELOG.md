# Changelog

All notable changes to `@hermesihq/element`.

This file describes what a consumer gets, not how it was built. The repository's
history is where the reasoning lives.

## Versioning

**`0.x` means the public API can still change.** A minor bump (`0.1` to `0.2`) may
contain a breaking change; a patch bump will not. The attributes, properties, events and
CSS variables listed in the README are the public API.

Each release lists breaking changes first, because that is the only section that
decides whether an upgrade is a decision or a formality.

## 0.4.0 (2026-10-16)

### Added

- **A "Mark as unread" control on notifications that have been read**, as in `@hermesihq/react` 0.5.0. A read notification has a
  second small button in its row, between the notification and its archive button, that puts it back to unread. An unread one has
  none. Its label names the notification ("Mark as unread: Order shipped", "Marquer comme non lu: ..."); marking unread does not
  open the notification; focus moves to the notification afterwards; a failure is raised as `hermes-error`, like every other action.
- If you query the shadow root or restyle the row: the control is `.herms-inbox__unread-button`. It is not one of the exposed
  parts (the archive button is not either), so `::part` does not reach it; a row now has up to three buttons, not two.
- Needs a Hermesi server from October 2026 or later (the `/unread` route).

## 0.3.0 (2026-10-16)

### Changed

- Requires `@hermesihq/js` `^0.3.0` (it was `^0.2.0`, which does not reach a 0.3 release): without the bump a project that also
  uses `@hermesihq/js` 0.3 would install two copies. Nothing changes for the element: no attribute, event or part was added or
  removed, and the `<script>` bundle behaves as before.

## 0.2.0 (2026-10-04)

### Changed (read this first)

- **The notification list is a list of buttons, not an ARIA menu.** The rows no longer have `role="menu"`, `role="menuitem"` or
  `role="none"`: each row holds two controls, the notification and its archive button, and a menu may own only menu items.
  An automated accessibility check (axe-core) flagged the menu form (`aria-required-children`) and finds nothing in the list
  form. If your tests or styles select `[role="menuitem"]`, select the `item` part or `.herms-inbox__item` instead. Every
  control is now reachable with `Tab`; the arrow keys, `Home` and `End` still move between notifications.

### Changed

- The forced-colours rules for the badge and the unread dot moved into the stylesheet shared with `@hermesihq/react`, so
  both have them. Nothing changes for the element.

## 0.1.0 (2026-10-02)

First release. `<hermes-inbox>`: the bell and panel of `@hermesihq/react`'s `<HermsInbox />`,
as a custom element for any page.

- Attributes `public-key`, `api-base-url`, `placement`, `color-scheme`, `locale`. Properties
  `getSubscriberToken`, `onTokenExpiring` and `session`, which a page sets from script, in any
  order. Until the key, the URL and the token function are all present the bell is disabled and
  no request is made.
- Events `hermes-item-click` (cancelable, like `onItemClick`), `hermes-open`, `hermes-close` and
  `hermes-error`. A failed mutation is reported as `hermes-error`, never left as an unhandled
  rejection. Methods `open()`, `close()` and `refresh()`.
- Themed with the `--herms-*` CSS variables on the element or any ancestor, and `::part`
  (`trigger`, `badge`, `panel`, `item`). Follows the system colour scheme, or is forced with
  `color-scheme`.
- A `<script>`-tag build, `dist/hermes-inbox.global.js` (also `@hermesihq/element/hermes-inbox.global.js`):
  one minified classic script with `@hermesihq/js` and the styles inside, about 37 KB and 12 KB
  gzipped, that registers `<hermes-inbox>` when it runs and exposes
  `HermesInbox.defineHermesInbox`. Its size is held to a budget on every build.
- Needs the Popover API (Chrome 114, Firefox 125, Safari 17). Where it is missing the element
  draws nothing and `HermesInboxElement.isSupported` is `false`.
