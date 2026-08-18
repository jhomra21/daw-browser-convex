import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from 'solid-js'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'

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
  readVisibleParams?: (targetId: string) => TParams | undefined
  createInitialParams: (targetId: string) => TParams | undefined
  serializeParams: (params: TParams) => string
  applyToEngine: (targetId: string, params: TParams) => void | Promise<void>
  clearFromEngine?: (targetId: string) => void
  persistParams: (targetId: string, params: TParams, context: PersistedEffectContext) => void | Promise<void>
  persistRemove?: (targetId: string, context: PersistedEffectContext) => void | Promise<void>
  clearAfterPersistRemove?: (context: PersistedEffectContext) => boolean
  createPersistContext?: () => PersistedEffectContext
  onParamsApplied?: (targetId: string, previous: TParams | undefined, next: TParams) => void
  onApplyCompleted?: (
    targetId: string,
    previous: TParams | undefined,
    next: TParams,
    context?: PersistedEffectContext,
  ) => void
  onEngineStateChanged?: (
    targetId: string,
    previous: TParams | undefined,
    next: TParams,
    source: 'remote',
    context?: PersistedEffectContext,
  ) => void
  onPersistError?: (cause: unknown) => void
  onParamsCommitted?: (
    targetId: string,
    previous: TParams | undefined,
    next: TParams,
    context: PersistedEffectContext,
  ) => void
  onQueryRow?: (targetId: string, row: TRow) => void
  isRemote?: () => boolean
  isMissingRowLoaded?: () => boolean
  debounceMs?: number
  remoteOverwriteAfterMs?: number
}

type PersistedEffectState<TParams> = {
  add: () => void
  addForTarget: (targetId: string) => void
  flushPending: () => Promise<void>
  params: Accessor<TParams | undefined>
  readDraftForTarget: (targetId: string) => TParams | undefined
  readForTarget: (targetId: string) => TParams | undefined
  removeForTarget: (targetId: string) => boolean
  reset: () => void
  setForTarget: (targetId: string, params: TParams) => void
  syncRemoteForTarget: (targetId: string, params: TParams | undefined) => void
  update: (updater: (prev: TParams) => TParams) => void
  updateForTarget: (targetId: string, updater: (prev: TParams) => TParams) => void
}

type PendingParamsCommit<TParams> = {
  targetId: string
  previous: TParams | undefined
  next: TParams
  serialized: string
}

type PendingRemoteApply<TParams> = {
  targetId: string
  next: TParams | undefined
  serialized: string | undefined
}

export function createPersistedEffectState<TRow, TParams>(
  options: PersistedEffectStateOptions<TRow, TParams>,
): PersistedEffectState<TParams> {
  const [remoteByTarget, setRemoteByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const [draftByTarget, setDraftByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const [deletedByTarget, setDeletedByTarget] = createSignal<Record<string, true | undefined>>({})
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastLocalEdit = new Map<string, number>()
  const persistAttemptByTarget = new Map<string, number>()
  const persistContextByTarget = new Map<string, PersistedEffectContext>()
  const targetByKey = new Map<string, string>()
  const pendingCommitByTarget = new Map<string, PendingParamsCommit<TParams>>()
  const pendingApplyByTarget = new Map<string, Promise<void>>()
  const pendingRemoteApplyByTarget = new Map<string, PendingRemoteApply<TParams>>()
  const pendingWritesByProject = new Map<string, Set<Promise<void>>>()
  const registeredFlushers = new Map<string, () => void>()
  const appliedEngineStateByTarget = new Map<string, string | undefined>()
  const appliedEngineParamsByTarget = new Map<string, TParams | undefined>()

  function keyForTarget(targetId: string) {
    const scopeId = options.scopeId?.()
    return scopeId ? `${scopeId}:${targetId}` : targetId
  }

  function clearDraft(targetId: string, key = keyForTarget(targetId)) {
    const timer = saveTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(key)
    }
    persistAttemptByTarget.delete(key)
    persistContextByTarget.delete(key)
    targetByKey.delete(key)
    pendingCommitByTarget.delete(key)
    pendingRemoteApplyByTarget.delete(key)
    lastLocalEdit.delete(key)
    setDraftByTarget((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function clearDeleted(key: string) {
    setDeletedByTarget((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function clearReconciledDraft(targetId: string, key = keyForTarget(targetId)) {
    const timer = saveTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(key)
    }
    targetByKey.delete(key)
    pendingRemoteApplyByTarget.delete(key)
    lastLocalEdit.delete(key)
    setDraftByTarget((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function readCurrent(targetId: string) {
    const key = keyForTarget(targetId)
    if (deletedByTarget()[key]) return undefined
    return draftByTarget()[key]
      ?? remoteByTarget()[key]
      ?? options.readVisibleParams?.(targetId)
  }

  function flushTarget(targetId: string, key = keyForTarget(targetId)) {
    const timer = saveTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    saveTimers.delete(key)
    const params = draftByTarget()[key]
    if (!params) return
    persistNow(targetId, key, params, persistContextByTarget.get(key) ?? {})
  }

  function persistNow(targetId: string, key: string, params: TParams, context: PersistedEffectContext) {
    const attempt = (persistAttemptByTarget.get(key) ?? 0) + 1
    persistAttemptByTarget.set(key, attempt)
    const serialized = options.serializeParams(params)
    const write = Promise.resolve()
      .then(() => options.persistParams(targetId, params, context))
      .then(
        () => {
          if (persistAttemptByTarget.get(key) !== attempt) return
          const pendingCommit = pendingCommitByTarget.get(key)
          if (!pendingCommit || pendingCommit.serialized !== serialized) return
          options.onParamsCommitted?.(pendingCommit.targetId, pendingCommit.previous, pendingCommit.next, context)
          pendingCommitByTarget.delete(key)
          const current = untrack(() => draftByTarget()[key])
          if (!current || options.serializeParams(current) === serialized) {
            persistAttemptByTarget.delete(key)
            persistContextByTarget.delete(key)
          }
        },
        (cause) => {
          if (persistAttemptByTarget.get(key) !== attempt) return
          const current = untrack(() => draftByTarget()[key])
          if (!current) return
          if (options.serializeParams(current) !== serialized) return
          options.onPersistError?.(cause)
          persistAttemptByTarget.delete(key)
          throw cause
        },
      )
      .then(() => undefined)
      .finally(() => {
        if (!context.projectId) return
        const pendingWrites = pendingWritesByProject.get(context.projectId)
        pendingWrites?.delete(write)
        if (pendingWrites?.size === 0) pendingWritesByProject.delete(context.projectId)
      })
    if (context.projectId) {
      const pendingWrites = pendingWritesByProject.get(context.projectId) ?? new Set<Promise<void>>()
      pendingWrites.add(write)
      pendingWritesByProject.set(context.projectId, pendingWrites)
    }
    void write.catch(() => undefined)
  }

  function persistRemoveNow(targetId: string, key: string, context: PersistedEffectContext) {
    if (!options.persistRemove) return
    const attempt = (persistAttemptByTarget.get(key) ?? 0) + 1
    persistAttemptByTarget.set(key, attempt)
    const write = Promise.resolve()
      .then(() => options.persistRemove?.(targetId, context))
      .then(
        () => {
          if (persistAttemptByTarget.get(key) !== attempt) return
          persistAttemptByTarget.delete(key)
          persistContextByTarget.delete(key)
          targetByKey.delete(key)
          if (options.clearAfterPersistRemove?.(context) ?? true) {
            syncRemote(targetId, undefined)
            clearDeleted(key)
          }
        },
        (cause) => {
          if (persistAttemptByTarget.get(key) !== attempt) return
          options.onPersistError?.(cause)
          persistAttemptByTarget.delete(key)
          persistContextByTarget.delete(key)
          targetByKey.delete(key)
          clearDeleted(key)
          throw cause
        },
      )
      .then(() => undefined)
      .finally(() => {
        if (!context.projectId) return
        const pendingWrites = pendingWritesByProject.get(context.projectId)
        pendingWrites?.delete(write)
        if (pendingWrites?.size === 0) pendingWritesByProject.delete(context.projectId)
      })
    if (context.projectId) {
      const pendingWrites = pendingWritesByProject.get(context.projectId) ?? new Set<Promise<void>>()
      pendingWrites.add(write)
      pendingWritesByProject.set(context.projectId, pendingWrites)
    }
    void write.catch(() => undefined)
  }

  function ensureProjectFlusher(projectId: string) {
    if (registeredFlushers.has(projectId)) return
    registeredFlushers.set(projectId, registerPendingLocalProjectWriteFlusher('effects', projectId, async () => {
      await flushPending(projectId)
    }))
  }

  function persistOrSchedule(targetId: string, key: string, params: TParams) {
    targetByKey.set(key, targetId)
    const debounceMs = options.debounceMs ?? 0
    if (debounceMs <= 0) {
      persistNow(targetId, key, params, persistContextByTarget.get(key) ?? {})
      return
    }

    const previousTimer = saveTimers.get(key)
    if (previousTimer) clearTimeout(previousTimer)
    // Batch quick effect tweaks into one persistence write and cancel any
    // leftover timers during cleanup.
    saveTimers.set(key, setTimeout(() => flushTarget(targetId, key), debounceMs))
  }

  function applyParams(
    targetId: string,
    previous: TParams | undefined,
    next: TParams,
  ) {
    const key = keyForTarget(targetId)
    const serializedNext = options.serializeParams(next)
    if (previous !== undefined && options.serializeParams(previous) === serializedNext) return
    pendingRemoteApplyByTarget.delete(key)
    const pendingCommit = pendingCommitByTarget.get(key)
    lastLocalEdit.set(key, Date.now())
    const context = options.createPersistContext?.() ?? {}
    if (context.projectId) ensureProjectFlusher(context.projectId)
    persistContextByTarget.set(key, context)
    targetByKey.set(key, targetId)
    setDraftByTarget((prev) => ({
      ...prev,
      [key]: next,
    }))
    clearDeleted(key)
    pendingCommitByTarget.set(key, {
      targetId,
      previous: pendingCommit?.previous ?? previous,
      next,
      serialized: serializedNext,
    })
    const previousApply = pendingApplyByTarget.get(key)
    const runApply = () => options.applyToEngine(targetId, next)
    const apply = previousApply
      ? previousApply.then(runApply, runApply)
      : Promise.resolve(runApply())
    options.onParamsApplied?.(targetId, previous, next)
    pendingApplyByTarget.set(key, apply)
    void apply
      .then(() => {
        if (pendingApplyByTarget.get(key) !== apply) return
        pendingApplyByTarget.delete(key)
        pendingRemoteApplyByTarget.delete(key)
        appliedEngineStateByTarget.set(key, serializedNext)
        appliedEngineParamsByTarget.set(key, next)
        persistOrSchedule(targetId, key, next)
        options.onApplyCompleted?.(targetId, previous, next, persistContextByTarget.get(key))
      })
      .catch((cause: unknown) => {
        if (pendingApplyByTarget.get(key) === apply) pendingApplyByTarget.delete(key)
        options.onPersistError?.(cause)
      })
  }

  function applyLocalClearToEngine(targetId: string) {
    const key = keyForTarget(targetId)
    pendingRemoteApplyByTarget.delete(key)
    const previousApply = pendingApplyByTarget.get(key)
    const runClear = () => options.clearFromEngine?.(targetId)
    const apply = previousApply
      ? previousApply.then(runClear, runClear)
      : Promise.resolve(runClear())
    pendingApplyByTarget.set(key, apply)
    void apply.then(() => {
      if (pendingApplyByTarget.get(key) !== apply) return
      pendingApplyByTarget.delete(key)
      appliedEngineStateByTarget.set(key, undefined)
      appliedEngineParamsByTarget.set(key, undefined)
    }).catch((cause: unknown) => {
      if (pendingApplyByTarget.get(key) === apply) pendingApplyByTarget.delete(key)
      options.onPersistError?.(cause)
    })
  }

  function applyRemoteToEngine(targetId: string, next: TParams | undefined, capturedKey = keyForTarget(targetId)) {
    const key = capturedKey
    if (options.scopeId && key !== keyForTarget(targetId)) return
    if (draftByTarget()[key] || deletedByTarget()[key]) return
    const serialized = next === undefined ? undefined : options.serializeParams(next)
    if (
      appliedEngineStateByTarget.has(key)
      && appliedEngineStateByTarget.get(key) === serialized
    ) return
    if (pendingApplyByTarget.has(key)) {
      pendingRemoteApplyByTarget.set(key, { targetId, next, serialized })
      return
    }
    const applyContext = options.createPersistContext?.()
    const previous = appliedEngineParamsByTarget.get(key)
    const applied = next === undefined
      ? options.clearFromEngine?.(targetId)
      : options.applyToEngine(targetId, next)
    const apply = Promise.resolve(applied)
    pendingApplyByTarget.set(key, apply)
    void apply.then(() => {
      if (pendingApplyByTarget.get(key) !== apply) return
      if (options.scopeId && key !== keyForTarget(targetId)) {
        pendingApplyByTarget.delete(key)
        pendingRemoteApplyByTarget.delete(key)
        return
      }
      pendingApplyByTarget.delete(key)
      const queued = pendingRemoteApplyByTarget.get(key)
      pendingRemoteApplyByTarget.delete(key)
      appliedEngineStateByTarget.set(key, serialized)
      appliedEngineParamsByTarget.set(key, next)

      const remoteSnapshot = untrack(() => remoteByTarget())
      const currentRemote = queued ?? (key in remoteSnapshot
        ? {
            targetId,
            next: remoteSnapshot[key],
            serialized: remoteSnapshot[key] === undefined
              ? undefined
              : options.serializeParams(remoteSnapshot[key]),
          }
        : undefined)
      const hasLocalState = untrack(() => Boolean(draftByTarget()[key] || deletedByTarget()[key]))
      const shouldReplay = (
        currentRemote !== undefined
        && !hasLocalState
        && currentRemote.serialized !== serialized
      )
      if (shouldReplay) {
        applyRemoteToEngine(targetId, currentRemote.next, key)
        return
      }
      if (currentRemote?.serialized === serialized && next !== undefined) {
        options.onEngineStateChanged?.(targetId, previous, next, 'remote', applyContext)
      }
    }).catch((cause: unknown) => {
      if (pendingApplyByTarget.get(key) !== apply) return
      pendingApplyByTarget.delete(key)
      pendingRemoteApplyByTarget.delete(key)
      options.onPersistError?.(cause)
      const remoteSnapshot = untrack(() => remoteByTarget())
      const currentRemote = key in remoteSnapshot
        ? {
            next: remoteSnapshot[key],
            serialized: remoteSnapshot[key] === undefined
              ? undefined
              : options.serializeParams(remoteSnapshot[key]),
          }
        : undefined
      const hasLocalState = untrack(() => Boolean(draftByTarget()[key] || deletedByTarget()[key]))
      if (
        currentRemote !== undefined
        && !hasLocalState
        && currentRemote.serialized !== serialized
      ) {
        applyRemoteToEngine(targetId, currentRemote.next, key)
      }
    })
  }

  function applyUpdate(targetId: string, updater: (prev: TParams) => TParams) {
    const previous = readCurrent(targetId)
    const initial = previous ?? options.createInitialParams(targetId)
    if (!initial) return
    applyParams(targetId, previous, updater(initial))
  }

  const params = createMemo(() => {
    const targetId = options.targetId()
    if (!targetId) return undefined
    return readCurrent(targetId)
  })

  function syncRemote(targetId: string, nextParams: TParams | undefined) {
    const key = keyForTarget(targetId)
    setRemoteByTarget((prev) => {
      const current = prev[key]
      if (
        current === nextParams ||
        (
          current !== undefined &&
          nextParams !== undefined &&
          options.serializeParams(current) === options.serializeParams(nextParams)
        )
      ) return prev
      return { ...prev, [key]: nextParams }
    })

    if (nextParams === undefined && deletedByTarget()[key]) {
      clearDeleted(key)
      return
    }

    const draft = draftByTarget()[key]
    if (!draft) {
      if (nextParams && (options.isRemote?.() ?? true)) applyRemoteToEngine(targetId, nextParams)
      return
    }

    const nextSerialized = nextParams ? options.serializeParams(nextParams) : undefined
    const draftSerialized = options.serializeParams(draft)
    if (nextSerialized && draftSerialized === nextSerialized) {
      clearReconciledDraft(targetId, key)
      return
    }

    const overwriteAfterMs = options.remoteOverwriteAfterMs ?? 0
    if (overwriteAfterMs <= 0 || saveTimers.has(key)) return
    const lastEdit = lastLocalEdit.get(key) ?? 0
    if (Date.now() - lastEdit >= overwriteAfterMs) {
      clearDraft(targetId, key)
      if (nextParams && (options.isRemote?.() ?? true)) applyRemoteToEngine(targetId, nextParams)
    }
  }

  createEffect(() => {
    const targetId = options.targetId()
    if (!targetId) return

    const row = options.row()
    if (row === undefined) {
      if (options.isMissingRowLoaded?.()) syncRemote(targetId, undefined)
      return
    }

    options.onQueryRow?.(targetId, row)

    syncRemote(targetId, options.readQueryParams(row))
  })

  createEffect(() => {
    const targetId = options.targetId()
    if (!targetId) return
    const next = params()
    if (!next) {
      const key = keyForTarget(targetId)
      if (deletedByTarget()[key]) {
        applyLocalClearToEngine(targetId)
        return
      }
      applyRemoteToEngine(targetId, undefined)
      return
    }
    applyRemoteToEngine(targetId, next)
  })

  const flushPending = async (projectId?: string) => {
    while (true) {
      const pendingApplies = [...pendingApplyByTarget.entries()]
        .filter(([key]) => {
          if (!projectId) return true
          return persistContextByTarget.get(key)?.projectId === projectId
        })
        .map(([, apply]) => apply)
      if (pendingApplies.length === 0) break
      await Promise.all(pendingApplies)
    }
    for (const [key, timer] of Array.from(saveTimers.entries())) {
      const context = persistContextByTarget.get(key)
      if (projectId && context?.projectId !== projectId) continue
      const targetId = targetByKey.get(key)
      if (!targetId) continue
      clearTimeout(timer)
      saveTimers.delete(key)
      const params = draftByTarget()[key]
      if (params) persistNow(targetId, key, params, context ?? {})
    }
    for (const [key, params] of Object.entries(draftByTarget())) {
      if (saveTimers.has(key) || persistAttemptByTarget.has(key)) continue
      const context = persistContextByTarget.get(key)
      if (projectId && context?.projectId !== projectId) continue
      const targetId = targetByKey.get(key)
      if (targetId && params) persistNow(targetId, key, params, context ?? {})
    }
    const pendingWrites = projectId
      ? pendingWritesByProject.get(projectId)
      : new Set(Array.from(pendingWritesByProject.values()).flatMap((writes) => Array.from(writes)))
    await Promise.all(Array.from(pendingWrites ?? []))
  }

  onCleanup(() => {
    void flushPending().finally(() => {
      pendingRemoteApplyByTarget.clear()
      for (const unregister of registeredFlushers.values()) unregister()
      registeredFlushers.clear()
    })
  })

  const addForTarget = (targetId: string) => {
    const initial = options.createInitialParams(targetId)
    if (!initial) return
    applyUpdate(targetId, () => initial)
  }

  const removeForTarget = (targetId: string) => {
    const key = keyForTarget(targetId)
    const previous = readCurrent(targetId)
    if (!previous) return false
    const timer = saveTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(key)
    }
    pendingRemoteApplyByTarget.delete(key)
    setDraftByTarget((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    pendingCommitByTarget.delete(key)
    lastLocalEdit.set(key, Date.now())
    const context = options.createPersistContext?.() ?? {}
    if (context.projectId) ensureProjectFlusher(context.projectId)
    persistContextByTarget.set(key, context)
    targetByKey.set(key, targetId)
    setDeletedByTarget((prev) => ({
      ...prev,
      [key]: true,
    }))
    persistRemoveNow(targetId, key, context)
    return true
  }

  return {
    add: () => {
      const targetId = options.targetId()
      if (!targetId) return
      addForTarget(targetId)
    },
    addForTarget,
    flushPending,
    params,
    readDraftForTarget: (targetId) => draftByTarget()[keyForTarget(targetId)],
    readForTarget: readCurrent,
    removeForTarget,
    reset: () => {
      const targetId = options.targetId()
      if (!targetId) return
      const initial = options.createInitialParams(targetId)
      if (!initial) return
      applyUpdate(targetId, () => initial)
    },
    setForTarget: (targetId, params) => {
      applyParams(targetId, readCurrent(targetId), params)
    },
    syncRemoteForTarget: syncRemote,
    update: (updater) => {
      const targetId = options.targetId()
      if (!targetId) return
      applyUpdate(targetId, updater)
    },
    updateForTarget: (targetId, updater) => {
      applyUpdate(targetId, updater)
    },
  }
}
