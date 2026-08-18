export const isAbortError = (cause: unknown): boolean => (
  cause instanceof DOMException && cause.name === 'AbortError'
)
