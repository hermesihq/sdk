# @hermesihq/node

Server-side client for [Hermesi](https://github.com/hermesihq): publish events, mint subscriber tokens and preference links.
Thin on purpose: it builds the request, sends it with retries, and turns the answer into a typed result or an error. It makes no
decision about notifications; that is the platform's job.

- **Retries** on connection failures, timeouts, `429` (honouring `Retry-After`) and `5xx`, with exponential backoff and jitter.
- **Idempotency built in.** Every event goes out with an `Idempotency-Key` (generated if you give none) that is kept across the
  retries, so a lost response cannot send a notification twice.
- **Typed**, with ESM and CommonJS builds.
- **A test mode** that sends nothing and records what you would have sent.
- No dependencies. Node 20 and later. It uses only `fetch` and Web Crypto, so it has no `node:` imports (a test enforces it); only
  Node is tested, but nothing in it should stop it running in another runtime that has both.

This is for your **server**: a route handler, a worker, a queue consumer. It holds your secret key. For a page, see
[`@hermesihq/js`](../js); for React, [`@hermesihq/react`](../react).

## Install

```sh
npm install @hermesihq/node
```

## Publish an event

```ts
import { Hermesi } from '@hermesihq/node'

const hermesi = new Hermesi({
  apiKey: process.env.HERMESI_SECRET_KEY, // hm_sk_..., your SECRET key, server side only
  baseUrl: 'https://your-hermesi-host',
})

const result = await hermesi.events.trigger(
  'order.shipped', // <noun>.<past-tense-verb>
  'user_8821', // a subscriber's externalId
  { orderId: '4821', trackingUrl },
  { idempotencyKey: `order-${order.id}-shipped` }, // see below
)
console.log(result.eventId, result.status) // evt_..., accepted
```

`202` means the event is recorded and queued. Nothing has been delivered yet: watch the Activity Log in the dashboard.

`recipient` is a subscriber's `externalId`, a subscriber described inline (created or updated on the fly), or an array of up to 100
of either:

```ts
await hermesi.events.trigger('order.shipped', { externalId: 'cust_331', email: 'a@example.cm', locale: 'fr' }, { orderId: '4821' })
```

The client reads `HERMESI_SECRET_KEY` and `HERMESI_BASE_URL` from the environment if you do not pass them.

### Idempotency: pass your own key when your code can run twice

The SDK generates a key per call and reuses it across its own retries, which covers a lost response. It cannot cover **your** code
running twice for the same thing (a webhook handler that is retried, a queue consumer that redelivers): the second run generates a
new key. For that, give the event a key derived from what happened, such as `order-4821-shipped`. Replaying a key with the same
body within 24 hours returns the original answer, and `result.replayed` is `true`.

### Other options

`{ actor: { externalId, name }, delay: '15m', sendAt: new Date(...), override: {...}, tenant: '...' }`.

A payload may hold `Date` (sent as ISO text) and `bigint` (sent as a string). Values JSON would lose without telling you are
**refused** before anything is sent: a `Map`, a `Set`, `NaN`, `Infinity`, an invalid `Date`, a function or a symbol. A `Map` that
quietly became `{}` is a template that renders "Hello undefined", found by a customer.

## Subscriber tokens

A browser or an app talks to Hermesi's client API as one subscriber, with a token minted on **your** server:

```ts
const token = await hermesi.tokens.mint('user_8821', { environmentId: 'env_01...' }) // valid for an hour at most
// hand it to your frontend, which sends it with the public key
```

`environmentId` is the `env_...` id shown in the dashboard; the key itself does not carry it. Minting makes no request. It is
asynchronous because it uses Web Crypto. Also available on its own: `import { mintSubscriberToken } from '@hermesihq/node'`.

## Preference links

```ts
const link = await hermesi.subscribers.preferenceLink('user_8821')
link.url // a hosted page that needs no login and works for about a year
```

## Errors

```ts
import { HermesiAPIError, HermesiConnectionError, NotFoundError, RateLimitError } from '@hermesihq/node'

try {
  await hermesi.events.trigger('order.shipped', 'user_8821', { orderId })
} catch (error) {
  if (error instanceof NotFoundError) {
    // that recipient is not a subscriber in this environment
  } else if (error instanceof RateLimitError) {
    error.retryAfter // seconds the server asked to wait (it was too long to wait out)
  } else if (error instanceof HermesiAPIError) {
    error.code, error.requestId // branch on `code`; quote `requestId` to whoever runs Hermesi
  } else if (error instanceof HermesiConnectionError) {
    // could not reach Hermesi, after the retries
  } else {
    throw error
  }
}
```

`AuthenticationError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ValidationError` (400, 422; see `.detail`),
`RateLimitError` (429) and `ServerError` (5xx) all extend `HermesiAPIError`, which extends `HermesiError`. Branch on the class or on
`code`, never on `message`. A response that is not the API's error envelope has `type === 'sdk_error'` and
`code === 'unexpected_response'`, which the API never sends.

A mistake in how you call it (a public key, a missing name, a payload that cannot be sent) is a `TypeError` or `RangeError`, thrown
as a rejection like the rest.

### Retries

```ts
new Hermesi({ retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8000, maxRetryAfterMs: 30000 } }) // these are the defaults
new Hermesi({ retry: { maxRetries: 0 } }) // no retrying
```

A `Retry-After` is waited out exactly, up to `maxRetryAfterMs`; a server that asks for more gets its error rejected, because a
request handler that sleeps for ten minutes is worse than one that fails. Each attempt has its own `timeoutMs` (default 30 s).

Redirects are not followed: one would turn the POST into a GET and lose the event. Use the `https://` address of your Hermesi.

## Next.js and other frameworks

Use it in a route handler, a server action or a worker, never in a client component: the key must not reach a browser.

```ts
// app/api/subscriber-token/route.ts
import { Hermesi } from '@hermesihq/node'

const hermesi = new Hermesi() // HERMESI_SECRET_KEY and HERMESI_BASE_URL

export async function GET() {
  const user = await currentUser() // your own auth
  const token = await hermesi.tokens.mint(user.id, { environmentId: process.env.HERMESI_ENVIRONMENT_ID! })
  return Response.json({ token })
}
```

## Testing your code

```ts
const hermesi = new Hermesi({ simulate: true }) // no key, no URL, no network
await hermesi.events.trigger('order.shipped', 'user_1', { orderId: '4821' })

hermesi.simulated[0].name // 'order.shipped'
hermesi.simulated[0].payload // { orderId: '4821' }, as it would have been sent
```

A simulated call validates and serialises exactly as a real one does, so a payload that would fail in production fails in your
test. It does not know your workflows: it cannot tell you whether an event matches one. To control `fetch` yourself, pass
`{ fetch }`.

## Not included

There is no method for messages or subscribers beyond the preference link, because Hermesi's secret-key API does not have them yet:
those are the dashboard's (Management) API. Outbound webhooks are not implemented in Hermesi yet either, so there is nothing to
verify.

## Development

```sh
npm install        # from the repository root
npm test -w @hermesihq/node
```

`src/live.test.ts` runs the SDK against a real Hermesi and is skipped unless you point it at one; read its header. The other tests
talk to a real HTTP server on localhost rather than a stub of `fetch`.

## License

MIT
