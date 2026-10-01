// Declared here, in the test pages, because the package does not declare it for its consumers.
// TypeScript 6 checks side-effect imports, and `import '@hermesihq/react/styles.css'` (which the
// README tells every integrator to write) has no type declaration to find. Vite and Next supply
// one themselves, so those projects never notice; a bare TypeScript project does. The real fix is
// in the package's `exports`, not here.
declare module '@hermesihq/react/styles.css'
