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

## 0.1.0 (unreleased)

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
- Needs the Popover API (Chrome 114, Firefox 125, Safari 17). Where it is missing the element
  draws nothing and `HermesInboxElement.isSupported` is `false`.
