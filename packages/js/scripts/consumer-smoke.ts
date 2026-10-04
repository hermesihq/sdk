import {
  CountsStore,
  HERMS_CHANNELS,
  HermsClient,
  HermsSession,
  HermsWebPushError,
  InboxStore,
  enableWebPush,
  isWebPushSupported,
  type HermsChannel,
  type ReadableStore,
} from '@hermesihq/js'
import { installHermesiPush, type HermesiPushOptions, type ServiceWorkerScopeLike } from '@hermesihq/js/service-worker'

// Compiled by a throwaway consumer against the installed tarball, under two TypeScript
// module resolutions. It exists to fail if the published type declarations are missing,
// unresolvable, or stop describing the value surface.
const channel: HermsChannel = HERMS_CHANNELS[0]
const client = new HermsClient({ apiBaseUrl: '/v1/client', publicKey: 'hm_pk', getSubscriberToken: () => '' })
const session = new HermsSession(client)
const inbox = new InboxStore(session, { status: 'unread' })
const counts: ReadableStore<{ unread: number }> = new CountsStore(session)
const stop: () => void = inbox.connect()
const pushOptions: HermesiPushOptions = { icon: '/icon.png' }
const install: (scope: ServiceWorkerScopeLike) => void = (scope) => installHermesiPush(scope, pushOptions)
const subscribe: () => Promise<PushSubscription> = () => enableWebPush(client, { vapidPublicKey: 'B...' })
const code: string = new HermsWebPushError('unsupported', 'x').code
void install
void subscribe
void code
void isWebPushSupported
void channel
void counts
void stop
