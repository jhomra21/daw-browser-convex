import {
  createExtensionManager,
  type ExtensionManager,
} from './extension-manager'
import {
  type AppExtensionDefinition,
  type ExtensionDiagnostic,
  type ExtensionKernel,
  type ExtensionKernelSnapshot,
} from './extension-kernel'

type BuiltinManager = Readonly<{
  enable: (extensionId: string) => Promise<void>
  disable: (extensionId: string) => Promise<void>
  reload: (extensionId: string) => Promise<void>
  snapshot: () => Readonly<{
    kernel: ExtensionKernelSnapshot
    enabled: readonly string[]
    diagnostics: readonly ExtensionDiagnostic[]
  }>
  kernel: ExtensionKernel
  dispose: () => Promise<void>
}>

const builtinSnapshot = (
  manager: ExtensionManager,
): ReturnType<BuiltinManager['snapshot']> => {
  const snapshot = manager.snapshot()
  return Object.freeze({
    kernel: snapshot.kernel,
    enabled: Object.freeze(snapshot.registrations
      .filter((registration) => registration.enabled)
      .map((registration) => registration.id)),
    diagnostics: snapshot.diagnostics,
  })
}

export const createBuiltinExtensionManager = (
  definitions: readonly AppExtensionDefinition[],
  kernel?: ExtensionKernel,
): BuiltinManager => {
  const manager = createExtensionManager(kernel)
  for (const definition of definitions) manager.register(definition, 'builtin')

  return Object.freeze({
    enable: manager.enable,
    disable: manager.disable,
    reload: manager.reload,
    snapshot: () => builtinSnapshot(manager),
    kernel: manager.kernel,
    dispose: manager.dispose,
  })
}
