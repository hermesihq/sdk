import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The stylesheet is read as text because no test environment has a real cascade. These are the
 * two properties of it that the component's tests used to guard from the other side, and that
 * the custom element, which will import this same file, depends on equally.
 */

describe('the stylesheet', () => {
  const css = readFileSync(join(__dirname, 'inbox.css'), 'utf8').replace(/\r\n/g, '\n')
  // Every `selector { declarations }` pair. Crude on purpose: this file has no nesting beyond
  // the one `@media` wrapper, and a parser would be more code than the rules it checks.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim(),
    body: match[2] ?? '',
  }))

  it('declares the theme on the panel wherever it declares it on the bell', () => {
    // The static form of the defect, and the only one jsdom can check: a rule that defines the
    // `--herms-*` variables (the defaults, and both dark-mode rules) must name the panel too,
    // because the panel inherits nothing from the root.
    const themeRules = rules.filter((rule) => rule.body.includes('--_herms-bg:'))

    // Three: the defaults, the automatic dark mode, the forced dark mode. A count of zero would
    // make the loop below pass over nothing, which is the failure this exists to prevent.
    expect(themeRules.length).toBeGreaterThanOrEqual(3)
    for (const rule of themeRules) {
      expect(rule.selector, `a theme rule that skips the panel: ${rule.selector}`).toContain('.herms-inbox__panel')
    }
  })

  it('never declares a public variable, so that a host can set one anywhere above it', () => {
    // `--herms-*` are inputs. A rule here that declared one would beat whatever the host set on
    // an ancestor (a declaration on the element wins over an inherited value), and the documented
    // way to theme the widget would stop working without a test noticing.
    const declared = rules.flatMap((rule) => [...rule.body.matchAll(/(--herms-[a-z-]+)\s*:/g)].map((match) => match[1]))
    expect(declared).toEqual([])
  })

  it('keeps the badge and the unread dot visible in forced colours, for React and for the element alike', () => {
    // Both are colour alone, and forced colours (Windows high contrast) replaces every colour. This is the shared file, so a
    // rule dropped from it fails here for both. (The element's own stylesheet had them and the React component did not.)
    const block = css.match(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/)
    expect(block, 'a forced-colors block').not.toBeNull()
    expect(block?.[1]).toMatch(/\.herms-inbox__badge \{[^}]*border: 1px solid CanvasText/)
    expect(block?.[1]).toMatch(/\.herms-inbox__item\[data-unread='true'\] \.herms-inbox__item-title::before \{[^}]*background: CanvasText/)
  })

  it('sizes the panel and everything in it with border-box, like the rest of the widget', () => {
    const sizing = rules.find((rule) => rule.body.includes('box-sizing: border-box'))

    // Without it the 380px panel was 382px wide once its border was added.
    expect(sizing?.selector).toContain('.herms-inbox__panel,')
    expect(sizing?.selector).toContain('.herms-inbox__panel *')
  })
})
