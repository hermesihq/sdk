import {
  Hermesi,
  HermesiAPIError,
  NotFoundError,
  mintSubscriberToken,
  type EventResult,
  type FetchLike,
  type RetryOptions,
  type Subscriber,
} from '@hermesihq/node'

// Compiled by a throwaway consumer against the installed tarball, under two TypeScript module
// resolutions. It exists to fail if the published type declarations are missing, unresolvable, or
// stop describing the value surface. The consumer has no `lib` set, so this also proves the types
// do not need more than the default.
const retry: RetryOptions = { maxRetries: 2, baseDelayMs: 100 }
const hermesi = new Hermesi({ apiKey: 'hm_sk_x', baseUrl: 'https://hermesi.example', retry })
const recipient: Subscriber = { externalId: 'user_1', email: 'a@example.test' }
const send: () => Promise<EventResult> = () =>
  hermesi.events.trigger('order.shipped', [recipient, 'user_2'], { orderId: '1' }, { idempotencyKey: 'k', sendAt: new Date() })
const link: () => Promise<string> = async () => (await hermesi.subscribers.preferenceLink('user_1')).url
const mint: () => Promise<string> = () => hermesi.tokens.mint('user_1', { environmentId: 'env_1' })
const own: FetchLike = (url, init) => fetch(url, init)
const handle = (error: unknown): string | undefined =>
  error instanceof NotFoundError ? error.code : error instanceof HermesiAPIError ? error.requestId : undefined
void send
void link
void mint
void own
void handle
void mintSubscriberToken
