import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The element has to do what `<HermsInbox />` does. Two implementations of one behaviour drift
 * apart the way two copies of anything do, quietly, so this reads the titles of the React
 * component's cases and the element's and fails when a case exists on one side and not the other.
 *
 * What it can show is that a behaviour was written down for both. What it cannot show is that two
 * cases with the same title assert the same thing; that is review's job, and the end-to-end suite
 * runs the same page of expectations against both for the parts a browser decides.
 *
 * A difference is allowed only by naming it here, with the reason, so it is a decision on the
 * page and not an accident.
 */

const REACT = join(__dirname, '..', '..', 'react', 'src', 'HermsInbox.test.tsx')
const ELEMENT = join(__dirname, 'HermesInbox.test.ts')

/** `group > title` for every case, in the two levels these files use. */
function titles(file: string): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>()
  let group: string | null = null
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const head = /^describe\((['"`])((?:\\.|(?!\1).)*)\1/.exec(line)
    if (head) {
      group = head[2]!
      groups.set(group, new Set())
      continue
    }
    const test = /^ {2}it\((['"`])((?:\\.|(?!\1).)*)\1/.exec(line)
    if (test && group) groups.get(group)!.add(test[2]!)
  }
  return groups
}

/** Cases the React component has and the element deliberately does not, and why. */
const REACT_ONLY: Record<string, string> = {
  'is not inside the bell, which is why it has to carry its own theme':
    'Radix portals the panel under <body>. The element keeps the panel in the same shadow root as the bell, so the defect this case guards cannot occur.',
  'carries the theme the host passed':
    'The element has no `theme` property: a host sets the --herms-* variables on it or an ancestor, and the end-to-end suite checks that reaches the panel.',
  'carries the host class, so that one rule themes the bell and the panel':
    'The element has no className to forward: the host styles the element itself, and its variables inherit.',
}

describe('parity with the React component', () => {
  const react = titles(REACT)
  const element = titles(ELEMENT)

  it('reads the cases of both files, so that a change of layout cannot make this pass over nothing', () => {
    const count = (groups: Map<string, Set<string>>) => [...groups.values()].reduce((sum, set) => sum + set.size, 0)
    expect(count(react)).toBeGreaterThan(15)
    expect(count(element)).toBeGreaterThan(count(react) - Object.keys(REACT_ONLY).length)
  })

  it('has every React group, and every React case in it, unless the difference is named', () => {
    const missing: string[] = []
    for (const [group, cases] of react) {
      const other = element.get(group)
      if (!other) {
        missing.push(`group "${group}"`)
        continue
      }
      for (const title of cases) {
        if (!other.has(title) && !(title in REACT_ONLY)) missing.push(`${group} > ${title}`)
      }
    }
    expect(missing, 'React cases with no element counterpart (add one, or name the difference)').toEqual([])
  })

  it('has no case in a shared group that React lacks', () => {
    const extra: string[] = []
    for (const [group, cases] of element) {
      const other = react.get(group)
      if (!other) continue
      for (const title of cases) if (!other.has(title)) extra.push(`${group} > ${title}`)
    }
    expect(extra, 'element cases in a shared group with no React counterpart').toEqual([])
  })

  it('does not name a difference that has since gone away', () => {
    const stale = Object.keys(REACT_ONLY).filter((title) => ![...react.values()].some((cases) => cases.has(title)))
    expect(stale, 'REACT_ONLY entries for cases that no longer exist').toEqual([])
    const nowShared = Object.keys(REACT_ONLY).filter((title) => [...element.values()].some((cases) => cases.has(title)))
    expect(nowShared, 'REACT_ONLY entries the element now has').toEqual([])
  })
})
