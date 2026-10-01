import type { HermsLocale } from './types'

/** "3 hours ago", in the visitor's language. An unparseable date is an empty string, not "NaN". */
export function relativeTime(iso: string, locale: HermsLocale, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  // A date in the future (a clock slightly behind the server's) gives a negative number and
  // falls into the first branch, which is the right answer: it reads "this minute".
  const diffSeconds = Math.round((now - then) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (diffSeconds < 60) return formatter.format(0, 'minute')
  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 60) return formatter.format(-diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return formatter.format(-diffHours, 'hour')
  const diffDays = Math.round(diffHours / 24)
  return formatter.format(-diffDays, 'day')
}

/** What the badge on the bell says. Past 99 it stops counting. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}
