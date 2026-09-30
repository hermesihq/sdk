import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from '@hermesihq/js'
import { HermsProvider } from './HermsProvider'

/**
 * What re-rendering the provider costs, which should be nothing.
 *
 * `HermsProvider.test.tsx` pins that the connection moves when the *client* changes. It
 * never re-renders with the same client, and that is the common case by far: the parent
 * of a provider re-renders for reasons that have nothing to do with notifications, and if
 * each of those closed and reopened the real-time stream, a host would pay a reconnect,
 * and a window in which events are missed, on every keystroke elsewhere in their app.
 * Kept in its own file so the original provider specification stays exactly as it was.
 */

afterEach(cleanup)

describe('re-rendering with the same client', () => {
  it('keeps the connection open instead of reopening it', () => {
    const client = new HermsClient({
      apiBaseUrl: 'https://api.example.test/v1/client',
      publicKey: 'hm_pk_test_abc',
      getSubscriberToken: () => 'st_test',
    })
    const closeStream = vi.fn()
    const subscribe = vi.spyOn(client, 'subscribe').mockReturnValue(closeStream)

    const { rerender } = render(
      <HermsProvider client={client}>
        <span>one</span>
      </HermsProvider>,
    )
    rerender(
      <HermsProvider client={client}>
        <span>two</span>
      </HermsProvider>,
    )
    rerender(
      <HermsProvider client={client}>
        <span>three</span>
      </HermsProvider>,
    )

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(closeStream).not.toHaveBeenCalled()
  })
})
