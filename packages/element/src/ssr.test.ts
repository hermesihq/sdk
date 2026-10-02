// @vitest-environment node
import { describe, expect, it } from 'vitest'

/**
 * A page's bundle is evaluated by its server render before it is shown. The module extends
 * `HTMLElement`, which does not exist there, and registers itself with `customElements`, which
 * does not either; neither may throw on import.
 */
describe('on a server', () => {
  it('can be imported with no DOM at all', async () => {
    expect(typeof HTMLElement).toBe('undefined')
    expect(typeof customElements).toBe('undefined')

    const module = await import('./index')

    expect(typeof module.HermesInboxElement).toBe('function')
    expect(() => module.defineHermesInbox('x-another')).not.toThrow()
  })

  it('says it is not supported, rather than throwing, when asked', async () => {
    const { HermesInboxElement } = await import('./index')

    expect(HermesInboxElement.isSupported).toBe(false)
  })
})
