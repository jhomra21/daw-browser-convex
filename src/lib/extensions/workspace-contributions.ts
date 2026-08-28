import {
  ExtensionKernelError,
  isContributionId,
  isExtensionId,
  type ContributionId,
  type ExtensionId,
} from './extension-kernel'

export type WorkspaceContributionKind = 'tab' | 'panel' | 'view'

export type WorkspaceReplacementPolicy = Readonly<{
  allowed: true
  contract: string
}>

export type WorkspaceReplacementIntent = Readonly<{
  contract: string
}>

export type WorkspaceContribution<TValue> = Readonly<{
  id: ContributionId
  kind: WorkspaceContributionKind
  title: string
  slot: string
  order?: number
  replacement?: WorkspaceReplacementPolicy
  replaces?: WorkspaceReplacementIntent
  value: TValue
}>

export type ActiveWorkspaceContribution<TValue> = Readonly<{
  id: ContributionId
  kind: WorkspaceContributionKind
  title: string
  slot: string
  order: number
  providerId: ExtensionId
  value: TValue
}>

export type WorkspaceContributionSnapshot = Readonly<{
  generation: number
  contributions: readonly Readonly<{
    id: ContributionId
    kind: WorkspaceContributionKind
    title: string
    slot: string
    order: number
    providerId: ExtensionId
  }>[]
}>

export type WorkspaceContributionRegistry<TValue> = Readonly<{
  register: (
    providerId: ExtensionId,
    contribution: WorkspaceContribution<TValue>,
  ) => () => void
  unregisterProvider: (providerId: ExtensionId) => void
  get: (id: ContributionId) => ActiveWorkspaceContribution<TValue> | undefined
  list: (kind?: WorkspaceContributionKind) => readonly ActiveWorkspaceContribution<TValue>[]
  snapshot: () => WorkspaceContributionSnapshot
  subscribe: (listener: (snapshot: WorkspaceContributionSnapshot) => void) => () => void
}>

type NormalizedContribution<TValue> = Readonly<{
  id: ContributionId
  kind: WorkspaceContributionKind
  title: string
  slot: string
  order: number
  replacement?: WorkspaceReplacementPolicy
  replaces?: WorkspaceReplacementIntent
  value: TValue
}>

type Entry<TValue> = Readonly<{
  providerId: ExtensionId
  contribution: NormalizedContribution<TValue>
}>

const MAX_TEXT_LENGTH = 200
const MAX_CONTRACT_LENGTH = 128
const MIN_ORDER = -1000
const MAX_ORDER = 1000

const workspaceKinds: readonly WorkspaceContributionKind[] = ['tab', 'panel', 'view']

const fail = (code: string, message: string): never => {
  throw new ExtensionKernelError(code, message)
}

const normalizeText = (value: string, field: string, max = MAX_TEXT_LENGTH): string => {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max) {
    fail(`invalid-workspace-${field}`, `Workspace ${field} is empty or too long.`)
  }
  return normalized
}

const normalizeContribution = <TValue>(
  contribution: WorkspaceContribution<TValue>,
): NormalizedContribution<TValue> => {
  if (!isContributionId(contribution.id)) {
    fail('invalid-workspace-contribution-id', 'Workspace contribution ID is invalid.')
  }
  if (!workspaceKinds.includes(contribution.kind)) {
    fail('invalid-workspace-kind', 'Workspace contribution kind is invalid.')
  }
  const order = contribution.order ?? 0
  if (!Number.isInteger(order) || order < MIN_ORDER || order > MAX_ORDER) {
    fail('invalid-workspace-order', 'Workspace contribution order is outside the bounded range.')
  }
  const title = normalizeText(contribution.title, 'title')
  const slot = normalizeText(contribution.slot, 'slot', 128)
  const replacement: WorkspaceReplacementPolicy | undefined = contribution.replacement === undefined
    ? undefined
    : Object.freeze({
        allowed: true,
        contract: normalizeText(contribution.replacement.contract, 'replacement-contract', MAX_CONTRACT_LENGTH),
      })
  const replaces: WorkspaceReplacementIntent | undefined = contribution.replaces === undefined
    ? undefined
    : Object.freeze({
        contract: normalizeText(contribution.replaces.contract, 'replacement-intent', MAX_CONTRACT_LENGTH),
      })

  return Object.freeze({
    id: contribution.id,
    kind: contribution.kind,
    title,
    slot,
    order,
    replacement,
    replaces,
    value: contribution.value,
  })
}

const compareEntries = <TValue>(left: Entry<TValue>, right: Entry<TValue>): number =>
  left.contribution.slot.localeCompare(right.contribution.slot) ||
  left.contribution.order - right.contribution.order ||
  left.contribution.title.localeCompare(right.contribution.title) ||
  left.contribution.id.localeCompare(right.contribution.id)

const publicEntry = <TValue>(entry: Entry<TValue>): ActiveWorkspaceContribution<TValue> =>
  Object.freeze({
    id: entry.contribution.id,
    kind: entry.contribution.kind,
    title: entry.contribution.title,
    slot: entry.contribution.slot,
    order: entry.contribution.order,
    providerId: entry.providerId,
    value: entry.contribution.value,
  })

const sameSurface = <TValue>(
  left: NormalizedContribution<TValue>,
  right: NormalizedContribution<TValue>,
): boolean =>
  left.id === right.id &&
  left.kind === right.kind &&
  left.title === right.title &&
  left.slot === right.slot &&
  left.order === right.order

export const createWorkspaceContributionRegistry = <TValue>(): WorkspaceContributionRegistry<TValue> => {
  const active = new Map<ContributionId, Entry<TValue>>()
  const replaced = new Map<ContributionId, Entry<TValue>>()
  const owned = new Map<ExtensionId, Set<ContributionId>>()
  const subscribers = new Set<(snapshot: WorkspaceContributionSnapshot) => void>()
  let generation = 0

  const remember = (providerId: ExtensionId, id: ContributionId): void => {
    const ids = owned.get(providerId) ?? new Set<ContributionId>()
    ids.add(id)
    owned.set(providerId, ids)
  }

  const forget = (providerId: ExtensionId, id: ContributionId): void => {
    const ids = owned.get(providerId)
    if (ids === undefined) return
    ids.delete(id)
    if (ids.size === 0) owned.delete(providerId)
  }

  const snapshot = (): WorkspaceContributionSnapshot => Object.freeze({
    generation,
    contributions: Object.freeze(
      [...active.values()]
        .sort(compareEntries)
        .map((entry) => Object.freeze({
          id: entry.contribution.id,
          kind: entry.contribution.kind,
          title: entry.contribution.title,
          slot: entry.contribution.slot,
          order: entry.contribution.order,
          providerId: entry.providerId,
        })),
    ),
  })

  const notify = (): void => {
    generation += 1
    const current = snapshot()
    for (const listener of subscribers) listener(current)
  }

  const unregister = (providerId: ExtensionId, id: ContributionId): void => {
    const current = active.get(id)
    if (current?.providerId === providerId) {
      const previous = replaced.get(id)
      if (previous === undefined) {
        active.delete(id)
      } else {
        active.set(id, previous)
        replaced.delete(id)
      }
      forget(providerId, id)
      notify()
      return
    }

    const previous = replaced.get(id)
    if (previous?.providerId !== providerId) return

    if (current !== undefined) forget(current.providerId, id)
    replaced.delete(id)
    active.delete(id)
    forget(providerId, id)
    notify()
  }

  const register = (
    providerId: ExtensionId,
    contribution: WorkspaceContribution<TValue>,
  ): (() => void) => {
    if (!isExtensionId(providerId)) {
      fail('invalid-workspace-provider-id', 'Workspace provider ID is invalid.')
    }
    const normalized = normalizeContribution(contribution)
    if (owned.get(providerId)?.has(normalized.id) === true) {
      fail('duplicate-workspace-provider-contribution', 'Provider already registered this workspace contribution.')
    }

    const current = active.get(normalized.id)
    if (current === undefined) {
      if (normalized.replaces !== undefined) {
        fail('workspace-replacement-target-absent', 'Workspace replacement target is not active.')
      }
      active.set(normalized.id, Object.freeze({ providerId, contribution: normalized }))
      remember(providerId, normalized.id)
      notify()
    } else {
      if (normalized.replaces === undefined) {
        fail('workspace-contribution-conflict', 'Workspace contribution ID is already active.')
      }
      if (replaced.has(normalized.id)) {
        fail('workspace-replacement-cycle', 'Nested workspace replacement is not supported.')
      }
      if (current.contribution.replacement === undefined) {
        fail('workspace-replacement-not-allowed', 'Workspace replacement target does not allow replacement.')
      }
      if (current.contribution.replacement.contract !== normalized.replaces.contract) {
        fail('workspace-replacement-contract-mismatch', 'Workspace replacement contract does not match the target.')
      }
      if (!sameSurface(current.contribution, normalized) || normalized.replacement !== undefined) {
        fail('workspace-replacement-surface-mismatch', 'Workspace replacement must preserve the target surface contract.')
      }

      replaced.set(normalized.id, current)
      active.set(normalized.id, Object.freeze({
        providerId,
        contribution: Object.freeze({
          ...current.contribution,
          replacement: undefined,
          replaces: normalized.replaces,
          value: normalized.value,
        }),
      }))
      remember(providerId, normalized.id)
      notify()
    }

    let registered = true
    return () => {
      if (!registered) return
      registered = false
      unregister(providerId, normalized.id)
    }
  }

  return Object.freeze({
    register,
    unregisterProvider: (providerId: ExtensionId): void => {
      const ids = [...(owned.get(providerId) ?? [])]
      for (const id of ids) unregister(providerId, id)
    },
    get: (id: ContributionId): ActiveWorkspaceContribution<TValue> | undefined => {
      const entry = active.get(id)
      return entry === undefined ? undefined : publicEntry(entry)
    },
    list: (kind?: WorkspaceContributionKind): readonly ActiveWorkspaceContribution<TValue>[] =>
      Object.freeze(
        [...active.values()]
          .filter((entry) => kind === undefined || entry.contribution.kind === kind)
          .sort(compareEntries)
          .map(publicEntry),
      ),
    snapshot,
    subscribe: (listener: (snapshot: WorkspaceContributionSnapshot) => void): (() => void) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
  })
}
