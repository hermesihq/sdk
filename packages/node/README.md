# @hermesihq/node

Server-side client for [Hermesi](https://github.com/hermesihq): publish events and read what became of them, keep your
subscribers in sync, send a direct message, mint subscriber tokens and preference links.
Thin on purpose: it builds the request, sends it with retries, and turns the answer into a typed result or an error. It makes no
decision about notifications; that is the platform's job.

- **Retries** on connection failures, timeouts, `429` (honouring `Retry-After`) and `5xx`, with exponential backoff and jitter.
- **Idempotency built in.** Every event goes out with an `Idempotency-Key` (generated if you give none) that is kept across the
  retries, so a lost response cannot send a notification twice.
- **Typed**, with ESM and CommonJS builds.
- **A test mode** that sends nothing and records what you would have sent.
- No dependencies. Node 20 and later. It uses only `fetch` and Web Crypto, so it has no `node:` imports (a test enforces it). It is
  tested on Node 20, 22 and 24, and in a Next.js Route Handler on both the Node and the Edge runtime; another runtime that has
  `fetch` and Web Crypto should work and is not tested.

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

`{ actor: { externalId, name }, delay: 'PT15M', sendAt: new Date(...), override: {...}, tenant: '...' }`.

### Scheduling

`delay` holds the event back for an ISO 8601 duration (`PT15M`, `PT1H30M`, `P1D`: **not** `15m`) and `sendAt` until an instant
(a `Date`, or an ISO 8601 string with an offset). Give one, not both, at most 30 days ahead. A time already past runs at once. The run starts within about a minute after
its time, not at the second. A request the server cannot honour is refused with `422 invalid_schedule`: it is never sent
immediately instead. Pass your own idempotency key and retrying a scheduled event does not schedule it twice.

`override` and `tenant` are accepted by the API but not acted on yet.

A payload may hold `Date` (sent as ISO text) and `bigint` (sent as a string). Values JSON would lose without telling you are
**refused** before anything is sent: a `Map`, a `Set`, `NaN`, `Infinity`, an invalid `Date`, a function or a symbol. A `Map` that
quietly became `{}` is a template that renders "Hello undefined", found by a customer.

## Read back what became of an event

```ts
const run = await hermesi.events.get(result.eventId)

run.status // 'processed', 'no_workflow' (nothing matched) or 'invalid' (a strict payload schema refused it)
for (const notification of run.notifications) {
  // one per recipient
  notification.externalId, notification.workflow, notification.status
  for (const message of notification.messages) {
    message.channel, message.status, message.provider, message.failureCode
    message.isFinal // true once nothing more will happen to it
  }
}
```

A message's status moves on after the event was accepted (`queued`, `sent`, `delivered`, ...), so poll it rather than treating the
first answer as final. It never returns what was sent or the recipient's address, and an event of another environment is a
`NotFoundError`.

## Keep your subscribers in sync

```ts
await hermesi.subscribers.put('user_8821', {
  email: 'amina@example.cm',
  phoneE164: '+237690000000',
  firstName: 'Amina',
  locale: 'fr',
  timezone: 'Africa/Douala',
  data: { plan: 'pro' },
})
await hermesi.subscribers.put('user_8821', { locale: 'en' }) // only the locale changes: the rest is left alone
await hermesi.subscribers.put('user_8821', { phoneE164: null }) // null clears one field
const profile = await hermesi.subscribers.get('user_8821') // profile, channel identities, stored preference overrides
await hermesi.subscribers.patch('user_8821', { locale: 'fr' }) // like put, but NotFoundError if the subscriber does not exist
await hermesi.subscribers.delete('user_8821') // erase the personal data; idempotent
```

**A field you give is set, `null` clears it, and one you leave out (or set to `undefined`) is left alone**, so a sync job that knows
half a profile does not blank the other half. `data` replaces the stored attributes, up to 32 KB; it is not merged. A field name the
SDK does not know (`phone_e164` instead of `phoneE164`) is a `TypeError` rather than a value silently dropped. The server checks the
shapes (an email looks like one, `phoneE164` is E.164, `locale` a language tag, `timezone` an IANA name) and refuses what it does
not know, as a `ValidationError` naming the field.

`delete` removes the email, phone, names, attributes, channel identities and preferences, and replaces the address on every message
the person received by `[deleted]`, keeping the messages and their status for your statistics. Inbox items, the stored text of
messages and event payloads are **not** erased yet.

```ts
await hermesi.subscribers.registerChannel('user_8821', 'push', deviceToken, { platform: 'android' }) // on every app start
await hermesi.subscribers.removeChannel('user_8821', 'push', deviceToken)

await hermesi.subscribers.updatePreferences('user_8821', {
  global: { sms: false },
  categories: { marketing: { email: false, push: null } },
})
;(await hermesi.subscribers.preferences('user_8821')).categories // { marketing: { email: false } }
```

`registerChannel` refreshes the identity and makes it active again if a provider had marked it invalid; it never duplicates it. In
`updatePreferences`, `true` or `false` sets an override and `null` removes it, so the category's default applies again. It is all or
nothing: an unknown category (`NotFoundError`) or a critical one (`ValidationError`) refuses the whole update.

## Send one message on a channel you choose

Almost everything should be an event: you say what happened and Hermesi decides the channels. When the channel is a requirement
instead (an OTP that must be an SMS), send one message through one template:

```ts
const result = await hermesi.messages.send(
  { channel: 'sms', recipient: 'user_8821', template: 'otp-code', data: { code: '480219' }, category: 'security', priority: 'critical' },
  { idempotencyKey: 'otp-user_8821-482' },
)
result.status // 'queued', or 'skipped' / 'suppressed' if the recipient's preferences or a suppression refused it
result.messages // one per destination: a push to three devices is three messages
;(await hermesi.messages.get(result.messageId)).isFinal
```

It skips the workflow and nothing else: preferences, suppressions and the audit trail still apply, and a refused message is a
result you can read, not an exception. A mistake (an unknown template, a template with no variant for the channel, an unknown
recipient) is thrown and creates nothing. The wording lives in a published template; `data` becomes its `payload.*` and is not kept
once a provider has the message. There is no inline `content`: it would put copy back in your code.

**Pass your own `idempotencyKey` when your code can run twice.** One is generated and kept across the retries if you give none, so a
timeout cannot send a second SMS, but only your own key survives your code running again.

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

`AuthenticationError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409: an idempotency key already used
with another body), `ValidationError` (400, 422; see `.detail`),
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

Writes that are not events (`subscribers.put`, `messages.send`, `registerChannel`, ...) are recorded in `hermesi.simulatedCalls`
(method, path, body, idempotency key) and answered with a plausible result (`status === 'simulated'` for a message). **Reads
(`events.get`, `subscribers.get`, `messages.get`, ...) throw `HermesiSimulationError`**: nothing was sent, so there is nothing to
read, and an invented answer would make a test pass for the wrong reason.

## Not included

Bulk subscriber import (a later phase of Hermesi), the dashboard's Management API (workflows, templates, providers) and inline
`content` for a direct message (Hermesi refuses it on purpose). Outbound webhooks are not implemented in Hermesi yet either, so
there is nothing to verify.

## Development

```sh
npm install        # from the repository root
npm test -w @hermesihq/node
```

`src/live.test.ts` runs the SDK against a real Hermesi and is skipped unless you point it at one; read its header. The other tests
talk to a real HTTP server on localhost rather than a stub of `fetch`.

## License

MIT
