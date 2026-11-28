const isObjectValue = <T>(value: T): value is T & object => typeof value === 'object' && value !== null

const hasPlainPrototype = <T extends object>(value: T) => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Plain data, arrays and Maps compare by value; anything else (an AudioBuffer) by reference, so a re-decoded buffer is a change.
export const sameData = <T>(left: T, right: T): boolean => {
  if (Object.is(left, right)) return true
  if (!isObjectValue(left) || !isObjectValue(right)) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameData(entry, right[index]))
  }
  if (left instanceof Map || right instanceof Map) {
    return left instanceof Map && right instanceof Map && left.size === right.size
      && [...left].every(([key, value]) => right.has(key) && sameData(value, right.get(key)))
  }
  if (!hasPlainPrototype(left) || !hasPlainPrototype(right)) return false
  const rightEntries = new Map(Object.entries(right))
  const leftEntries = Object.entries(left)
  return leftEntries.length === rightEntries.size
    && leftEntries.every(([key, value]) => rightEntries.has(key) && sameData(value, rightEntries.get(key)))
}

export const reuseIfSame = <T>(previous: T | undefined, next: T) => (
  previous !== undefined && sameData(previous, next) ? previous : next
)

// Entries equal to their previous version (matched by key) keep that object, and the previous array stays when nothing
// changed, so lists keyed on object identity keep their rows mounted.
export const reuseEqualByKey = <T>(previous: T[], next: T[], key: (item: T) => string): T[] => {
  const previousByKey = new Map(previous.map((item) => [key(item), item]))
  const items = next.map((item) => reuseIfSame(previousByKey.get(key(item)), item))
  return items.length === previous.length && items.every((item, index) => item === previous[index]) ? previous : items
}
