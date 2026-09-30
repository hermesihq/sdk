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
