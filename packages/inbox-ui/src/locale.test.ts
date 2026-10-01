import { describe, expect, it } from 'vitest'
import { getHermsInboxStrings } from './locale'
import type { HermsLocale } from './types'

/**
 * `<HermsInbox />` carries its own EN/FR strings because it cannot assume the host app
 * runs i18next (or any i18n at all) — see the file's own header. That decision moves the
 * FR/EN coverage this project treats as non-negotiable out of the usual translation
 * workflow and into a hand-maintained table, where the failure mode is a new English
 * string that nobody ever translates: it ships, and it renders in English inside an
 * otherwise French UI.
 *
 * `HermsInbox.test.tsx` covers the rendering side (the `locale` prop actually reaching
 * the panel and the bell). This file covers the table itself, where a gap is cheap to
 * catch and invisible to catch any other way.
 */

describe('the inbox string table', () => {
  it('translates every string, with no English left in the French table', () => {
    const en = getHermsInboxStrings('en')
    const fr = getHermsInboxStrings('fr')

    // Same keys, same kinds: a string that became a function (gaining a count) in one
    // language and not the other renders `[object Object]` in the other.
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(typeof fr[key]).toBe(typeof en[key])
    }

    // The three that are legitimately identical in both languages. Everything else
    // differing is what makes "somebody pasted the English in" fail here.
    const sameInBothLanguages = new Set(['bellLabel', 'panelTitle', 'loading'])
    const untranslated = (Object.keys(en) as Array<keyof typeof en>).filter(
      (key) => typeof en[key] === 'string' && !sameInBothLanguages.has(key) && fr[key] === en[key],
    )
    expect(untranslated).toEqual([])
  })

  it('interpolates the unread count in both languages', () => {
    // The one string that is not a constant. It is also the bell's accessible name, so
    // a mistake here is a mistake in what a screen reader announces.
    expect(getHermsInboxStrings('en').bellLabelWithUnread(3)).toContain('3')
    expect(getHermsInboxStrings('fr').bellLabelWithUnread(3)).toBe('Notifications, 3 non lues')
  })

  it('falls back to English rather than rendering nothing', () => {
    // Two ways a host reaches this: omitting the prop, and — from plain JavaScript,
    // where the `HermsLocale` union is not enforced — passing a locale this package
    // does not carry. Neither may produce a panel full of `undefined`.
    expect(getHermsInboxStrings(undefined).empty).toBe("You're all caught up")
    expect(getHermsInboxStrings('de' as HermsLocale).empty).toBe("You're all caught up")
  })
})
