import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from '@hermesihq/js'
import type { HermsEventListener } from '@hermesihq/js'
import { HermsProvider } from './HermsProvider'
import { useUnreadCount } from './useUnreadCount'

/**
 * `useUnreadCount` is the smallest thing a host can embed — usually a badge on a bell in
 * a header that is mounted on every page of the app. Two consequences drive these cases:
 *
 *  - it must cost one request on mount and then nothing, updating from the shared
 *    subscription instead of polling on its own, and
 *  - it must never take the header down. A failed count read is a badge that stays at
 *    its last value, not an error boundary on the host's chrome.
 *
 * `globals: false` means Testing Library's auto-cleanup never registers; hence the
 * explicit `afterEach(cleanup)`.
 */

afterEach(cleanup)

interface Harness {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode
  emit: (event: Parameters<HermsEventListener>[0]) => void
  fetchSpy: ReturnType<typeof vi.fn>
}

function harness(respond: () => Response): Harness {
  const fetchSpy = vi.fn(async () => respond())
  vi.stubGlobal('fetch', fetchSpy)

  const client = new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
  // The provider's shared subscription, driven directly: the SSE wire is
  // `realtime.test.ts`'s subject, and what this hook cares about is only the event.
  let listener: HermsEventListener = () => {}
  vi.spyOn(client, 'subscribe').mockImplementation((incoming) => {
    listener = incoming
    return () => {}
  })

  return {
    wrapper: ({ children }) => <HermsProvider client={client}>{children}</HermsProvider>,
    emit: (event) => {
      act(() => listener(event))
    },
    fetchSpy,
  }
}

function counts(unread: number, unseen: number): Response {
  return new Response(JSON.stringify({ unread, unseen }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('useUnreadCount', () => {
  it('reports loading first, then the counts the API returned', async () => {
    const { wrapper } = harness(() => counts(7, 2))

    const { result } = renderHook(() => useUnreadCount(), { wrapper })

    // Zeroes while in flight, not `undefined`: a badge renders this value on the first
    // paint, and `NaN`/`undefined` would flash into the host's header.
    expect(result.current.isLoading).toBe(true)
    expect(result.current.unread).toBe(0)

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    // Unread and unseen are different numbers and mean different things: the
    // badge counts unseen, the accessible label announces unread.
    expect(result.current.unread).toBe(7)
    expect(result.current.unseen).toBe(2)
  })

  it('follows counts.changed without making another request', async () => {
    const { wrapper, emit, fetchSpy } = harness(() => counts(7, 2))
    const { result } = renderHook(() => useUnreadCount(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    fetchSpy.mockClear()

    emit({ type: 'counts.changed', data: { unread: 8, unseen: 3 } })

    // The server sends the new counts in the frame, so re-reading `/inbox/counts` here
    // would be a request per notification per open tab, the exact load the stream
    // exists to avoid.
    expect(result.current.unread).toBe(8)
    expect(result.current.unseen).toBe(3)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps the badge alive when the first read fails', async () => {
    const { wrapper } = harness(() => new Response(null, { status: 500 }))

    const { result } = renderHook(() => useUnreadCount(), { wrapper })

    // No throw, no rejected promise escaping the effect: this hook is mounted in the
    // host's header, and the header must survive Hermesi being down.
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.unread).toBe(0)
    expect(result.current.unseen).toBe(0)
  })

  it('recovers on the next event after a failed read', async () => {
    const { wrapper, emit } = harness(() => new Response(null, { status: 503 }))
    const { result } = renderHook(() => useUnreadCount(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // The documented recovery path in the hook's own comment: a failed initial read is
    // not a terminal state, because the stream (or the 60s polling fallback) will send
    // the counts again shortly.
    emit({ type: 'counts.changed', data: { unread: 2, unseen: 2 } })

    expect(result.current.unread).toBe(2)
  })
})
