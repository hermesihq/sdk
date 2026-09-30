import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { HermsClient } from '@hermesihq/js'
import { HermsSession, type HermsStoreHost } from '@hermesihq/js'

/**
 * What every hook in this package reads from context. Exactly the shape the stores take
 * as their host, so a hook hands this straight to the store it creates.
 */
type HermsContextValue = HermsStoreHost

const HermsContext = createContext<HermsContextValue | null>(null)

export interface HermsProviderProps {
  client: HermsClient
  children: ReactNode
}

/**
 * `<HermsProvider client={new HermsClient({...})}>`: one `HermsClient` instance for the
 * whole subtree. Opens the client's real-time subscription once on mount and tears it
 * (and the client's own `onTokenExpiring` timer) down on unmount; every listener
 * registered via `addEventListener` shares that single connection rather than each hook
 * paying for its own.
 *
 * The connection itself is `HermsSession`, which knows nothing about React: this
 * component is the few lines that tie its lifetime to a mount. That is deliberate, and it
 * is the same session a Vue or vanilla page uses.
 *
 * `client` is expected to be a stable reference (constructed once, e.g. in
 * `useMemo`/module scope in the host app). Passing a new instance on every render tears
 * down and reopens the underlying connection every render.
 */
export function HermsProvider({ client, children }: HermsProviderProps) {
  const session = useMemo(() => new HermsSession(client), [client])

  // `connect()` returns its own release, which is the effect's cleanup. Reference-counted
  // in the session, so Strict Mode's connect, release, connect comes out right.
  useEffect(() => session.connect(), [session])

  const value = useMemo<HermsContextValue>(
    () => ({ client, addEventListener: session.addEventListener }),
    [client, session],
  )

  return <HermsContext.Provider value={value}>{children}</HermsContext.Provider>
}

/** Every hook/component in this package throws this same error outside a
 * `<HermsProvider>`: there is no sensible default client to fall back to. */
export function useHermsContext(): HermsContextValue {
  const ctx = useContext(HermsContext)
  if (!ctx) {
    throw new Error('@hermesihq/react: this hook/component must be rendered inside <HermsProvider client={...}>.')
  }
  return ctx
}
