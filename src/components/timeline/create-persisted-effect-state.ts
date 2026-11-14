import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'
import { isAbortError } from '~/lib/dom-errors'
import type { AudioEngine, EngineDisposition } from '@daw-browser/audio-engine/audio-engine'
import { SampledInstrumentSyncSupersededError } from '~/lib/sampled-instrument-sync-error'
import type { DeliveryRegistration, LiveProcessorEditIdentity, ProcessorDelivery } from '~/lib/live-processor-control'
import {
  createParameterGestureOwner,
  type GestureLifetime,
  type ParameterDrain,
  type ParameterSaveResult,
  type ParameterGestureHandle,
} from '~/components/timeline/parameter-gesture-owner'

type PersistedEffectContext = {
  projectId?: string
  userId?: string
  projectGeneration?: number
}

type PersistedEffectStateOptions<TRow, TParams> = {
  targetId: Accessor<string | undefined>
  scopeId?: Accessor<string | undefined>
  row: Accessor<TRow>
  readQueryParams: (row: TRow) => TParams | undefined
  readQueryThrough?: (row: TRow) => number
  readVisibleParams?: (targetId: string) => TParams | undefined
  createInitialParams: (targetId: string) => TParams | undefined
  serializeParams: (params: TParams) => string
  applyToEngine: (targetId: string, params: TParams, edit: LiveProcessorEditIdentity | undefined) => EngineDisposition | Promise<EngineDisposition>
  audioEngine?: Accessor<AudioEngine>
  usesLegacyAudioEngine?: Accessor<boolean>
  clearFromEngine?: (targetId: string) => void
  persistParams: (targetId: string, params: TParams, context: PersistedEffectContext) => ParameterSaveResult | Promise<ParameterSaveResult>
  createPersistContext?: () => PersistedEffectContext
  // Allocation observes the desired transition, not a claim about installed engine content.
  allocateEdit?: (targetId: string, from: TParams | undefined, to: TParams) => LiveProcessorEditIdentity | undefined
  registerDelivery?: (targetId: string, params: TParams, edit: LiveProcessorEditIdentity | undefined, gesture: ProcessorDelivery["gesture"], lifetime: GestureLifetime) => DeliveryRegistration | undefined
  history?: (targetId: string, previous: TParams | undefined, next: TParams, edit: LiveProcessorEditIdentity | undefined, context: PersistedEffectContext) => void
  // The newest release of a target reached its row: playback learns the structural change.
  announce?: (targetId: string, next: TParams, edit: LiveProcessorEditIdentity | undefined) => void | Promise<void>
  // The row the engine held was removed remotely and the engine was cleared: playback learns the structural change.
  announceRemoved?: (targetId: string) => void | Promise<void>
  onPersistError?: (cause: Error, context: PersistedEffectContext | undefined) => void
  onEngineApplyError?: (cause: unknown, context: PersistedEffectContext | undefined) => void
  // A released edit whose portable apply threw: it was not saved.
  onReleaseFailed?: (cause: Error, context: PersistedEffectContext) => void
  isRemote?: () => boolean
  isMissingRowLoaded?: () => boolean
  // Losing write access ends every open gesture without committing it.
  canWrite?: Accessor<boolean>
}

type PersistedEffectState<TParams> = {
  add: () => void
  addForTarget: (targetId: string) => void
  flushPending: () => Promise<ParameterDrain<string>>
  gestureOwner: ParameterGestureHandle
  params: Accessor<TParams | undefined>
  // What the panel shows, the engine plays and the export projection carries: an open preview over the committed value.
  readForTarget: (targetId: string) => TParams | undefined
  // Only what is ahead of the persisted row: an open preview, else a committed value not yet echoed.
  readProvisionalForTarget: (targetId: string) => TParams | undefined
  reset: () => void
  setForTarget: (targetId: string, params: TParams) => void
  syncRemoteForTarget: (targetId: string, params: TParams | undefined, through?: number) => void
  update: (updater: (prev: TParams) => TParams) => void
  updateForTarget: (targetId: string, updater: (prev: TParams) => TParams) => void
}

// The parameter-gesture adapter of a persisted track effect (instrument, arpeggiator) plus the ingestion of its row.
export function createPersistedEffectState<TRow, TParams>(
  options: PersistedEffectStateOptions<TRow, TParams>,
): PersistedEffectState<TParams> {
  const [remoteByTarget, setRemoteByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const registeredFlushers = new Map<string, () => void>()

  const keyForTarget = (targetId: string) => {
    const scopeId = options.scopeId?.()
    return scopeId ? `${scopeId}:${targetId}` : targetId
  }
  const persistContext = (lifetime: GestureLifetime): PersistedEffectContext => ({
    projectId: lifetime.projectId,
    userId: lifetime.userId,
    projectGeneration: lifetime.generation,
  })
  const currentContext = (): PersistedEffectContext => options.createPersistContext?.() ?? {}

  // Every release allocates its edit synchronously, so a project's flusher exists before any of its work awaits.
  const ensureProjectFlusher = (projectId: string | undefined) => {
    if (!projectId || registeredFlushers.has(projectId)) return
    registeredFlushers.set(projectId, registerPendingLocalProjectWriteFlusher('effects', projectId, async () => { await owner.flushPending(projectId) }))
  }

  // Resolves with what the engine answered for the value. A replacement is waited for (it may still fail), but it installed
  // other params: the value itself was superseded. An aborted apply installed nothing.
  const applyToEngine = async (targetId: string, params: TParams, edit: LiveProcessorEditIdentity | undefined): Promise<EngineDisposition> => {
    let apply = Promise.resolve().then(() => options.applyToEngine(targetId, params, edit))
    let replaced = false
    for (;;) {
      try {
        const result = await apply
        return replaced ? 'superseded' : result
      } catch (cause) {
        if (cause instanceof SampledInstrumentSyncSupersededError) {
          apply = cause.replacement
          replaced = true
          continue
        }
        if (isAbortError(cause)) return 'dropped'
        throw cause
      }
    }
  }

  const committed = (targetId: string) => remoteByTarget()[keyForTarget(targetId)] ?? options.readVisibleParams?.(targetId)
  const owner = createParameterGestureOwner<string, TParams>({
    key: keyForTarget,
    scope: () => {
      const context = currentContext()
      return { projectId: context.projectId, userId: context.userId, generation: context.projectGeneration ?? 0 }
    },
    exists: (targetId) => committed(targetId) !== undefined,
    canWrite: () => options.canWrite?.() ?? true,
    equal: (_target, a, b) => options.serializeParams(a) === options.serializeParams(b),
    initial: options.createInitialParams,
    committed,
    rowsReachEngine: () => true,
    apply: applyToEngine,
    registerDelivery: options.registerDelivery,
    rowApplied: (targetId, row, edit) => options.announce?.(targetId, row, edit),
    clear: (targetId) => options.clearFromEngine?.(targetId),
    rowRemoved: (targetId) => options.announceRemoved?.(targetId),
    persist: async (record) => options.persistParams(record.target, record.latest, persistContext(record.lifetime)),
    history: (record) => options.history?.(record.target, record.baseline, record.latest, record.edit, persistContext(record.lifetime)),
    announce: (record) => options.announce?.(record.target, record.latest, record.edit),
    allocateEdit: (targetId, from, to) => {
      ensureProjectFlusher(currentContext().projectId)
      return options.allocateEdit?.(targetId, from, to)
    },
    onError: (stage, cause, record) => {
      const context = record ? persistContext(record.lifetime) : currentContext()
      if (stage === 'persist') options.onPersistError?.(cause instanceof Error ? cause : new Error('The effect could not be saved.'), context)
      else if (record) options.onReleaseFailed?.(cause instanceof Error ? cause : new Error("The effect could not be applied to playback."), context)
      else options.onEngineApplyError?.(cause, context)
    },
  })

  const syncRemote = (targetId: string, nextParams: TParams | undefined, through = 0) => {
    const key = keyForTarget(targetId)
    setRemoteByTarget((prev) => {
      const current = prev[key]
      if (
        current === nextParams
        || (current !== undefined && nextParams !== undefined && options.serializeParams(current) === options.serializeParams(nextParams))
      ) return prev
      return { ...prev, [key]: nextParams }
    })
    owner.external(targetId, nextParams, through)
  }

  createEffect(on(
    () => ({ engine: options.audioEngine?.(), legacy: options.usesLegacyAudioEngine?.() ?? true }),
    (next, previous) => {
      if (previous && (next.engine !== previous.engine || next.legacy && !previous.legacy)) {
        owner.reinstall()
      }
    },
  ))

  if (options.canWrite) {
    createEffect(on(options.canWrite, (canWrite) => {
      if (!canWrite) owner.closeAll('cancel')
    }, { defer: true }))
  }

  createEffect(() => {
    const targetId = options.targetId()
    if (!targetId) return
    const row = options.row()
    if (row === undefined) {
      if (options.isMissingRowLoaded?.()) untrack(() => syncRemote(targetId, undefined))
      return
    }
    const params = options.readQueryParams(row)
    const through = options.readQueryThrough?.(row) ?? 0
    untrack(() => syncRemote(targetId, params, through))
  })

  onCleanup(() => {
    for (const unregister of registeredFlushers.values()) unregister()
    registeredFlushers.clear()
  })

  const params = createMemo(() => {
    const targetId = options.targetId()
    return targetId ? owner.effective(targetId) : undefined
  })
  const addForTarget = (targetId: string) => {
    const initial = options.createInitialParams(targetId)
    if (initial) owner.set(targetId, initial)
  }

  return {
    add: () => {
      const targetId = options.targetId()
      if (targetId) addForTarget(targetId)
    },
    addForTarget,
    flushPending: () => owner.flushPending(),
    gestureOwner: owner.handle(() => options.targetId() ?? ''),
    params,
    readForTarget: owner.effective,
    readProvisionalForTarget: owner.provisional,
    reset: () => {
      const targetId = options.targetId()
      if (!targetId) return
      const initial = options.createInitialParams(targetId)
      if (initial) owner.set(targetId, initial)
    },
    setForTarget: owner.set,
    syncRemoteForTarget: syncRemote,
    update: (updater) => {
      const targetId = options.targetId()
      if (targetId) owner.write(targetId, updater)
    },
    updateForTarget: owner.write,
  }
}
