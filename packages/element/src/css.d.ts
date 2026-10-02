// Stylesheets are imported as text (`tsup` and the test config both turn a `.css` import into its
// contents), so the default export is a string.
declare module '*.css' {
  const css: string
  export default css
}
