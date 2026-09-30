# Hermesi SDK

Client libraries for Hermesi's in-app inbox.

| Package | For | |
|---|---|---|
| [`@hermesihq/js`](packages/js) | Any page: plain JavaScript, Vue, Angular, Svelte, or a server | An API client, and framework-free stores for the unread count, the inbox list and notification preferences |
| [`@hermesihq/react`](packages/react) | React 18 and newer | A ready-made bell and panel, and hooks. A thin binding over `@hermesihq/js` |

```sh
npm install @hermesihq/js      # no framework
npm install @hermesihq/react   # React
```

Each package's README has a working example. The state a UI needs is written once, in
`@hermesihq/js`, as stores with `getSnapshot()` and `subscribe()`. That pair is what React's
`useSyncExternalStore` takes and what other frameworks bridge in a few lines, which is why
`@hermesihq/react` is small and why a binding for another framework would be too.

## Working in this repository

```sh
npm install
npm run typecheck
npm test
npm run verify:package
```

This is an npm workspace. In development, `@hermesihq/react` resolves `@hermesihq/js` to its
**source**, so a change in one is seen by the other's tests immediately, with no build in
between.

`verify:package` does the opposite on purpose. It builds each package, packs it, installs
the tarball into a throwaway project, and imports it under ESM, CommonJS and two TypeScript
module resolutions. Everything else here resolves through this repository's own module graph
and so proves the source works; only this exercises what npm serves. It also fails if a
shipped file carries an internal ticket number or an em dash, if the changelog does not
mention the version being published, or if the package's `repository`, `homepage` and `bugs`
do not point at this repository.

Each package keeps `scripts/expected-exports.json`, the runtime names it must export and no
others. Adding a public export means editing that file, so a change to what a package
promises shows up in its own diff.

## License

MIT
