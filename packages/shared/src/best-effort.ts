// Deliberate fire-and-forget: the failure is dropped. `reason` states why that is safe at the call site.
export const bestEffort = (promise: PromiseLike<unknown>, _reason: string): void => {
  void promise.then(undefined, () => undefined)
}
