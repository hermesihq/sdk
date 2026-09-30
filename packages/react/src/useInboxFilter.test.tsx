import type { ReactNode } from 'react'
import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HermsProvider } from './HermsProvider'
import { useInbox } from './useInbox'
import { deferred, harness, page, wireItem } from './test/harness'

/**
 * What changing the filter does to the rows on screen, at the layer a host actually
 * touches.
 *
 * `useInbox.test.tsx` pins that a filter change reloads. It does not pin what is shown
 * *while* it reloads, and that is the difference between a tab switcher that stays put
 * and one that blanks between every tab: the store keeps the previous rows until the new
 * first page arrives, but a binding that recreated the store on a filter change (a
 * dependency list one entry too long) would discard them, and every existing test would
 * still pass. Kept in its own file so the original hook specification stays exactly as it
 * was.
 */

afterEach(cleanup)

describe('changing the filter', () => {
  it('keeps the previous rows on screen, flagged as loading, until the new ones arrive', async () => {
    const held = deferred()
    const { client } = harness((call) =>
      call.query.get('read') === 'false' ? held.promise : page([wireItem('inb_any')]),
    )
    const wrapper = ({ children }: { children: ReactNode }) => <HermsProvider client={client}>{children}</HermsProvider>
    const { result, rerender } = renderHook(({ status }: { status?: 'unread' }) => useInbox({ status }), {
      wrapper,
      initialProps: {} as { status?: 'unread' },
    })
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['inb_any']))

    rerender({ status: 'unread' })

    // A tab switcher that blanked here would flash an empty state between every tab.
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    expect(result.current.items.map((item) => item.id)).toEqual(['inb_any'])

    await act(async () => {
      held.resolve(page([wireItem('inb_unread')]))
    })
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['inb_unread']))
    expect(result.current.isLoading).toBe(false)
  })

  it('hands out the same action functions for as long as the hook is mounted', async () => {
    const { client } = harness(() => page([wireItem('inb_1')], 'cur_2'))
    const wrapper = ({ children }: { children: ReactNode }) => <HermsProvider client={client}>{children}</HermsProvider>
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    const before = result.current

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false))

    // These used to be recreated whenever `isLoadingMore` or `hasMore` changed, so a
    // consumer's `useCallback` or `memo` that listed one re-ran on every page.
    expect(result.current.loadMore).toBe(before.loadMore)
    expect(result.current.markRead).toBe(before.markRead)
    expect(result.current.archive).toBe(before.archive)
  })
})
