import type { HermsColorScheme, HermsInboxPlacement, HermsInboxTheme } from './types'

/** The `theme` prop as the CSS custom properties it sets. Unset values are left out, not blank. */
export function themeVariables(theme: HermsInboxTheme | undefined): Record<string, string> {
  const variables: Record<string, string> = {}
  if (theme?.accent) variables['--herms-color-accent'] = theme.accent
  if (theme?.radius) variables['--herms-radius'] = theme.radius
  return variables
}

/** The value of `data-herms-color-scheme`, or `undefined` for "follow the system". */
export function colorSchemeAttribute(scheme: HermsColorScheme): 'light' | 'dark' | undefined {
  return scheme === 'auto' ? undefined : scheme
}

const PLACEMENTS: Record<HermsInboxPlacement, { side: 'top' | 'bottom'; align: 'start' | 'end' }> = {
  'bottom-start': { side: 'bottom', align: 'start' },
  'bottom-end': { side: 'bottom', align: 'end' },
  'top-start': { side: 'top', align: 'start' },
  'top-end': { side: 'top', align: 'end' },
}

export function splitPlacement(placement: HermsInboxPlacement): { side: 'top' | 'bottom'; align: 'start' | 'end' } {
  return PLACEMENTS[placement]
}

/** Joins class names, skipping the empty ones. */
export function classNames(...names: Array<string | undefined | false>): string {
  return names.filter(Boolean).join(' ')
}
