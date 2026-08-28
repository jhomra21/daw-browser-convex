import type {
  AppExtensionCommandDeclaration,
  AppExtensionReplacement,
  AppExtensionShortcutDeclaration,
  CommandHandler,
  CommandId,
  ContributionId,
  ExtensionId,
} from './extension-kernel'
import type {
  WorkspaceContributionKind,
  WorkspaceReplacementIntent,
  WorkspaceReplacementPolicy,
} from './workspace-contributions'

export const externalExtensionManifestVersion: 1 = 1

export type ExternalWorkspaceContributionDeclaration = Readonly<{
  id: ContributionId
  kind: WorkspaceContributionKind
  title: string
  slot: string
  order?: number
  replacement?: WorkspaceReplacementPolicy
  replaces?: WorkspaceReplacementIntent
}>

export type ExternalExtensionManifestV1 = Readonly<{
  manifestVersion: 1
  id: ExtensionId
  version: string
  commands: readonly AppExtensionCommandDeclaration[]
  shortcuts: readonly AppExtensionShortcutDeclaration[]
  replacements?: readonly AppExtensionReplacement[]
  workspace: readonly ExternalWorkspaceContributionDeclaration[]
}>

export type ExternalCommandImplementation = Readonly<{
  commandId: CommandId
  handler: CommandHandler
}>

export type ExternalWorkspaceImplementation<TValue> = Readonly<{
  contributionId: ContributionId
  value: TValue
}>

export type ExternalExtensionImplementation<TValue> = Readonly<{
  commands: readonly ExternalCommandImplementation[]
  workspace: readonly ExternalWorkspaceImplementation<TValue>[]
}>

export type ExternalExtensionBundle<TValue> = Readonly<{
  manifest: ExternalExtensionManifestV1
  implementation: ExternalExtensionImplementation<TValue>
}>
