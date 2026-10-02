# `<hermes-inbox>`: design

**Status: steps 0 to 3 are implemented; step 4 (the `<script>`-tag bundle, size budget and publish)
is not. Sections 1 to 9 are the design as proposed; the corrections that came from building it are
collected in section 10.**

A custom element that gives any page the bell and panel that `@hermesihq/react` gives a React
app: plain HTML, a server-rendered template, WordPress, Vue, Angular, Svelte.

```html
<script src="https://cdn.jsdelivr.net/npm/@hermesihq/element/dist/hermes-inbox.global.js"></script>
<hermes-inbox public-key="hm_pk_..." api-base-url="https://your-hermesi-host/v1/client"></hermes-inbox>
<script>
  document.querySelector('hermes-inbox').getSubscriberToken = () =>
    fetch('/api/hermesi-token').then((response) => response.text())
</script>
```

## 1. Why this is not "port the React component"

The React component is 300 lines, and a good part of what it does is Radix doing work the
element has to do itself: positioning the panel, getting it out from under clipping
ancestors, closing it (Escape, outside click, focus leaving), and returning focus to the bell.
Writing that a second time next to the first is the situation this repository has been bitten
by most: two copies of the same logic that drift apart. Everything below is shaped by
avoiding that, and by measuring the platform before relying on it.

## 2. What I measured

Everything in this section was observed, not recalled. **Chromium 152 only.** Firefox and
Safari were not tested, and screen readers were not tested at all.

### The platform (a prototype: a shadow root holding a button and a `[popover]` panel, inside an ancestor with `overflow: hidden` and a `transform`)

| Question | Result |
|---|---|
| Does `popoverTargetElement` work from inside a shadow root? | Yes. |
| Does a trusted click open it, and does `toggle` fire so `aria-expanded` can follow? | Yes, with `beforetoggle` and `toggle`. |
| Does the panel escape the clipping, transformed ancestor? | **Yes.** It extended past the ancestor and was hit-testable on top: it is in the top layer. |
| Does Escape close it? | Yes. |
| Does a click outside close it? | Yes. |
| Does clicking the bell while open close it, without reopening? | Yes: exactly one `open to closed`. |
| **Does focus return to the bell when it closes?** | **No.** After Escape nothing in the shadow root was focused. |
| **Does the panel follow the bell when the page scrolls?** | **No.** After scrolling the page from 40 to 300 px the bell was at `top: -210` and the panel was still at `top: 79`, still open. |
| Does CSS anchor positioning exist? | In this Chromium, yes. Not verified elsewhere, so not relied on. |

### The test runner (jsdom 29.1.1)

| Feature | In jsdom |
|---|---|
| Custom elements, `attachShadow`, constructable stylesheets, `attachInternals` | Yes |
| **Popover API** (`showPopover`, `hidePopover`, `popoverTargetElement`) | **No** |
| `ResizeObserver` | No |

So everything the platform does for us (top layer, light dismiss, Escape) is invisible to the
unit tests, and has to be checked in a real browser.

## 3. A defect found on the way: the React panel loses its theme

Measured on the published `@hermesihq/react` 0.2.0, on a page with no other CSS. Radix renders
the panel in a portal under `<body>`, so it is not inside `.herms-inbox`, and every `--herms-*`
variable is defined only on `.herms-inbox`:

| Panel property | Measured | Intended |
|---|---|---|
| background | `rgba(0, 0, 0, 0)` | `--herms-color-surface` |
| border | `0px none` | 1px `--herms-color-border` |
| border radius | `0px` | `--herms-radius` |
| text colour | black, also in dark mode | `--herms-color-text` |

Only the box shadow, a literal value, survives. The `theme` and `colorScheme` props put their
values on `.herms-inbox`, so **they can never reach the panel**. jsdom has no real cascade, which
is why 58 tests did not notice.

This is a bug in the React component and has its own fix (section 8, step 0). It matters here
because a Shadow DOM element does not have it by construction: bell and panel share one root.

## 4. Decisions

Each has a recommendation. The first three are the ones I would like you to decide.

### D1. Where does it live? **New package `@hermesihq/element`.**

`@hermesihq/js` promises that importing it touches no DOM, and a custom element evaluates
`HTMLElement` at module scope. A subpath export would keep the promise only by discipline. A
separate package also gets its own changelog, its own size budget and the browser bundle.
It depends on `@hermesihq/js` and nothing else.

### D2. How is UI logic shared with React? **A private workspace package, bundled into both.**

Today the pieces that are not about React or the DOM live inside `HermsInbox.tsx`: the
English and French strings, relative time, the `99+` clamp, the "mark what was displayed as
seen" tracking, the arrow-key index arithmetic, and the stylesheet.

* **Recommended:** move them into a private (unpublished) workspace package, `@hermesihq/inbox-ui`,
  that `tsup` bundles into `@hermesihq/react` and `@hermesihq/element` (`noExternal`). No new package
  for consumers, one copy of the strings, the logic and the CSS. React is refactored onto it,
  behaviour-preserving and guarded by its existing tests, the same way the hooks were moved
  onto the stores.
* **Alternative:** duplicate them and rely on tests to catch drift. Cheaper now. The strings and the
  CSS are exactly what tests do not catch.

The markup itself (JSX in one, DOM code in the other) stays two implementations either way,
which is why section 7 adds a parity check.

### D3. Shadow DOM or light DOM? **Open shadow root.**

* Host-page CSS cannot break it, which is the same goal the React stylesheet states for Tailwind.
* Bell and panel share a root, so the theming defect in section 3 cannot happen.
* The `--herms-*` variables inherit across the boundary, so a host themes it with
  `hermes-inbox { --herms-color-accent: #0a7; }`. No theme attributes are needed.
* The cost: `find`-style tooling and Testing Library do not pierce it (queries need
  `within(element.shadowRoot)`), and ARIA ID references cannot cross the boundary. Everything the
  element references lives inside its own root, so this is a constraint and not a problem.

### D4. How does the panel work? **Native `popover="auto"`, positioned in JavaScript.**

The alternative to the top layer is a panel appended to `<body>` with a z-index, which loses
to any `<dialog>` the host page opens: an inbox in a modal would be hidden under its own page.

From section 2, what we must supply ourselves:

1. **Focus return** to the bell when the panel closes.
2. **Repositioning** on scroll and resize while open. Four placements (`bottom-end` by default),
   flip when there is no room, clamp to the viewport, and logical start/end so right-to-left
   pages mirror correctly. One JavaScript path, not anchor positioning with a fallback.
3. **Close when focus leaves.** Radix does this and the Popover API does not (it light-dismisses
   on clicks and Escape only). Without it, tabbing out of the panel leaves it open over the page.
4. First item focused on open, `aria-expanded` kept in step by the `toggle` event.

Open question: **no fallback for a browser without the Popover API.** My recollection is that
all three engines have shipped it for more than two years, but I have not checked that; the CI
matrix in section 7 will. I recommend no fallback in v1 and a static `HermesInbox.isSupported`.
A second code path is a second thing to keep correct.

### D5. The API surface

```html
<hermes-inbox
  public-key="hm_pk_..."
  api-base-url="https://your-hermesi-host/v1/client"
  placement="bottom-end"
  color-scheme="auto"
  locale="en"
></hermes-inbox>
```

| Attribute | Values | Default |
|---|---|---|
| `public-key`, `api-base-url` | as in `HermsClientOptions`; the URL ends in `/v1/client` | required |
| `placement` | `bottom-start`, `bottom-end`, `top-start`, `top-end` | `bottom-end` |
| `color-scheme` | `auto`, `light`, `dark` | `auto` |
| `locale` | `en`, `fr` | `en` |

| Property | |
|---|---|
| `getSubscriberToken` | Required, a function. It cannot be an attribute. |
| `onTokenExpiring` | Optional, as in `HermsClientOptions`. |
| `session` | Advanced: an existing `HermsSession` from `@hermesihq/js`, to share one connection and the same stores with the rest of the page. |

| Event (bubbles, composed) | `detail` | |
|---|---|---|
| `hermes-item-click` | `{ item }` | **Cancelable.** The item is marked read first. If a listener calls `preventDefault()`, the element does not navigate to `item.actionUrl`; otherwise it does. This is the same contract as `onItemClick`. |
| `hermes-open`, `hermes-close` | | |
| `hermes-error` | `{ error }` | A load or mutation failed. |

Methods: `open()`, `close()`, `refresh()`.

**Configuration arrives in any order.** A page defines the element from a script, then sets
`getSubscriberToken` from another. Until the key, the URL and the function are all present, the
element renders the bell disabled and makes no request. Changing the key or URL tears down the
old client and builds a new one. Moving the node in the DOM must not refetch, so teardown is
deferred by a microtask and cancelled if the node is reconnected.

### D6. Distribution

* ESM that registers `hermes-inbox` on import unless the name is taken, plus
  `defineHermesInbox(tagName)` for another name.
* `dist/hermes-inbox.global.js`: one minified self-contained file (it bundles `@hermesihq/js`)
  for a `<script>` tag. A byte budget is set from the first build and enforced in
  `verify:package`, so size cannot creep unnoticed.
* Importing it in a server render must not throw: `HTMLElement` and `customElements` are
  feature-checked.

### D7. Accessibility: parity first

The React component is the reference, and the element must match it, then both improve
together. Contract:

* The bell is a real `<button>` named "Notifications, N unread", with `aria-expanded` and
  `aria-controls`. A polite live region announces count changes.
* Panel: `role="dialog"`, non-modal. **The React dialog has no accessible name today**: the
  title is a `<p>` and nothing refers to it. Only the list, the bell and the loading state are
  named. Both implementations should name it with `aria-labelledby` pointing at the title. A
  dialog without a name is announced as just "dialog".
* Keyboard: Arrow Up and Down, Home and End move between items; Enter and Space activate;
  Escape closes **and returns focus to the bell**; focus leaving closes.
* The stylesheet gains `@media (forced-colors: active)` for the badge and the unread dot,
  which today rely on colour alone. There is no animation, so reduced motion is moot.

**An open accessibility question I cannot settle here:** the item list uses `role="menu"` with
`menuitem`s. That pattern implies menu semantics (and puts some screen readers into a forms
mode) for what is really a list of notifications, and the archive buttons inside it are not
menu items. A plain list of buttons may read better. This needs real screen-reader testing, which
I cannot do, so it is **not** changed here. It stays as it is in both implementations until
someone can test it.

## 5. Styling contract

The twelve variables stay: `--herms-color-accent`, `-accent-foreground`, `-bg`, `-border`,
`-danger`, `-hover`, `-muted`, `-surface`, `-text`, `-unread-dot`, `--herms-font-family`,
`--herms-radius`. The host sets them on the element or any ancestor. `color-scheme` forces light
or dark. Exposed `::part`s: `trigger`, `badge`, `panel`, `item`. Nothing else is reachable, on
purpose: a part is a public API.

## 6. What this does not do

* No preferences screen. `PreferencesStore` is there for a host to build one; the rendered
  interface wants its own design pass.
* No categories, grouping or templates. No `slot`s yet.
* No fallback for browsers without the Popover API (D4).
* No server-side rendering of the element's contents (no declarative shadow DOM).
* The list is loaded when the element connects, as in React, not on first open. Lazy loading
  would save a request per page view and is a behaviour change to make in both at once.

## 7. How it will be tested, and what each layer cannot prove

| Layer | Proves | Cannot prove |
|---|---|---|
| Unit tests of the shared logic, under `node` | The strings, clamp, seen tracking, index arithmetic | Anything visual |
| jsdom tests of the element, with the Popover methods stubbed | Attribute and property wiring, events, lifecycle, reference-counted teardown, every state renders | **Top layer, light dismiss, Escape, focus return, repositioning.** The stubs only prove we call the API. |
| **Parity check** | A test reads the `it(...)` titles of the React test file and the element test file and fails if they differ | That two tests with the same title assert the same thing |
| **End-to-end, Playwright, Chromium + Firefox + WebKit in CI** | Everything in section 2, in real engines, **including computed styles on the panel** | Screen readers |

The end-to-end layer is the important addition. It answers the Firefox and Safari questions
this note cannot, and it would have caught the defect in section 3 in one assertion. It would
also run the React component, so that defect class is guarded for good.

Every test continues to be written the way the rest of this repository's were: watched to fail
against deliberately broken code before it is trusted.

## 8. Order of work

0. **Fix the React panel** (a patch release). The panel gets the theme variables and the
   colour-scheme attribute, and an accessible name (D7). A structural test now, and an end-to-end
   assertion on computed style once step 1 exists.
1. **End-to-end harness**, three engines in CI, first covering the React component. This proves
   the harness and step 0, and answers the cross-browser questions early.
2. **Extract `@hermesihq/inbox-ui`**; refactor React onto it. No behaviour change.
3. **`@hermesihq/element`**: implementation, jsdom tests, parity check, end-to-end tests.
4. **Browser bundle, size budget, `verify:package` extensions, README, publish.**

## 9. Unknowns, stated plainly

* Firefox and Safari behaviour of everything in section 2. Step 1 answers it.
* Screen readers: none tested. Parity with the React component is a floor, not evidence of
  quality.
* iOS Safari, and touch input generally.
* Whether `role="menu"` is right (D7).
* The byte budget, until there is a first build to measure.

## 10. What building it changed

Things this note said, or assumed, that turned out different. The design above is left as written so
the reasoning can be read; this is the list of where it was wrong.

* **Variables inherit across the boundary (D3) only after a fix.** The shared stylesheet declared
  every `--herms-*` default on the bell and the panel themselves, and a declaration on an element
  beats an inherited value, so setting a variable on `:root` or an ancestor did nothing, in React
  as well. The public variables are now inputs read with their default as fallback into private
  `--_herms-*` copies. Released as `@hermesihq/react` 0.2.3.
* **No `theme` property.** Section 4 does not list one, and the element has none: a host sets the
  variables on the element. The React `theme` and `className` props have no counterpart; the parity
  test names both as intentional differences.
* **`composed` is moot on the events.** They are dispatched on the host element, which is in the
  page's tree. They bubble; that is all a page needs.
* **Focus return differs by engine, and by build.** Section 2 measured Chromium: the platform does
  not return focus. Measured in all three: Firefox does (to the bell), Chromium does not, and WebKit
  did not on Windows but did on Linux. The element returns it itself in every engine, which is a
  harmless repeat where the platform already does.
* **Firefox and WebKit are no blocker.** Everything in section 2 held in both: the top layer, Escape,
  a click outside, and the three things the platform does not do (focus return in two of three,
  following a scroll, closing when focus leaves).
* **The parity check is by test title** (`parity.test.ts`), with intentional differences named in
  the file. The browser-level parity is stronger: `inbox.spec.ts` in the end-to-end suite is written
  once and runs against both implementations in all three engines.
* **A bug in the React component surfaced and was fixed on the way:** opened before the first page
  had loaded, the focus stayed on the Close button when the list arrived (0.2.2). The element has
  the same rule.
* **Forced-colors rules live in `element.css` only.** React does not have them yet; moving them into
  the shared stylesheet is the follow-up. Neither has been checked in a real high-contrast setup.
