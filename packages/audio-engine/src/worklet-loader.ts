type WorkletRegistration = {
  loaded: Set<string>
  pending: Map<string, Promise<void>>
}

type WorkletContext = object & {
  audioWorklet: {
    addModule: (moduleUrl: string) => Promise<void>
  }
}

const registrations = new WeakMap<WorkletContext, WorkletRegistration>()

const getRegistration = (context: WorkletContext) => {
  const existing = registrations.get(context)
  if (existing) return existing
  const registration: WorkletRegistration = { loaded: new Set(), pending: new Map() }
  registrations.set(context, registration)
  return registration
}

export function loadWorkletModule(context: WorkletContext, moduleUrl: string): Promise<void> {
  const registration = getRegistration(context)
  if (registration.loaded.has(moduleUrl)) return Promise.resolve()
  const pending = registration.pending.get(moduleUrl)
  if (pending) return pending

  const next = context.audioWorklet.addModule(moduleUrl).then(() => {
    registration.loaded.add(moduleUrl)
    registration.pending.delete(moduleUrl)
  }, (error) => {
    registration.pending.delete(moduleUrl)
    throw error
  })
  registration.pending.set(moduleUrl, next)
  return next
}
