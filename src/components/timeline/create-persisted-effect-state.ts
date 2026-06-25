import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'
import { registerPendingLocalProjectWriteFlusher } from '~/lib/local-project-pending-writes'

type PersistedEffectContext = {
  projectId?: string
  userId?: string
}

type PersistedEffectStateOptions<TRow, TParams> = {
  targetId: Accessor<string | undefined>
  scopeId?: Accessor<string | undefined>
  row: Accessor<TRow>
  readQueryParams: (row: TRow) => TParams | undefined
  readVisibleParams?: (targetId: string) => TParams | undefined
  createInitialParams: (targetId: string) => TParams | undefined
  serializeParams: (params: TParams) => string
  applyToEngine: (targetId: string, params: TParams) => void
  clearFromEngine?: (targetId: string) => void
  persistParams: (targetId: string, params: TParams, context: PersistedEffectContext) => void | Promise<unknown>
  createPersistContext?: () => PersistedEffectContext
  onPersistError?: (error: unknown) => void
  onParamsCommitted?: (
    targetId: string,
    previous: TParams | undefined,
    next: TParams,
    context: PersistedEffectContext,
  ) => void
  onQueryRow?: (targetId: string, row: TRow) => void
  debounceMs?: number
  remoteOverwriteAfterMs?: number
}

type PersistedEffectState<TParams> = {
  add: () => void
  flushPending: () => Promise<void>
  params: Accessor<TParams | undefined>
  readDraftForTarget: (targetId: string) => TParams | undefined
  readForTarget: (targetId: string) => TParams | undefined
  reset: () => void
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

export function createPersistedEffectState<TRow, TParams>(
  options: PersistedEffectStateOptions<TRow, TParams>,
): PersistedEffectState<TParams> {
  const [remoteByTarget, setRemoteByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const [draftByTarget, setDraftByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastLocalEdit = new Map<string, number>()
  const persistAttemptByTarget = new Map<string, number>()
  const persistContextByTarget = new Map<string, PersistedEffectContext>()
  const targetByKey = new Map<string, string>()
  const pendingCommitByTarget = new Map<string, PendingParamsCommit<TParams>>()
  const pendingWritesByProject = new Map<string, Set<Promise<void>>>()
  const registeredFlushers = new Map<string, () => void>()

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
    lastLocalEdit.delete(key)
    setDraftByTarget((prev) => {
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
          const current = draftByTarget()[key]
          if (!current || options.serializeParams(current) === serialized) {
            persistAttemptByTarget.delete(key)
            persistContextByTarget.delete(key)
          }
        },
        (error) => {
          if (persistAttemptByTarget.get(key) !== attempt) return
          const current = draftByTarget()[key]
          if (!current) return
          if (options.serializeParams(current) !== serialized) return
          options.onPersistError?.(error)
          persistAttemptByTarget.delete(key)
          throw error
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

  function applyUpdate(targetId: string, updater: (prev: TParams) => TParams) {
    const key = keyForTarget(targetId)
    const previous = readCurrent(targetId)
    const initial = previous ?? options.createInitialParams(targetId)
    if (!initial) return

    const next = updater(initial)
    const serializedNext = options.serializeParams(next)
    if (previous !== undefined && options.serializeParams(previous) === serializedNext) return
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
    pendingCommitByTarget.set(key, {
      targetId,
      previous: pendingCommit?.previous ?? previous,
      next,
      serialized: serializedNext,
    })
    persistOrSchedule(targetId, key, next)
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

    const draft = draftByTarget()[key]
    if (!draft) return

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
    }
  }

  createEffect(() => {
    const targetId = options.targetId()
    if (!targetId) return

    const row = options.row()
    if (row === undefined) return

    options.onQueryRow?.(targetId, row)

    syncRemote(targetId, options.readQueryParams(row))
  })

  createEffect(() => {
    const targetId = options.targetId()
    if (!targetId) return
    const next = params()
    if (!next) {
      options.clearFromEngine?.(targetId)
      return
    }
    options.applyToEngine(targetId, next)
  })

  const flushPending = async (projectId?: string) => {
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
      for (const unregister of registeredFlushers.values()) unregister()
      registeredFlushers.clear()
    })
  })

  return {
    add: () => {
      const targetId = options.targetId()
      if (!targetId) return
      const initial = options.createInitialParams(targetId)
      if (!initial) return
      applyUpdate(targetId, () => initial)
    },
    flushPending,
    params,
    readDraftForTarget: (targetId) => draftByTarget()[keyForTarget(targetId)],
    readForTarget: readCurrent,
    reset: () => {
      const targetId = options.targetId()
      if (!targetId) return
      const initial = options.createInitialParams(targetId)
      if (!initial) return
      applyUpdate(targetId, () => initial)
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
