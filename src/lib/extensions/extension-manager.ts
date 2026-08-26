import {
  createExtensionKernel,
  type AppExtensionDefinition,
  type Cleanup,
  type ExtensionDiagnostic,
  type ExtensionId,
  type ExtensionKernel,
  type ExtensionKernelSnapshot,
} from './extension-kernel'

export type AppExtensionSource = 'builtin' | 'project' | 'package'

export type ExtensionManagerRegistration = Readonly<{
  id: ExtensionId
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
  unregister: (extensionId: ExtensionId) => Promise<void>
  enable: (extensionId: ExtensionId) => Promise<void>
  disable: (extensionId: ExtensionId) => Promise<void>
  reload: (extensionId: ExtensionId) => Promise<void>
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
  const registrations = new Map<ExtensionId, RegisteredExtension>()
  let registrationGeneration = 0
  let disposed = false

  const ensureAvailable = () => {
    if (disposed) throw new Error('Extension manager is disposed.')
  }

  const registrationFor = (extensionId: ExtensionId) => {
    const registration = registrations.get(extensionId)
    if (!registration) throw new Error(`Unknown extension ${extensionId}.`)
    return registration
  }

  const isEnabled = (extensionId: ExtensionId): boolean =>
    kernel.snapshot().extensions.some((extension) => extension.id === extensionId)

  const unregisterGeneration = async (extensionId: ExtensionId, generation: number) => {
    const registration = registrations.get(extensionId)
    if (registration?.generation !== generation) return
    if (isEnabled(extensionId)) await kernel.deactivate(extensionId)
    if (registrations.get(extensionId)?.generation === generation) {
      registrations.delete(extensionId)
    }
  }

  const cleanupFor = (extensionId: ExtensionId, generation: number): Cleanup => async () => {
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

  const enable = async (extensionId: ExtensionId) => {
    ensureAvailable()
    if (isEnabled(extensionId)) return
    const registration = registrationFor(extensionId)
    await activateDefinition(kernel, registration.definition)
    if (registrations.get(extensionId)?.generation !== registration.generation) {
      await kernel.deactivate(extensionId)
      throw new Error(`Extension ${extensionId} registration changed during activation.`)
    }
  }

  const disable = async (extensionId: ExtensionId) => {
    ensureAvailable()
    if (!isEnabled(extensionId)) return
    await kernel.deactivate(extensionId)
  }

  const update = async (
    definition: AppExtensionDefinition,
    source?: AppExtensionSource,
  ): Promise<Cleanup> => {
    ensureAvailable()
    const current = registrationFor(definition.id)
    const nextSource = source ?? current.source
    if (isEnabled(definition.id)) await kernel.reload(definition)
    const generation = ++registrationGeneration
    registrations.set(definition.id, Object.freeze({
      definition,
      source: nextSource,
      generation,
    }))
    return cleanupFor(definition.id, generation)
  }

  const unregister = async (extensionId: ExtensionId) => {
    ensureAvailable()
    const registration = registrations.get(extensionId)
    if (!registration) return
    await unregisterGeneration(extensionId, registration.generation)
  }

  const reload = async (extensionId: ExtensionId) => {
    ensureAvailable()
    const registration = registrationFor(extensionId)
    if (!isEnabled(extensionId)) {
      await enable(extensionId)
      return
    }
    await kernel.reload(registration.definition)
  }

  const snapshot = (): ExtensionManagerSnapshot => {
    const kernelSnapshot = kernel.snapshot()
    const activeIds = new Set(kernelSnapshot.extensions.map((extension) => extension.id))
    const current = [...registrations.values()]
      .map((registration) => Object.freeze({
        id: registration.definition.id,
        version: registration.definition.version,
        source: registration.source,
        enabled: activeIds.has(registration.definition.id),
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
      registrations.clear()
    },
  })
}
