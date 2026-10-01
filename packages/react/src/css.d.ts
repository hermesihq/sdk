// Ambient declaration for the stylesheet side-effect import in `HermsInbox.tsx`
// (`@hermesihq/inbox-ui/inbox.css`). This package has no bundler-provided ambient types (no
// Vite/webpack `client.d.ts`; it is built with tsup), so it declares the one shape for itself.
declare module '*.css'
