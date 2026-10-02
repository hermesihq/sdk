import { HermesInboxElement, defineHermesInbox, type HermesErrorDetail, type HermesItemClickDetail } from '@hermesihq/element'

// Compiled by a throwaway consumer against the installed tarball, under two TypeScript module
// resolutions. It fails if the declarations do not resolve for someone who installed only this
// package, which includes the types it re-exports and the global tag-name map it declares.
const inbox = document.createElement('hermes-inbox')
const same: HermesInboxElement = inbox
void same

inbox.placement = 'top-end'
inbox.colorScheme = 'dark'
inbox.locale = 'fr'
inbox.publicKey = 'hm_pk'
inbox.apiBaseUrl = '/v1/client'
inbox.getSubscriberToken = () => 'token'
inbox.onTokenExpiring = () => {}
inbox.open()
inbox.close()
inbox.refresh()

inbox.addEventListener('hermes-item-click', (event) => {
  const detail: HermesItemClickDetail = (event as CustomEvent<HermesItemClickDetail>).detail
  void detail.item.id
})
inbox.addEventListener('hermes-error', (event) => {
  const detail: HermesErrorDetail = (event as CustomEvent<HermesErrorDetail>).detail
  void detail.error.message
})

defineHermesInbox('x-notifications')
const supported: boolean = HermesInboxElement.isSupported
void supported
