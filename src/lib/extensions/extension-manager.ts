import {
  createExtensionKernel,
  type AppExtensionDefinition,
  type Cleanup,
  type ExtensionDiagnostic,
  type ExtensionKernel,
  type ExtensionKernelSnapshot,
} from './extension-kernel'

export type AppExtensionSource = 'builtin' | 'project' | 'package'

export type ExtensionManagerRegistration = Readonly<{
  id: string
  version: string
  source: AppExtensionSource
  enabled: boolean
}>

export type ExtensionManagerSnapshot = Readonly<{
  kernel: ExtensionKernelSnapshot
  registrations: readonly ExtensionManagerRegistration[]
  diagnostics: readonly ExtensionDiagnostic[]
}>

export type ExtensionManager = Readonly<{
  register: (definition: AppExtensionDefinition, source?: AppExtensionSource) => Cleanup
  update: (definition: AppExtensionDefinition, source?: AppExtensionSource) => Promise<Cleanup>
  unregister: (extensionId: string) => Promise<void>
  enable: (extensionId: string) => Promise<void>
  disable: (extensionId: string) => Promise<void>
  reload: (extensionId: string) => Promise<void>
  snapshot: () => ExtensionManagerSnapshot
  kernel: ExtensionKernel
  dispose: () => Promise<void>
}>

type RegisteredExtension = Readonly<{
  definition: AppExtensionDefinition
  source: AppExtensionSource
  generation: number
}>

const freezeSnapshot = (
  kernel: ExtensionKernelSnapshot,
  registrations: readonly ExtensionManagerRegistration[],
): ExtensionManagerSnapshot => Object.freeze({
  kernel,
  registrations: Object.freeze([...registrations]),
  diagnostics: kernel.diagnostics,
})

const activateDefinition = async (
  kernel: ExtensionKernel,
  definition: AppExtensionDefinition,
) => {
  if ((definition.replacements?.length ?? 0) > 0) {
    await kernel.replace(definition)
    return
  }
  await kernel.activate(definition)
}

export const createExtensionManager = (
  kernel: ExtensionKernel = createExtensionKernel(),
): ExtensionManager => {
  const registrations = new Map<string, RegisteredExtension>()
  const enabled = new Set<string>()
  let registrationGeneration = 0
  let disposed = false

  const ensureAvailable = () => {
    if (disposed) throw new Error('Extension manager is disposed.')
  }

  const registrationFor = (extensionId: string) => {
    const registration = registrations.get(extensionId)
    if (!registration) throw new Error(`Unknown extension ${extensionId}.`)
    return registration
  }

  const unregisterGeneration = async (extensionId: string, generation: number) => {
    const registration = registrations.get(extensionId)
    if (registration?.generation !== generation) return
    if (enabled.has(extensionId)) {
      await kernel.deactivate(extensionId)
      enabled.delete(extensionId)
    }
    if (registrations.get(extensionId)?.generation === generation) {
      registrations.delete(extensionId)
    }
  }

  const cleanupFor = (extensionId: string, generation: number): Cleanup => async () => {
    if (disposed) return
    await unregisterGeneration(extensionId, generation)
  }

  const register = (
    definition: AppExtensionDefinition,
    source: AppExtensionSource = 'project',
  ): Cleanup => {
    ensureAvailable()
    if (registrations.has(definition.id)) {
      throw new Error(`Extension ${definition.id} is already registered.`)
    }
    const generation = ++registrationGeneration
    registrations.set(definition.id, Object.freeze({ definition, source, generation }))
    return cleanupFor(definition.id, generation)
  }

  const enable = async (extensionId: string) => {
    ensureAvailable()
    if (enabled.has(extensionId)) return
    const registration = registrationFor(extensionId)
    await activateDefinition(kernel, registration.definition)
    if (registrations.get(extensionId)?.generation !== registration.generation) {
      await kernel.deactivate(extensionId)
      throw new Error(`Extension ${extensionId} registration changed during activation.`)
    }
    enabled.add(extensionId)
  }

  const disable = async (extensionId: string) => {
    ensureAvailable()
    if (!enabled.has(extensionId)) return
    await kernel.deactivate(extensionId)
    enabled.delete(extensionId)
  }

  const update = async (
    definition: AppExtensionDefinition,
    source?: AppExtensionSource,
  ): Promise<Cleanup> => {
    ensureAvailable()
    const current = registrationFor(definition.id)
    const nextSource = source ?? current.source
    if (enabled.has(definition.id)) {
      await kernel.reload(definition)
    }
    const generation = ++registrationGeneration
    registrations.set(definition.id, Object.freeze({
      definition,
      source: nextSource,
      generation,
    }))
    return cleanupFor(definition.id, generation)
  }

  const unregister = async (extensionId: string) => {
    ensureAvailable()
    const registration = registrations.get(extensionId)
    if (!registration) return
    await unregisterGeneration(extensionId, registration.generation)
  }

  const reload = async (extensionId: string) => {
    ensureAvailable()
    const registration = registrationFor(extensionId)
    if (!enabled.has(extensionId)) {
      await enable(extensionId)
      return
    }
    await kernel.reload(registration.definition)
  }

  const snapshot = (): ExtensionManagerSnapshot => {
    const kernelSnapshot = kernel.snapshot()
    const current = [...registrations.values()]
      .map((registration) => Object.freeze({
        id: registration.definition.id,
        version: registration.definition.version,
        source: registration.source,
        enabled: enabled.has(registration.definition.id),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    return freezeSnapshot(kernelSnapshot, current)
  }

  return Object.freeze({
    register,
    update,
    unregister,
    enable,
    disable,
    reload,
    snapshot,
    kernel,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await kernel.dispose()
      enabled.clear()
      registrations.clear()
    },
  })
}
