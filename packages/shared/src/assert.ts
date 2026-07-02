export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message)
}

export function assertDefined<T>(
  value: T | null | undefined,
  message = "Expected value to be defined",
): NonNullable<T> {
  assert(value !== null && value !== undefined, message)
  return value
}

export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${String(value)}`)
}
