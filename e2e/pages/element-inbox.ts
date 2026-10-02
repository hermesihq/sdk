import '@hermesihq/element'

/**
 * The published element, configured from the query string so a test is one URL. The same
 * parameters as `react-inbox.tsx`, where they mean the same thing, plus:
 *
 *   manual=1    create the element and leave it unconfigured, as `window.inbox`, for a test that
 *               supplies the pieces itself and in a chosen order
 *   prevent=1   cancel every `hermes-item-click`, as a host with its own router does
 *
 * Everything the element reports is kept on `window.events`.
 */
const params = new URLSearchParams(location.search)
const tenant = params.get('tenant')
if (!tenant) throw new Error('the page needs ?tenant=')

if (params.get('clip') === '1') {
  const clip = document.getElementById('clip')!
  Object.assign(clip.style, { overflow: 'hidden', transform: 'translateZ(0)', width: '120px', height: '48px', border: '2px solid red' })
}
const vars = params.get('vars')
if (vars) document.documentElement.setAttribute('style', vars)
if (params.get('tall') === '1') document.getElementById('filler')!.style.height = '2400px'
const dir = params.get('dir')
if (dir) document.documentElement.dir = dir

const element = document.createElement('hermes-inbox')
const events: string[] = []
;(window as unknown as { inbox: HTMLElement; events: string[] }).inbox = element
;(window as unknown as { events: string[] }).events = events
for (const name of ['hermes-open', 'hermes-close', 'hermes-error', 'hermes-item-click']) {
  element.addEventListener(name, (event) => {
    events.push(name)
    if (name === 'hermes-item-click' && params.get('prevent') === '1') event.preventDefault()
  })
}

const scheme = params.get('scheme')
if (scheme) element.setAttribute('color-scheme', scheme)
const placement = params.get('placement')
if (placement) element.setAttribute('placement', placement)
const locale = params.get('locale')
if (locale) element.setAttribute('locale', locale)
// There is no `theme` property: a host sets the variables on the element, which is what this does.
const accent = params.get('accent')
if (accent) element.style.setProperty('--herms-color-accent', accent)
const radius = params.get('radius')
if (radius) element.style.setProperty('--herms-radius', radius)

if (params.get('manual') !== '1') {
  element.setAttribute('public-key', 'hm_pk_e2e')
  element.setAttribute('api-base-url', `${location.origin}/t/${tenant}/v1/client`)
  ;(element as unknown as { getSubscriberToken: () => string }).getSubscriberToken = () => 'st_e2e'
}
document.getElementById('root')!.append(element)
