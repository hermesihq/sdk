import { HermsClient, HERMS_CHANNELS, type HermsChannel } from '@hermesihq/react'
// The stylesheet import the README asks for. Under `noUncheckedSideEffectImports` it is TS2882 unless the `./styles.css`
// export carries a `types` condition, which is what this is here to catch.
import '@hermesihq/react/styles.css'

// Compiled by a throwaway consumer against the installed tarball, under two TypeScript
// module resolutions. The client surface is imported from `@hermesihq/react` on purpose:
// it is re-exported from `@hermesihq/js`, so this fails if that dependency's declarations
// do not resolve for a consumer who installed only this package.
const channel: HermsChannel = HERMS_CHANNELS[0]
void channel
void new HermsClient({ apiBaseUrl: '/v1/client', publicKey: 'hm_pk', getSubscriberToken: () => '' })
