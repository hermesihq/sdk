# @hermesihq/react

React bindings for Hermesi's in-app inbox: a ready-made bell and panel, and the hooks it is
built on if you would rather build your own.

```sh
npm install @hermesihq/react
```

Requires React 18 or newer. It depends on [`@hermesihq/js`](https://github.com/hermesihq/sdk/tree/main/packages/js),
which npm installs for you. You do not import it yourself unless you want the stores directly.

## Before you start

Three things: a **public key** (`hm_pk_...`, safe to ship in a bundle), your **API base URL
ending in `/v1/client`**, and a **subscriber token minted by your own backend**. The token
proves which subscriber this page acts for. Your backend signs it with your secret key; this
package never sees that key and cannot mint a token. You give the client a function that
asks your backend for a fresh one, and it calls that function before every request.

The base URL is the client API, not the host root: every request is this string plus a path
such as `/inbox`. A base URL without `/v1/client` makes every request a 404.

## Quick start

```tsx
import { HermsClient, HermsInbox, HermsProvider } from '@hermesihq/react'
import '@hermesihq/react/styles.css'

const client = new HermsClient({
  publicKey: 'hm_pk_prod_...',
  apiBaseUrl: 'https://your-hermesi-host/v1/client',
  getSubscriberToken: () => fetch('/api/hermesi-token').then((response) => response.text()), // calls *your* backend
})

export function AppHeader() {
  return (
    <HermsProvider client={client}>
      <HermsInbox />
    </HermsProvider>
  )
}
```

Two lines are easy to miss. The stylesheet import is required: **the bundle does not load its
own CSS**, so without it the panel renders with no styling. And `HermsProvider` must sit above
anything that uses a hook, or the hook throws an error that names the missing provider.

Create the client **once**, at module scope or in a `useMemo`, not on every render. A new
client each render closes and reopens the real-time connection each render.

## `<HermsInbox />`

A real `<button>` with an accessible name that includes the unread count, and a panel that is a named dialog holding a
list of buttons: arrow keys, `Home` and `End` move between notifications (every control is also reachable with `Tab`), and
`Escape` closes it. It is a list and not an ARIA menu because each row holds two controls, the notification and its archive
button, and a menu may own only menu items. Windows high contrast mode is handled: the unseen badge and the unread dot,
which are colour alone, keep an outline and a fill in the user's own colours.

| Prop | Default | |
|---|---|---|
| `placement` | `'bottom-end'` | `'bottom-start'`, `'bottom-end'`, `'top-start'` or `'top-end'` |
| `onItemClick` | | Called with the item when one is activated. Use it to drive your own router. Without it, an item with an `actionUrl` navigates there. Either way the item is marked read first. |
| `theme` | | `{ accent, radius }`, the two most re-themed values |
| `colorScheme` | `'auto'` | `'auto'` follows the visitor's OS setting; `'light'` or `'dark'` force one |
| `locale` | `'en'` | `'en'` or `'fr'` |
| `className` | | Added to the root element **and to the panel**, so one rule themes both |
| `onError` | | Called with an `Error` (a `HermsApiError` when Hermesi refused) when something the person did fails: marking read, marking all read, archiving, or marking seen. The component shows nothing for these, because the list is the source of truth and the next refresh corrects it. Without it the error is logged with `console.error`. Never an unhandled rejection. |

Everything else is reachable by overriding these CSS custom properties: `--herms-color-accent`,
`--herms-color-accent-foreground`, `--herms-color-bg`, `--herms-color-border`,
`--herms-color-danger`, `--herms-color-hover`, `--herms-color-muted`, `--herms-color-surface`,
`--herms-color-text`, `--herms-color-unread-dot`, `--herms-font-family` and `--herms-radius`.
Set them on a rule that matches the `className` you pass: it is applied to the bell and to the
panel. The panel is rendered under `<body>`, not inside the bell, so a rule on an ancestor of the
bell does not reach it. The stylesheet is scoped under `.herms-inbox` and uses no Tailwind, so
your build cannot bleed into the widget or the reverse.

## Hooks

Use these when the bell and panel are not what you want. Same data, no chrome.

| Hook | Returns |
|---|---|
| `useUnreadCount()` | `{ unread, unseen, isLoading }`, kept live |
| `useInbox({ status?, category? })` | `{ items, isLoading, isLoadingMore, error, hasMore, loadMore, markRead, markAllRead, archive, remove, refetch }` |
| `usePreferences()` | `{ preferences, isLoading, error, setPreference, reload }` |

They are a thin binding over the stores in `@hermesihq/js`, which is where the behaviour is
documented. The parts worth knowing here:

- The functions a hook returns keep the same identity for as long as it is mounted, so they
  are safe in a `useCallback` or `memo` dependency list.
- Changing `status` or `category` reloads the list and keeps the previous rows on screen,
  flagged as loading, until the new ones arrive. A response for the old filter that lands
  late is discarded.
- Mutations go to the server first and patch local state with what it answered. A failed one
  rejects.
- `usePreferences` does not update optimistically. Turning off a channel is a consent
  decision, and showing it as done before the server agreed tells somebody they have opted
  out when they may not have.
- A setting of `null` means no preference was expressed and the default applies. It is not
  `false`, and treating them as the same would opt somebody out of something they never
  declined. Categories with `isCritical: true` are always delivered: show them, but not as a
  control.

## Server rendering

Importing this package touches no DOM, and a component using the hooks renders its loading
state on the server. Nothing connects and no request is made until it mounts in the browser.

### Next.js (App Router)

The package is a client module (its entry starts with `'use client'`), so a Server Component can render
`<HermsInbox />` directly. A `HermsClient` holds functions, so it cannot be made in a Server Component and
passed down: make it, and the provider, in a small client component, and keep the pages on the server.

```tsx
// app/providers.tsx
'use client'
import { useMemo, type ReactNode } from 'react'
import { HermsClient, HermsProvider } from '@hermesihq/react'

export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      new HermsClient({
        apiBaseUrl: 'https://your-hermesi-host/v1/client',
        publicKey: 'hm_pk_...',
        getSubscriberToken: async () => (await (await fetch('/api/token')).json()).token, // see below
      }),
    [],
  )
  return <HermsProvider client={client}>{children}</HermsProvider>
}
```

```tsx
// app/layout.tsx: a Server Component
import '@hermesihq/react/styles.css'
import { Providers } from './providers'
// ...wrap {children} in <Providers>

// app/page.tsx: a Server Component, no 'use client' needed
import { HermsInbox } from '@hermesihq/react'
export default function Page() { return <HermsInbox /> }
```

`/api/token` is a Route Handler that mints the subscriber token on your server with
[`@hermesihq/node`](../node); the browser never sees your secret key. A Server Component that needs
`HermsClient`, `HermsApiError`, `HERMS_CHANNELS` or `decodeSubscriberTokenExp` should import them from
`@hermesihq/js`: from this package they arrive as client references. The repository builds exactly this
application against the packed packages with `npm run smoke:next`.

## Also exported

`HermsClient`, `HermsApiError`, `HERMS_CHANNELS` and `decodeSubscriberTokenExp`, with their
types, are re-exported from `@hermesihq/js`, so an existing import from this package keeps
working. Every failed request rejects with a `HermsApiError`; quote its `requestId` in a
support conversation.

## Not included

A rendered preference centre. The headless `usePreferences()` is here; the interface is not,
because it wants a design pass rather than an invention.

## License

MIT
