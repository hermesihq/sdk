// Ambient module declaration for the one CSS side-effect import in this
// package (`HermsInbox.tsx` importing `./HermsInbox.css`). This package has
// no bundler-provided ambient types (no Vite/webpack `client.d.ts`, since it
// isn't built with either itself; see `package.json`'s own doc comment) so
// it declares this one shape for itself instead.
declare module '*.css'
