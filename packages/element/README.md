# @hermesihq/element

Hermesi's notification bell and panel as a custom element, `<hermes-inbox>`, for any page: plain
HTML, a server-rendered template, WordPress, Vue, Angular, Svelte. If you use React, use
[`@hermesihq/react`](https://github.com/hermesihq/sdk/tree/main/packages/react) instead; this is
the same inbox, behaving the same way.

```sh
npm install @hermesihq/element
```

It depends on [`@hermesihq/js`](https://github.com/hermesihq/sdk/tree/main/packages/js), which npm
installs for you.

## Before you start

Three things: a **public key** (`hm_pk_...`, safe to ship in a page), your **API base URL ending
in `/v1/client`**, and a **subscriber token minted by your own backend**. The token proves which
subscriber this page acts for. Your backend signs it with your secret key; this package never sees
that key and cannot mint a token. You give the element a function that asks your backend for a
fresh one, and it calls that function before every request.

The base URL is the client API, not the host root: every request is this string plus a path such as
`/inbox`. A base URL without `/v1/client` makes every request a 404.

## Quick start

With no bundler, one `<script>` tag. The file is self-contained (about 37 KB, 12 KB gzipped, with
`@hermesihq/js` and the styles inside) and registers `<hermes-inbox>` when it runs. Pin a version
in production.

```html
<script src="https://cdn.jsdelivr.net/npm/@hermesihq/element@0.1/dist/hermes-inbox.global.js"></script>
<hermes-inbox public-key="hm_pk_prod_..." api-base-url="https://your-hermesi-host/v1/client"></hermes-inbox>

<script>
  document.querySelector('hermes-inbox').getSubscriberToken = () =>
    fetch('/api/hermesi-token').then((response) => response.text()) // calls *your* backend
</script>
```

Where the script sits does not matter: a tag already in the page is upgraded when the script runs,
including one whose `getSubscriberToken` was set before it did. The same file is
`@hermesihq/element/hermes-inbox.global.js` for anything that resolves package paths. It also
exposes `HermesInbox.defineHermesInbox('your-tag')` if you want the element under another name.

With a bundler, import it instead:

```html
<hermes-inbox public-key="hm_pk_prod_..." api-base-url="https://your-hermesi-host/v1/client"></hermes-inbox>

<script type="module">
  import '@hermesihq/element' // registers <hermes-inbox>

  document.querySelector('hermes-inbox').getSubscriberToken = () =>
    fetch('/api/hermesi-token').then((response) => response.text()) // calls *your* backend
</script>
```

`getSubscriberToken` is a function, so it is a property and cannot be an attribute. The element
carries its own styles; there is no stylesheet to import.

Everything can arrive in any order. Until the key, the URL and the token function are all present,
the bell is drawn disabled and nothing is requested. Changing the key or the URL builds a new
client. Moving the element elsewhere in the page does not reload anything.

## Attributes and properties

| Attribute | Values | Default |
|---|---|---|
| `public-key`, `api-base-url` | as above | required |
| `placement` | `bottom-start`, `bottom-end`, `top-start`, `top-end` | `bottom-end` |
| `color-scheme` | `auto` follows the visitor's system; `light` or `dark` forces one | `auto` |
| `locale` | `en`, `fr` | `en` |

Each attribute is also a property (`publicKey`, `apiBaseUrl`, `placement`, `colorScheme`,
`locale`). `start` and `end` are logical: in a right-to-left page they swap sides. The panel
flips to the other side when there is no room, and stays inside the viewport.

| Property | |
|---|---|
| `getSubscriberToken` | Required. `() => string \| Promise<string>`, called before every request. |
| `onTokenExpiring` | Optional. Called shortly before the held token expires, so the page can refresh it. |
| `session` | Advanced. An existing `HermsSession` from `@hermesihq/js`, to share one connection and the same stores with the rest of the page. When set, the key, URL and token function are its client's. |

## Events

All bubble. Listen on the element or on any ancestor.

| Event | `detail` | |
|---|---|---|
| `hermes-item-click` | `{ item }` | **Cancelable.** The notification is marked read first. If a listener calls `preventDefault()` the element does not navigate; otherwise it goes to `item.actionUrl`, if there is one. Use it to hand the click to your router. |
| `hermes-open`, `hermes-close` | | The panel opened or closed. |
| `hermes-error` | `{ error }` | A load or an action failed. Nothing is thrown at the page. |

```js
inbox.addEventListener('hermes-item-click', (event) => {
  event.preventDefault()
  router.push(event.detail.item.actionUrl)
})
```

Methods: `open()`, `close()` and `refresh()` (loads the first page again). `isOpen` says whether
the panel is open.

## Styling

The look is driven by CSS variables, set on the element or any ancestor:

```css
hermes-inbox {
  --herms-color-accent: #0a7;
  --herms-radius: 6px;
}
```

`--herms-color-accent`, `-accent-foreground`, `-bg`, `-border`, `-danger`, `-hover`, `-muted`,
`-surface`, `-text`, `-unread-dot`, `--herms-font-family` and `--herms-radius`. Four parts are
exposed for anything the variables do not reach: `trigger`, `badge`, `panel` and `item`
(`hermes-inbox::part(badge) { ... }`). Nothing else is reachable on purpose: a part is a public API.

The element lives in a shadow root, so your page's CSS cannot break it and its CSS cannot leak.

## Browser support

It needs the [Popover API](https://developer.mozilla.org/docs/Web/API/Popover_API): Chrome 114,
Firefox 125, Safari 17. In a browser without it the element draws nothing, and
`HermesInboxElement.isSupported` is `false`. Importing the package on a server does not throw.

The panel is drawn in the browser's top layer, so a clipping or transformed ancestor does not cut it
off, and a modal `<dialog>` on your page does not hide it.

## Accessibility

The bell is a real button named "Notifications, N unread", with `aria-expanded`, and a polite live
region announces count changes. The panel is a named, non-modal dialog. Arrow Up and Down, Home and
End move between notifications; Enter and Space open one; Escape closes the panel and returns the
focus to the bell; moving the focus out of the element closes it too. The stylesheet has forced-colors
rules for the badge and the unread dot, which are colour alone otherwise; they are checked in an
emulated high-contrast setup in Chromium and Firefox, not on Windows itself.

The list is a plain list of buttons, as in `@hermesihq/react`, and not an ARIA menu: each row holds two
controls, the notification and its archive button, and a menu may own only menu items. This was
measured with an automated checker (axe-core), which flagged the menu form in the element and finds
nothing in the list form; it has not been tried with a real screen reader.

## What it does not do

No preferences screen, no categories or grouping, no slots, no fallback for a browser without the
Popover API, and no server-side rendering of its contents.
