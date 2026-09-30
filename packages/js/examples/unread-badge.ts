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
