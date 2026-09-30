# @hermesihq/js

Hermesi's in-app inbox for any page, with no framework required. An API client, and the
stores that hold the state a UI renders: the unread count, the list, and a subscriber's
notification preferences.

If you use React, install [`@hermesihq/react`](https://github.com/hermesihq/sdk/tree/main/packages/react) instead, which is a binding over this
package with ready-made hooks and a bell-and-panel component.

```sh
npm install @hermesihq/js
```

No runtime dependencies. It imports and runs on a server as well as in a browser. Where
there is no `EventSource`, it polls for new items instead of streaming them.

## Before you start

Two things come from your Hermesi project, and one from your own backend.

- **A public key** (`hm_pk_...`). It is safe to ship in a browser bundle and grants nothing
  on its own.
- **Your API base URL**, ending in `/v1/client`. This is the client API, not the host root:
  every request is this string plus a path such as `/inbox`.
- **A subscriber token, minted by your backend.** It proves which subscriber this page is
  acting for. Your backend signs it with your secret key; this package never sees that
  key, and cannot mint one. You give the client a `getSubscriberToken` function that asks
  your backend for a fresh token, and it calls that function before every request.

## An unread badge, in plain JavaScript

This is the whole thing: a badge that shows the unread count and stays current. It is a
real file in this repository, [`examples/unread-badge.ts`](https://github.com/hermesihq/sdk/blob/main/packages/js/examples/unread-badge.ts), and
the test suite runs it.

```ts
import { CountsStore, HermsClient, HermsSession } from '@hermesihq/js'

/**
 * Shows the unread count in a badge and keeps it live. Returns the function that stops it.
 */
export function mountUnreadBadge(
  badge: { textContent: string | null },
  getSubscriberToken: () => Promise<string>,
): () => void {
  const client = new HermsClient({
    publicKey: 'hm_pk_prod_...',
    apiBaseUrl: 'https://your-hermesi-host/v1/client',
    getSubscriberToken, // calls *your* backend, which mints the token
  })
  const session = new HermsSession(client)
  const counts = new CountsStore(session)

  const render = () => {
    const { unread } = counts.getSnapshot()
    badge.textContent = unread > 0 ? String(unread) : ''
  }

  const stopRendering = counts.subscribe(render)
  const closeStream = session.connect()
  const stopCounts = counts.connect()
  render()

  return () => {
    stopCounts()
    closeStream()
    stopRendering()
  }
}
```

Three objects, and each does one job:

- **`HermsClient`** talks to the API.
- **`HermsSession`** owns the one real-time connection and shares it. A badge, an open
  panel and a preferences page listening through one session cost one connection between
  them, not three.
- **`CountsStore`** holds the state. `subscribe(listener)` tells you when it changed,
  `getSnapshot()` gives you the current value, and `connect()` starts it and returns the
  function that stops it.

## The stores

| Store | Holds | Notable methods |
|---|---|---|
| `CountsStore` | `{ unread, unseen, isLoading }` | `connect()` |
| `InboxStore` | `{ items, isLoading, isLoadingMore, error, hasMore }` | `loadMore()`, `markRead(id)`, `markAllRead()`, `archive(id)`, `remove(id)`, `refetch()`, `setFilter({ status, category })` |
| `PreferencesStore` | `{ preferences, isLoading, error }` | `setPreference(update)`, `reload()` |

Every store has the same three things, which is what makes one easy to bind to anything:

- `getSnapshot()` returns an immutable object. It is the same object until something in it
  changes, so comparing with `Object.is` is a correct "did it change" check.
- `subscribe(listener)` returns the function that unsubscribes. The listener takes no
  arguments; read `getSnapshot()` inside it.
- `connect()` starts loading and listening, and returns the function that stops. It is safe
  to call again after stopping, which is what a framework's development-mode double mount
  does.

The `getSnapshot` and `subscribe` pair is exactly what React's `useSyncExternalStore` takes,
and what a Vue `shallowRef`, an Angular signal or a Svelte store are each bridged from in a
few lines. `@hermesihq/react` is that binding for React.

### What the stores guarantee

- **A result and its loading flag change in the same update.** A subscriber that renders on
  every change never sees "failed and still loading".
- **A late response is discarded.** If the list was reloaded, the filter changed or the
  store was disconnected while a request was in flight, its answer is dropped instead of
  being written into a list it no longer belongs to.
- **Mutations go to the server first.** `archive`, `markRead` and the rest patch local state
  with what the server answered, and a failed one rejects. The SDK reflects the server's
  decisions; it does not make them.
- **Preferences are not updated optimistically.** Turning off a channel is a consent
  decision, and showing it as done before the server agreed tells somebody they have opted
  out when they may not have.
- **A listener that throws does not break the others.** The error is re-raised on a fresh
  microtask so your error reporting still sees it.

## Errors

Every failed request rejects with a `HermsApiError`, carrying the API's `type`, `code`,
`message`, `requestId`, `detail` and `docUrl`. Quote `requestId` in a support conversation.
A response that is not JSON, such as a proxy's error page, arrives as a `HermsApiError` too,
not as a `TypeError` from inside the SDK.

## Registering a channel

```ts
await client.registerChannel({ channel: 'telegram', identifier: '1755765234' })
await client.deregisterChannel('telegram', '1755765234')
```

`HERMS_CHANNELS` lists every channel an identity can be registered for, as an array a
preference centre can iterate.

## What is deliberately absent

There is no `unsubscribe()`, although the API has an unsubscribe route. That route is the
target of a `List-Unsubscribe` one-click link whose token Hermesi puts into an outgoing
email's headers, and it is invoked by a mail client, not by application code. Wrapping it
would invite you to build a button on a token you cannot obtain. The equivalent here is
`updatePreference({ channel: 'email', enabled: false })`.

## License

MIT
