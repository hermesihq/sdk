import { createRoot } from 'react-dom/client'
import { HermsClient, HermsInbox, HermsProvider, type HermsInboxProps } from '@hermesihq/react'
import '@hermesihq/react/styles.css'

/**
 * The published component, configured entirely from the query string so a test is one URL.
 *
 *   tenant      required: which isolated inbox on the mock server this page talks to
 *   scheme      auto | light | dark          (the `colorScheme` prop)
 *   accent, radius                           (the `theme` prop)
 *   className                                (the host's class)
 *   placement, locale
 *   clip=1      wrap it in an ancestor that clips and is transformed
 *   tall=1      make the page scrollable
 */
const params = new URLSearchParams(location.search)
const tenant = params.get('tenant')
if (!tenant) throw new Error('the page needs ?tenant=')

if (params.get('clip') === '1') {
  const clip = document.getElementById('clip')!
  Object.assign(clip.style, { overflow: 'hidden', transform: 'translateZ(0)', width: '120px', height: '48px', border: '2px solid red' })
}
if (params.get('tall') === '1') document.getElementById('filler')!.style.height = '2400px'

const client = new HermsClient({
  publicKey: 'hm_pk_e2e',
  apiBaseUrl: `${location.origin}/t/${tenant}/v1/client`,
  getSubscriberToken: () => 'st_e2e',
})

const props: HermsInboxProps = {}
const scheme = params.get('scheme')
if (scheme === 'light' || scheme === 'dark' || scheme === 'auto') props.colorScheme = scheme
const accent = params.get('accent')
const radius = params.get('radius')
if (accent || radius) props.theme = { ...(accent ? { accent } : {}), ...(radius ? { radius } : {}) }
const className = params.get('className')
if (className) props.className = className
const placement = params.get('placement') as HermsInboxProps['placement'] | null
if (placement) props.placement = placement
const locale = params.get('locale')
if (locale === 'en' || locale === 'fr') props.locale = locale

// Anything an unhandled rejection says is recorded, so a test can assert on it.
;(window as unknown as { rejections: string[] }).rejections = []
window.addEventListener('unhandledrejection', (event) => {
  ;(window as unknown as { rejections: string[] }).rejections.push(String(event.reason?.code ?? event.reason))
})

createRoot(document.getElementById('root')!).render(
  <HermsProvider client={client}>
    <HermsInbox {...props} />
  </HermsProvider>,
)
