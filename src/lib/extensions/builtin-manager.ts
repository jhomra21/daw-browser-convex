import {
  createExtensionKernel,
  type AppExtensionDefinition,
  type ExtensionDiagnostic,
  type ExtensionKernel,
  type ExtensionKernelSnapshot,
} from "./extension-kernel";

type BuiltinManager = Readonly<{
  enable: (extensionId: string) => Promise<void>;
  disable: (extensionId: string) => Promise<void>;
  reload: (extensionId: string) => Promise<void>;
  snapshot: () => Readonly<{
    kernel: ExtensionKernelSnapshot;
    enabled: readonly string[];
    diagnostics: readonly ExtensionDiagnostic[];
  }>;
  kernel: ExtensionKernel;
  dispose: () => Promise<void>;
}>;

const freezeSnapshot = (
  kernel: ExtensionKernelSnapshot,
  enabled: readonly string[],
): ReturnType<BuiltinManager["snapshot"]> => Object.freeze({
  kernel,
  enabled: Object.freeze([...enabled]),
  diagnostics: kernel.diagnostics,
});

export const createBuiltinExtensionManager = (
  definitions: readonly AppExtensionDefinition[],
  kernel: ExtensionKernel = createExtensionKernel(),
): BuiltinManager => {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const enabled = new Set<string>();

  const definitionFor = (extensionId: string) => {
    const definition = byId.get(extensionId);
    if (!definition) throw new Error(`Unknown built-in extension ${extensionId}.`);
    return definition;
  };

  const enable = async (extensionId: string) => {
    if (enabled.has(extensionId)) return;
    await kernel.activate(definitionFor(extensionId));
    enabled.add(extensionId);
  };

  const disable = async (extensionId: string) => {
    if (!enabled.has(extensionId)) return;
    await kernel.deactivate(extensionId);
    enabled.delete(extensionId);
  };

  const reload = async (extensionId: string) => {
    if (!enabled.has(extensionId)) {
      await enable(extensionId);
      return;
    }
    await kernel.reload(definitionFor(extensionId));
  };

  return Object.freeze({
    enable,
    disable,
    reload,
    snapshot: () => freezeSnapshot(kernel.snapshot(), [...enabled].sort()),
    kernel,
    dispose: async () => {
      await kernel.dispose();
      enabled.clear();
    },
  });
};
