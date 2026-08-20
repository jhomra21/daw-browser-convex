// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters

export type ExtensionId = string
export type ContributionId = string
export type CommandId = string
export type ShortcutId = string
export type ExtensionCommandValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ExtensionCommandValue[]
  | { readonly [key: string]: ExtensionCommandValue }

export type ShortcutChord = Readonly<{
  mod?: boolean
  alt?: boolean
  shift?: boolean
  key?: string
  code?: string
}>

export type ShortcutCondition =
  | Readonly<{ kind: 'always' }>
  | Readonly<{ kind: 'editable-target'; matches: boolean }>

export type ShortcutResolutionContext = Readonly<{
  editableTarget: boolean
}>

export type CommandHandler = (
  input: ExtensionCommandValue,
  signal: AbortSignal,
) => ExtensionCommandValue | Promise<ExtensionCommandValue>

export type Cleanup = () => void | Promise<void>

export type CommandReplacementPolicy = Readonly<{
  allowed: true
  contract: string
}>

export type AppExtensionCommandDeclaration = Readonly<{
  id: CommandId
  contributionId: ContributionId
  title: string
  replacement?: CommandReplacementPolicy
}>

export type AppExtensionShortcutDeclaration = Readonly<{
  id: ShortcutId
  commandId: CommandId
  chord: ShortcutChord
  conditions?: readonly ShortcutCondition[]
  priority?: number
}>

export type AppExtensionReplacement = Readonly<{
  targetContributionId: ContributionId
  contract: string
}>

export type ExtensionActivationContext = Readonly<{
  extensionId: ExtensionId
  signal: AbortSignal
  bindCommand: (commandId: CommandId, handler: CommandHandler) => void
  addCleanup: (cleanup: Cleanup) => void
}>

export type AppExtensionDefinition = Readonly<{
  id: ExtensionId
  version: string
  commands: readonly AppExtensionCommandDeclaration[]
  shortcuts: readonly AppExtensionShortcutDeclaration[]
  replacements?: readonly AppExtensionReplacement[]
  activate: (context: ExtensionActivationContext) => void | Promise<void>
}>

export type ExtensionDiagnosticKind =
  | 'activation'
  | 'conflict'
  | 'cleanup'
  | 'stale'

export type ExtensionDiagnostic = Readonly<{
  kind: ExtensionDiagnosticKind
  code: string
  message: string
  extensionId?: ExtensionId
  contributionId?: ContributionId
  commandId?: CommandId
  shortcutId?: ShortcutId
}>

export type ExtensionKernelSnapshot = Readonly<{
  generation: number
  extensions: readonly Readonly<{
    id: ExtensionId
    version: string
  }>[]
  commands: readonly Readonly<{
    id: CommandId
    contributionId: ContributionId
    providerId: ExtensionId
    title: string
  }>[]
  shortcuts: readonly Readonly<{
    id: ShortcutId
    commandId: CommandId
    providerId: ExtensionId
    chord: ShortcutChord
    conditions: readonly ShortcutCondition[]
    priority: number
  }>[]
  diagnostics: readonly ExtensionDiagnostic[]
}>

export type ExtensionKernel = Readonly<{
  activate: (definition: AppExtensionDefinition) => Promise<void>
  deactivate: (extensionId: ExtensionId) => Promise<void>
  replace: (definition: AppExtensionDefinition) => Promise<void>
  reload: (definition: AppExtensionDefinition) => Promise<void>
  executeCommand: (
    commandId: CommandId,
    input?: ExtensionCommandValue,
  ) => Promise<ExtensionCommandValue>
  resolveShortcuts: (
    chord: ShortcutChord,
    context?: ShortcutResolutionContext,
  ) => readonly Readonly<{
    shortcutId: ShortcutId
    commandId: CommandId
    providerId: ExtensionId
    priority: number
  }>[]
  snapshot: () => ExtensionKernelSnapshot
  subscribe: (listener: (snapshot: ExtensionKernelSnapshot) => void) => () => void
  dispose: () => Promise<void>
}>

const MAX_ID_LENGTH = 128
const MAX_TITLE_LENGTH = 200
const MAX_VERSION_LENGTH = 64
const MAX_CONTRACT_LENGTH = 128
const MAX_DIAGNOSTICS = 100

const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/

const isBoundedId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 1 &&
  value.length <= MAX_ID_LENGTH &&
  idPattern.test(value)

const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

export const isExtensionId = (value: unknown): value is ExtensionId =>
  isBoundedId(value)

export const isContributionId = (value: unknown): value is ContributionId =>
  isBoundedId(value)

export const isCommandId = (value: unknown): value is CommandId =>
  isBoundedId(value)

export const isShortcutId = (value: unknown): value is ShortcutId =>
  isBoundedId(value)

export const normalizeShortcutChord = (
  chord: Readonly<{
    mod?: boolean
    alt?: boolean
    shift?: boolean
    key?: string
    code?: string
  }>,
): ShortcutChord => {
  const key = typeof chord.key === 'string' ? chord.key.trim().toLowerCase() : undefined
  const code = typeof chord.code === 'string' ? chord.code.trim() : undefined
  if ((key === undefined || key.length === 0) === (code === undefined || code.length === 0)) {
    throw new ExtensionKernelError('invalid-shortcut-chord', 'A shortcut must contain exactly one key or code.')
  }
  return Object.freeze({
    mod: chord.mod === true,
    alt: chord.alt === true,
    shift: chord.shift === true,
    ...(key === undefined ? { code } : { key }),
  })
}

const chordKey = (chord: ShortcutChord): string =>
  `${chord.mod ? '1' : '0'}${chord.alt ? '1' : '0'}${chord.shift ? '1' : '0'}:${chord.key ?? `code:${chord.code}`}`

const conditionsKey = (conditions: readonly ShortcutCondition[]): string =>
  conditions
    .map((condition) =>
      condition.kind === 'always'
        ? 'always'
        : `editable-target:${condition.matches ? '1' : '0'}`,
    )
    .join('|')

const normalizeConditions = (
  conditions: readonly ShortcutCondition[] | undefined,
): readonly ShortcutCondition[] => {
  const source = conditions ?? [{ kind: 'always' }]
  if (source.length === 0 || source.length > 2) {
    throw new ExtensionKernelError('invalid-shortcut-conditions', 'Shortcut conditions are empty or too broad.')
  }
  let hasAlways = false
  let hasEditable = false
  for (const condition of source) {
    if (condition.kind === 'always') {
      if (hasAlways) throw new ExtensionKernelError('invalid-shortcut-conditions', 'Duplicate shortcut condition.')
      hasAlways = true
    } else if (condition.kind === 'editable-target' && typeof condition.matches === 'boolean') {
      if (hasEditable) throw new ExtensionKernelError('invalid-shortcut-conditions', 'Duplicate shortcut condition.')
      hasEditable = true
    } else {
      throw new ExtensionKernelError('invalid-shortcut-conditions', 'Unknown shortcut condition.')
    }
  }
  return Object.freeze([...source])
}

const conditionsMatch = (
  conditions: readonly ShortcutCondition[],
  context: ShortcutResolutionContext,
): boolean =>
  conditions.every((condition) =>
    condition.kind === 'always' || condition.matches === context.editableTarget,
  )

export class ExtensionKernelError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ExtensionKernelError'
    this.code = code
  }
}

type NormalizedCommand = Readonly<{
  id: CommandId
  contributionId: ContributionId
  title: string
  replacement?: CommandReplacementPolicy
}>

type NormalizedShortcut = Readonly<{
  id: ShortcutId
  commandId: CommandId
  chord: ShortcutChord
  conditions: readonly ShortcutCondition[]
  priority: number
}>

type NormalizedDefinition = Readonly<{
  id: ExtensionId
  version: string
  commands: readonly NormalizedCommand[]
  shortcuts: readonly NormalizedShortcut[]
  replacements: readonly AppExtensionReplacement[]
  activate: AppExtensionDefinition['activate']
}>

type CommandEntry = Readonly<{
  declaration: NormalizedCommand
  providerId: ExtensionId
  handler: CommandHandler
}>

type ShortcutEntry = Readonly<{
  declaration: NormalizedShortcut
  providerId: ExtensionId
}>

type Provider = {
  definition: NormalizedDefinition
  generation: number
  contextState: 'staged' | 'active' | 'stale'
  controller: AbortController
  cleanups: Cleanup[]
  cleanupStarted: boolean
  commands: Map<CommandId, CommandEntry>
  shortcuts: Map<ShortcutId, ShortcutEntry>
  replaced: Map<ContributionId, CommandEntry>
}

type Registry = {
  commands: Map<CommandId, CommandEntry>
  shortcuts: Map<ShortcutId, ShortcutEntry>
}

const emptyRegistry = (): Registry => ({
  commands: new Map(),
  shortcuts: new Map(),
})

const copyRegistry = (registry: Registry): Registry => ({
  commands: new Map(registry.commands),
  shortcuts: new Map(registry.shortcuts),
})

const validateDefinition = (definition: AppExtensionDefinition): NormalizedDefinition => {
  if (!isExtensionId(definition.id)) {
    throw new ExtensionKernelError('invalid-extension-id', 'Extension ID is not a bounded namespaced ID.')
  }
  if (!isBoundedText(definition.version, MAX_VERSION_LENGTH)) {
    throw new ExtensionKernelError('invalid-extension-version', 'Extension version is invalid.')
  }
  if (!Array.isArray(definition.commands) || !Array.isArray(definition.shortcuts)) {
    throw new ExtensionKernelError('invalid-extension-definition', 'Commands and shortcuts must be arrays.')
  }
  const commands: NormalizedCommand[] = []
  const commandIds = new Set<string>()
  const contributionIds = new Set<string>()
  for (const command of definition.commands) {
    if (!isCommandId(command.id) || commandIds.has(command.id)) {
      throw new ExtensionKernelError('duplicate-command-id', 'Command IDs must be unique and valid.')
    }
    if (!isContributionId(command.contributionId) || contributionIds.has(command.contributionId)) {
      throw new ExtensionKernelError('duplicate-contribution-id', 'Contribution IDs must be unique and valid.')
    }
    if (!isBoundedText(command.title, MAX_TITLE_LENGTH)) {
      throw new ExtensionKernelError('invalid-command-title', 'Command titles are bounded and non-empty.')
    }
    if (
      command.replacement !== undefined &&
      (command.replacement.allowed !== true ||
        !isBoundedText(command.replacement.contract, MAX_CONTRACT_LENGTH))
    ) {
      throw new ExtensionKernelError('invalid-replacement-contract', 'Replacement contracts are invalid.')
    }
    commandIds.add(command.id)
    contributionIds.add(command.contributionId)
    const normalizedCommand: NormalizedCommand = {
      id: command.id,
      contributionId: command.contributionId,
      title: command.title,
    }
    if (command.replacement !== undefined) {
      commands.push(Object.freeze({
        ...normalizedCommand,
        replacement: Object.freeze({
          allowed: true,
          contract: command.replacement.contract,
        }),
      }))
    } else {
      commands.push(Object.freeze(normalizedCommand))
    }
  }
  const replacements: AppExtensionReplacement[] = []
  const replacementTargets = new Set<string>()
  for (const replacement of definition.replacements ?? []) {
    if (
      !isContributionId(replacement.targetContributionId) ||
      replacementTargets.has(replacement.targetContributionId) ||
      !isBoundedText(replacement.contract, MAX_CONTRACT_LENGTH)
    ) {
      throw new ExtensionKernelError('invalid-replacement', 'Replacement intents must be unique and bounded.')
    }
    replacementTargets.add(replacement.targetContributionId)
    replacements.push(Object.freeze({
      targetContributionId: replacement.targetContributionId,
      contract: replacement.contract,
    }))
  }
  const shortcuts: NormalizedShortcut[] = []
  const shortcutIds = new Set<string>()
  for (const shortcut of definition.shortcuts) {
    if (!isShortcutId(shortcut.id) || shortcutIds.has(shortcut.id)) {
      throw new ExtensionKernelError('duplicate-shortcut-id', 'Shortcut IDs must be unique and valid.')
    }
    if (!isCommandId(shortcut.commandId) || !commandIds.has(shortcut.commandId)) {
      throw new ExtensionKernelError('shortcut-command-missing', 'Shortcuts must reference a declared command.')
    }
    const priority = shortcut.priority ?? 0
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
      throw new ExtensionKernelError('invalid-shortcut-priority', 'Shortcut priority is outside the bounded range.')
    }
    shortcutIds.add(shortcut.id)
    shortcuts.push(Object.freeze({
      id: shortcut.id,
      commandId: shortcut.commandId,
      chord: normalizeShortcutChord(shortcut.chord),
      conditions: normalizeConditions(shortcut.conditions),
      priority,
    }))
  }
  return Object.freeze({
    id: definition.id,
    version: definition.version,
    commands: Object.freeze(commands),
    shortcuts: Object.freeze(shortcuts),
    replacements: Object.freeze(replacements),
    activate: definition.activate,
  })
}

export const createExtensionKernel = (): ExtensionKernel => {
  let registry = emptyRegistry()
  let registryVersion = 0
  let generation = 0
  let disposed = false
  const providers = new Map<ExtensionId, Provider>()
  const stagedProviders = new Map<ExtensionId, Provider>()
  const subscribers = new Set<(snapshot: ExtensionKernelSnapshot) => void>()
  let diagnostics: ExtensionDiagnostic[] = []

  const addDiagnostic = (diagnostic: ExtensionDiagnostic): void => {
    diagnostics = [...diagnostics, Object.freeze(diagnostic)].slice(-MAX_DIAGNOSTICS)
  }

  const snapshot = (): ExtensionKernelSnapshot => {
    const activeProviders = [...providers.values()]
      .filter((provider) => provider.contextState === 'active')
      .sort((left, right) => left.generation - right.generation)
    const result: ExtensionKernelSnapshot = Object.freeze({
      generation,
      extensions: Object.freeze(activeProviders.map((provider) => Object.freeze({
        id: provider.definition.id,
        version: provider.definition.version,
      }))),
      commands: Object.freeze([...registry.commands.values()].map((entry) => Object.freeze({
        id: entry.declaration.id,
        contributionId: entry.declaration.contributionId,
        providerId: entry.providerId,
        title: entry.declaration.title,
      }))),
      shortcuts: Object.freeze([...registry.shortcuts.values()].map((entry) => Object.freeze({
        id: entry.declaration.id,
        commandId: entry.declaration.commandId,
        providerId: entry.providerId,
        chord: entry.declaration.chord,
        conditions: entry.declaration.conditions,
        priority: entry.declaration.priority,
      }))),
      diagnostics: Object.freeze([...diagnostics]),
    })
    return result
  }

  const notify = (): void => {
    const current = snapshot()
    for (const listener of subscribers) listener(current)
  }

  const fail = (
    kind: ExtensionDiagnosticKind,
    code: string,
    message: string,
    details: Pick<ExtensionDiagnostic, 'extensionId' | 'contributionId' | 'commandId' | 'shortcutId'> = {},
  ): ExtensionKernelError => {
    addDiagnostic({ kind, code, message, ...details })
    return new ExtensionKernelError(code, message)
  }

  const ensureAvailable = (): void => {
    if (disposed) throw fail('stale', 'kernel-disposed', 'Extension kernel is disposed.')
  }

  const findCommandByContribution = (
    source: Registry,
    contributionId: ContributionId,
  ): CommandEntry | undefined =>
    [...source.commands.values()].find(
      (entry) => entry.declaration.contributionId === contributionId,
    )

  const hasContribution = (source: Registry, contributionId: ContributionId): boolean =>
    findCommandByContribution(source, contributionId) !== undefined

  const hasProtectedProvider = (extensionId: ExtensionId): boolean =>
    [...providers.values()].some((provider) =>
      provider.contextState === 'active' &&
      [...provider.replaced.values()].some((entry) => entry.providerId === extensionId),
    )

  const cleanupProvider = async (provider: Provider): Promise<void> => {
    if (provider.cleanupStarted) return
    provider.cleanupStarted = true
    for (let index = provider.cleanups.length - 1; index >= 0; index -= 1) {
      const cleanup = provider.cleanups[index]
      try {
        await cleanup()
      } catch (error) {
        addDiagnostic({
          kind: 'cleanup',
          code: 'cleanup-failed',
          message: error instanceof Error ? error.message : 'Unknown extension error.',
          extensionId: provider.definition.id,
        })
      }
    }
  }

  const staleProvider = (provider: Provider): void => {
    if (provider.contextState === 'stale') return
    provider.contextState = 'stale'
    provider.controller.abort()
  }

  const registryWithoutProvider = (source: Registry, provider: Provider): Registry => {
    const next = copyRegistry(source)
    for (const [commandId, entry] of provider.commands) {
      if (next.commands.get(commandId) === entry) next.commands.delete(commandId)
    }
    for (const [shortcutId, entry] of provider.shortcuts) {
      if (next.shortcuts.get(shortcutId) === entry) next.shortcuts.delete(shortcutId)
    }
    for (const [targetContributionId, previous] of provider.replaced) {
      const current = next.commands.get(previous.declaration.id)
      const replacement = provider.commands.get(previous.declaration.id)
      if (
        current === undefined ||
        current === replacement ||
        current.declaration.contributionId === targetContributionId
      ) {
        next.commands.set(previous.declaration.id, previous)
      }
    }
    return next
  }

  type StageMode = 'activate' | 'replace' | 'reload'

  const stage = async (
    definition: AppExtensionDefinition,
    mode: StageMode,
  ): Promise<Provider> => {
    ensureAvailable()
    let normalized: NormalizedDefinition
    try {
      normalized = validateDefinition(definition)
    } catch (error) {
      const kernelError = error instanceof ExtensionKernelError ? error : undefined
      addDiagnostic({
        kind: 'activation',
        code: kernelError?.code ?? 'invalid-extension-definition',
        message: error instanceof Error ? error.message : 'Invalid extension definition.',
        extensionId: typeof definition.id === 'string' ? definition.id : undefined,
      })
      throw error
    }
    const existing = providers.get(normalized.id)
    if (
      stagedProviders.has(normalized.id) ||
      (existing !== undefined && (mode !== 'reload' || existing.contextState !== 'active'))
    ) {
      throw fail('conflict', 'duplicate-extension-id', 'An extension with this ID is already active.', {
        extensionId: normalized.id,
      })
    }
    if (mode === 'activate' && normalized.replacements.length > 0) {
      throw fail('conflict', 'replacement-required', 'Replacement intents require replace().', {
        extensionId: normalized.id,
      })
    }
    if (mode === 'reload' && existing !== undefined && hasProtectedProvider(normalized.id)) {
      throw fail('conflict', 'provider-replaced', 'A replaced provider must remain until its replacement deactivates.', {
        extensionId: normalized.id,
      })
    }
    const baseRegistry = existing === undefined
      ? registry
      : registryWithoutProvider(registry, existing)
    const baseRegistryVersion = registryVersion
    const controller = new AbortController()
    const provider: Provider = {
      definition: normalized,
      generation: ++generation,
      contextState: 'staged',
      controller,
      cleanups: [],
      cleanupStarted: false,
      commands: new Map(),
      shortcuts: new Map(),
      replaced: new Map(),
    }
    stagedProviders.set(normalized.id, provider)
    const context: ExtensionActivationContext = Object.freeze({
      extensionId: normalized.id,
      signal: controller.signal,
      bindCommand: (commandId, handler) => {
        if (provider.contextState !== 'staged') {
          throw fail('stale', 'stale-context', 'Extension activation context is stale.', {
            extensionId: normalized.id,
            commandId,
          })
        }
        if (typeof handler !== 'function') {
          throw fail('activation', 'invalid-command-handler', 'Command handler must be a function.', {
            extensionId: normalized.id,
            commandId,
          })
        }
        const declaration = normalized.commands.find((command) => command.id === commandId)
        if (declaration === undefined) {
          throw fail('activation', 'undeclared-command-binding', 'Only statically declared commands may be bound.', {
            extensionId: normalized.id,
            commandId,
          })
        }
        if (provider.commands.has(commandId)) {
          throw fail('activation', 'duplicate-command-binding', 'A command may only be bound once.', {
            extensionId: normalized.id,
            commandId,
          })
        }
        provider.commands.set(commandId, Object.freeze({ declaration, providerId: normalized.id, handler }))
      },
      addCleanup: (cleanup) => {
        if (provider.contextState !== 'staged') {
          throw fail('stale', 'stale-context', 'Extension activation context is stale.', {
            extensionId: normalized.id,
          })
        }
        if (typeof cleanup !== 'function') {
          throw fail('activation', 'invalid-cleanup', 'Cleanup must be a function.', {
            extensionId: normalized.id,
          })
        }
        provider.cleanups.push(cleanup)
      },
    })
    try {
      await normalized.activate(context)
      if (provider.contextState !== 'staged' || controller.signal.aborted) {
        throw fail('stale', 'stale-generation', 'Extension activation generation is stale.', {
          extensionId: normalized.id,
        })
      }
      for (const command of normalized.commands) {
        if (!provider.commands.has(command.id)) {
          throw fail('activation', 'missing-command-binding', 'Every declared command must be bound.', {
            extensionId: normalized.id,
            commandId: command.id,
          })
        }
      }
      const stagedRegistry = copyRegistry(baseRegistry)
      for (const shortcut of normalized.shortcuts) {
        const binding = provider.commands.get(shortcut.commandId)
        if (binding === undefined) {
          throw fail('activation', 'missing-shortcut-command', 'Shortcut command binding is missing.', {
            extensionId: normalized.id,
            commandId: shortcut.commandId,
            shortcutId: shortcut.id,
          })
        }
        if (stagedRegistry.shortcuts.has(shortcut.id)) {
          throw fail('conflict', 'duplicate-shortcut-id', 'Shortcut ID is already registered.', {
            extensionId: normalized.id,
            shortcutId: shortcut.id,
          })
        }
        const key = `${chordKey(shortcut.chord)}|${conditionsKey(shortcut.conditions)}`
        const conflict = [...stagedRegistry.shortcuts.values()].find((entry) => {
          const other = entry.declaration
          return `${chordKey(other.chord)}|${conditionsKey(other.conditions)}` === key &&
            other.priority === shortcut.priority
        })
        if (conflict !== undefined) {
          throw fail('conflict', 'shortcut-conflict', 'Shortcut chord and priority conflict.', {
            extensionId: normalized.id,
            shortcutId: shortcut.id,
          })
        }
        const entry = Object.freeze({ declaration: shortcut, providerId: normalized.id })
        provider.shortcuts.set(shortcut.id, entry)
        stagedRegistry.shortcuts.set(shortcut.id, entry)
      }
      for (const replacement of normalized.replacements) {
        const target = findCommandByContribution(stagedRegistry, replacement.targetContributionId)
        if (target === undefined) {
          throw fail('conflict', 'replacement-target-absent', 'Replacement target is not active.', {
            extensionId: normalized.id,
            contributionId: replacement.targetContributionId,
          })
        }
        if (target.declaration.replacement === undefined) {
          throw fail('conflict', 'replacement-not-allowed', 'Replacement target does not allow replacement.', {
            extensionId: normalized.id,
            contributionId: replacement.targetContributionId,
          })
        }
        if (target.declaration.replacement.contract !== replacement.contract) {
          throw fail('conflict', 'replacement-contract-mismatch', 'Replacement contract does not match the target.', {
            extensionId: normalized.id,
            contributionId: replacement.targetContributionId,
          })
        }
        if (provider.replaced.has(replacement.targetContributionId) ||
            target.declaration.contributionId === normalized.commands.find(
              (command) => command.id === target.declaration.id,
            )?.contributionId ||
            [...providers.values()].some((candidate) =>
              candidate !== existing &&
              candidate.contextState === 'active' &&
              [...candidate.replaced.values()].some(
                (entry) => entry.declaration.id === target.declaration.id,
              ),
            )) {
          throw fail('conflict', 'replacement-cycle', 'Nested or cyclic replacement is not supported.', {
            extensionId: normalized.id,
            contributionId: replacement.targetContributionId,
          })
        }
        const replacementBinding = provider.commands.get(target.declaration.id)
        if (replacementBinding === undefined) {
          throw fail('activation', 'replacement-command-missing', 'Replacement must declare the target command.', {
            extensionId: normalized.id,
            commandId: target.declaration.id,
          })
        }
        provider.replaced.set(replacement.targetContributionId, target)
        stagedRegistry.commands.set(target.declaration.id, replacementBinding)
      }
      for (const command of normalized.commands) {
        if (hasContribution(baseRegistry, command.contributionId)) {
          throw fail('conflict', 'duplicate-contribution-id', 'Contribution ID is already registered.', {
            extensionId: normalized.id,
            contributionId: command.contributionId,
          })
        }
      }
      for (const [commandId, binding] of provider.commands) {
        if ([...provider.replaced.values()].some(
          (previous) => previous.declaration.id === commandId,
        )) continue
        const existing = stagedRegistry.commands.get(commandId)
        if (existing !== undefined) {
          throw fail('conflict', 'duplicate-command-id', 'Command ID is already registered.', {
            extensionId: normalized.id,
            commandId,
          })
        }
        stagedRegistry.commands.set(commandId, binding)
      }
      if (
        disposed ||
        registryVersion !== baseRegistryVersion ||
        (mode === 'reload' && providers.get(normalized.id) !== existing)
      ) {
        throw fail('stale', 'stale-generation', 'Extension activation generation is stale.', {
          extensionId: normalized.id,
        })
      }
      const reloadedProvider = mode === 'reload' ? existing : undefined
      provider.contextState = 'active'
      registry = stagedRegistry
      registryVersion += 1
      stagedProviders.delete(normalized.id)
      providers.set(normalized.id, provider)
      if (reloadedProvider !== undefined) {
        staleProvider(reloadedProvider)
      }
      notify()
      if (reloadedProvider !== undefined) {
        await cleanupProvider(reloadedProvider)
      }
      notify()
      return provider
    } catch (error) {
      staleProvider(provider)
      await cleanupProvider(provider)
      stagedProviders.delete(normalized.id)
      notify()
      if (error instanceof ExtensionKernelError) throw error
      throw fail(
        'activation',
        'activation-failed',
        error instanceof Error ? error.message : 'Unknown extension error.',
        { extensionId: normalized.id },
      )
    }
  }

  const deactivate = async (extensionId: ExtensionId): Promise<void> => {
    ensureAvailable()
    const provider = providers.get(extensionId)
    if (provider === undefined) return
    if (provider.contextState !== 'active') return
    if (hasProtectedProvider(extensionId)) {
      throw fail('conflict', 'provider-replaced', 'A replaced provider must remain until its replacement deactivates.', {
        extensionId,
      })
    }
    registry = registryWithoutProvider(registry, provider)
    registryVersion += 1
    staleProvider(provider)
    providers.delete(extensionId)
    notify()
    await cleanupProvider(provider)
    notify()
  }

  const activate = async (definition: AppExtensionDefinition): Promise<void> => {
    await stage(definition, 'activate')
  }

  const replace = async (definition: AppExtensionDefinition): Promise<void> => {
    await stage(definition, 'replace')
  }

  const reload = async (definition: AppExtensionDefinition): Promise<void> => {
    const existing = providers.get(definition.id)
    if (existing === undefined) {
      await activate(definition)
      return
    }
    await stage(definition, 'reload')
  }

  const executeCommand = async (
    commandId: CommandId,
    input?: ExtensionCommandValue,
  ): Promise<ExtensionCommandValue> => {
    ensureAvailable()
    const entry = registry.commands.get(commandId)
    if (entry === undefined) {
      throw fail('activation', 'command-not-found', 'Command is not registered.', { commandId })
    }
    return entry.handler(input, providers.get(entry.providerId)?.controller.signal ?? new AbortController().signal)
  }

  const resolveShortcuts = (
    chord: ShortcutChord,
    context: ShortcutResolutionContext = { editableTarget: false },
  ): readonly Readonly<{
    shortcutId: ShortcutId
    commandId: CommandId
    providerId: ExtensionId
    priority: number
  }>[] => {
    const normalized = normalizeShortcutChord(chord)
    return Object.freeze([...registry.shortcuts.values()]
      .filter((entry) =>
        chordKey(entry.declaration.chord) === chordKey(normalized) &&
        conditionsMatch(entry.declaration.conditions, context),
      )
      .sort((left, right) => right.declaration.priority - left.declaration.priority)
      .map((entry) => Object.freeze({
        shortcutId: entry.declaration.id,
        commandId: entry.declaration.commandId,
        providerId: entry.providerId,
        priority: entry.declaration.priority,
      })))
  }

  const subscribe = (listener: (current: ExtensionKernelSnapshot) => void): (() => void) => {
    subscribers.add(listener)
    listener(snapshot())
    return () => subscribers.delete(listener)
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    const current = [...providers.values()].sort((left, right) => right.generation - left.generation)
    registry = emptyRegistry()
    registryVersion += 1
    const staged = [...stagedProviders.values()]
    for (const provider of [...current, ...staged]) staleProvider(provider)
    providers.clear()
    stagedProviders.clear()
    notify()
    for (const provider of [...current, ...staged]) await cleanupProvider(provider)
    subscribers.clear()
  }

  return Object.freeze({
    activate,
    deactivate,
    replace,
    reload,
    executeCommand,
    resolveShortcuts,
    snapshot,
    subscribe,
    dispose,
  })
}
