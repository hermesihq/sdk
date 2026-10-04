/**
 * The JSON an event is sent as.
 *
 * `JSON.stringify` loses data without a word: a `Map` becomes `{}`, a `NaN` becomes `null`, a
 * function-valued property disappears. In a notification payload that is a template rendering
 * "Hello undefined", found by a customer. So the values that cannot be sent faithfully are
 * refused here, and the ones with one obvious form (a `Date`, a `bigint`) are given it.
 */

function replacer(this: unknown, key: string, value: unknown): unknown {
  const original = (this as Record<string, unknown>)[key]
  if (original instanceof Date && Number.isNaN(original.getTime())) {
    throw new TypeError(`"${key}" is an invalid Date, which JSON would turn into null`)
  }
  switch (typeof value) {
    case 'bigint':
      return value.toString()
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`"${key}" is ${value}, which JSON would turn into null`)
      return value
    case 'function':
    case 'symbol':
      throw new TypeError(`"${key}" is a ${typeof value}, which cannot be sent`)
    default:
      if (value instanceof Map || value instanceof Set) {
        throw new TypeError(`"${key}" is a ${value.constructor.name}, which JSON would turn into {}; convert it first`)
      }
      return value
  }
}

/** The request body as JSON. Throws a `TypeError` naming the offending key. */
export function encodeJson(body: unknown): string {
  return JSON.stringify(body, replacer)
}
