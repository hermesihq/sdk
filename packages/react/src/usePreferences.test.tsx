import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { HermsClient } from '@hermesihq/js'
import type { HermsPreferences } from '@hermesihq/js'
import { HermsProvider } from './HermsProvider'
import { usePreferences } from './usePreferences'

/**
 * `usePreferences`, and the one decision in it worth pinning: **no optimistic update.**
 *
 * A toggle here is not a like button. Turning off a channel is a consent decision, and
 * showing it as done before the server agreed shows somebody they have opted out when
 * they may not have. The server answers `PATCH` with the whole new state, so the
 * correct view arrives with the write and there is nothing to reconcile.
 *
 * `afterEach(cleanup)` is explicit because this package runs vitest with
 * `globals: false`, so Testing Library never registers its own — without it the second
 * case in a file renders into the first one's DOM and every query finds two of
 * everything.
 */

afterEach(cleanup)

const PREFS: HermsPreferences = {
  firstName: 'Amara',
  globalChannels: [{ channel: 'email', enabled: true }],
  globalEmailEnabled: true,
  globalInAppEnabled: null,
  categories: [
    {
      categoryId: 'cat_1',
      key: 'shipping',
      name: 'Shipping updates',
      isCritical: false,
      channels: [{ channel: 'email', enabled: true }],
      emailEnabled: true,
      inAppEnabled: true,
    },
  ],
}

const OFF: HermsPreferences = {
  ...PREFS,
  globalEmailEnabled: false,
  globalChannels: [{ channel: 'email', enabled: false }],
}

function stubClient(overrides: Partial<HermsClient> = {}) {
  const client = new HermsClient({
    apiBaseUrl: '/v1/client',
    publicKey: 'hm_pk_test',
    getSubscriberToken: () => 'st_test',
  })
  return Object.assign(client, overrides)
}

/** Renders whatever the hook returns, as text a query can read. */
function Harness() {
  const { preferences, isLoading, error, setPreference } = usePreferences()
  return (
    <div>
      <span data-testid="state">
        {isLoading ? 'loading' : error ? `error:${error.message}` : String(preferences?.globalEmailEnabled)}
      </span>
      <button type="button" onClick={() => void setPreference({ channel: 'email', enabled: false }).catch(() => {})}>
        turn email off
      </button>
    </div>
  )
}

function renderWith(client: HermsClient) {
  return render(
    <HermsProvider client={client}>
      <Harness />
    </HermsProvider>,
  )
}

describe('usePreferences', () => {
  it('reports loading, then the settings the server returned', async () => {
    const client = stubClient({ getPreferences: vi.fn().mockResolvedValue(PREFS) })

    renderWith(client)
    expect(screen.getByTestId('state').textContent).toBe('loading')

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('true'))
  })

  it('replaces the whole state from the write, without a second read', async () => {
    // The assertion that fails if somebody "optimises" this into a patch plus a
    // refetch: one read on mount, one write, and no third request.
    const getPreferences = vi.fn().mockResolvedValue(PREFS)
    const updatePreference = vi.fn().mockResolvedValue(OFF)
    const client = stubClient({ getPreferences, updatePreference })

    renderWith(client)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('true'))

    await act(async () => {
      screen.getByRole('button', { name: 'turn email off' }).click()
    })

    expect(screen.getByTestId('state').textContent).toBe('false')
    expect(getPreferences).toHaveBeenCalledTimes(1)
    expect(updatePreference).toHaveBeenCalledWith({ channel: 'email', enabled: false })
  })

  it('shows nothing as changed while the write is in flight', async () => {
    // The point of refusing an optimistic update. The control must not read `false`
    // until the server has said so — a subscriber seeing "off" that then reverts has
    // been told, briefly, that they are opted out of something.
    let settle: (prefs: HermsPreferences) => void = () => {}
    const client = stubClient({
      getPreferences: vi.fn().mockResolvedValue(PREFS),
      updatePreference: vi.fn().mockReturnValue(
        new Promise<HermsPreferences>((resolve) => {
          settle = resolve
        }),
      ),
    })

    renderWith(client)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('true'))

    act(() => {
      screen.getByRole('button', { name: 'turn email off' }).click()
    })
    expect(screen.getByTestId('state').textContent).toBe('true')

    await act(async () => {
      settle(OFF)
    })
    expect(screen.getByTestId('state').textContent).toBe('false')
  })

  it('surfaces a failed read instead of rendering an empty page', async () => {
    const client = stubClient({ getPreferences: vi.fn().mockRejectedValue(new Error('offline')) })

    renderWith(client)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error:offline'))
  })

  it('keeps the last known-good settings when a write fails', async () => {
    // A failed toggle must not blank the page. The host gets the error, the subscriber
    // keeps seeing what is actually true.
    const client = stubClient({
      getPreferences: vi.fn().mockResolvedValue(PREFS),
      updatePreference: vi.fn().mockRejectedValue(new Error('rate limited')),
    })

    renderWith(client)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('true'))

    await act(async () => {
      screen.getByRole('button', { name: 'turn email off' }).click()
    })

    expect(screen.getByTestId('state').textContent).toBe('error:rate limited')
  })

  it('rejects as well as holding the error, so a caller can react per control', async () => {
    const client = stubClient({
      getPreferences: vi.fn().mockResolvedValue(PREFS),
      updatePreference: vi.fn().mockRejectedValue(new Error('nope')),
    })
    let rejected: unknown = null

    function Awaiting() {
      const { setPreference, isLoading } = usePreferences()
      return (
        <button
          type="button"
          disabled={isLoading}
          onClick={() => {
            void setPreference({ channel: 'email', enabled: false }).catch((e: unknown) => {
              rejected = e
            })
          }}
        >
          try
        </button>
      )
    }

    render(
      <HermsProvider client={client}>
        <Awaiting />
      </HermsProvider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'try' })).toHaveProperty('disabled', false))

    await act(async () => {
      screen.getByRole('button', { name: 'try' }).click()
    })

    expect(rejected).toBeInstanceOf(Error)
  })
})
