import { CountsStore, HERMS_CHANNELS, HermsClient, HermsSession, InboxStore, type HermsChannel, type ReadableStore } from '@hermesihq/js'

// Compiled by a throwaway consumer against the installed tarball, under two TypeScript
// module resolutions. It exists to fail if the published type declarations are missing,
// unresolvable, or stop describing the value surface.
const channel: HermsChannel = HERMS_CHANNELS[0]
const client = new HermsClient({ apiBaseUrl: '/v1/client', publicKey: 'hm_pk', getSubscriberToken: () => '' })
const session = new HermsSession(client)
const inbox = new InboxStore(session, { status: 'unread' })
const counts: ReadableStore<{ unread: number }> = new CountsStore(session)
const stop: () => void = inbox.connect()
void channel
void counts
void stop
