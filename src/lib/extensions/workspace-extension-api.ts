import type {
  Cleanup,
  ExtensionActivationContext,
} from './extension-kernel'
import type {
  WorkspaceContribution,
  WorkspaceContributionRegistry,
} from './workspace-contributions'

export type WorkspaceExtensionContext = Pick<
  ExtensionActivationContext,
  'extensionId' | 'addCleanup'
>

export const contributeWorkspace = <TValue>(
  context: WorkspaceExtensionContext,
  registry: WorkspaceContributionRegistry<TValue>,
  contribution: WorkspaceContribution<TValue>,
): Cleanup => {
  const cleanup = registry.register(context.extensionId, contribution)
  context.addCleanup(cleanup)
  return cleanup
}
