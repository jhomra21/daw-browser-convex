import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'

type PersistedEffectStateOptions<TRow, TParams> = {
  targetId: Accessor<string | undefined>
  row: Accessor<TRow>
  readQueryParams: (row: TRow) => TParams | undefined
  readVisibleParams?: (targetId: string) => TParams | undefined
  createInitialParams: (targetId: string) => TParams | undefined
  serializeParams: (params: TParams) => string
  applyToEngine: (targetId: string, params: TParams) => void
  clearFromEngine?: (targetId: string) => void
  persistParams: (targetId: string, params: TParams) => void | Promise<unknown>
  onParamsCommitted?: (targetId: string, previous: TParams | undefined, next: TParams) => void
  onQueryRow?: (targetId: string, row: TRow) => void
  debounceMs?: number
  remoteOverwriteAfterMs?: number
}

type PersistedEffectState<TParams> = {
  add: () => void
  flushPending: () => void
  params: Accessor<TParams | undefined>
  readDraftForTarget: (targetId: string) => TParams | undefined
  readForTarget: (targetId: string) => TParams | undefined
  reset: () => void
  syncRemoteForTarget: (targetId: string, params: TParams | undefined) => void
  update: (updater: (prev: TParams) => TParams) => void
  updateForTarget: (targetId: string, updater: (prev: TParams) => TParams) => void
}

export function createPersistedEffectState<TRow, TParams>(
  options: PersistedEffectStateOptions<TRow, TParams>,
): PersistedEffectState<TParams> {
  const [remoteByTarget, setRemoteByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const [draftByTarget, setDraftByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastLocalEdit = new Map<string, number>()
  const persistAttemptByTarget = new Map<string, number>()

  function clearDraft(targetId: string) {
    const timer = saveTimers.get(targetId)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(targetId)
    }
    persistAttemptByTarget.delete(targetId)
    lastLocalEdit.delete(targetId)
    setDraftByTarget((prev) => {
      if (!(targetId in prev)) return prev
      const next = { ...prev }
      delete next[targetId]
      return next
    })
  }

  function readCurrent(targetId: string) {
    return draftByTarget()[targetId]
      ?? remoteByTarget()[targetId]
      ?? options.readVisibleParams?.(targetId)
  }

  function flushTarget(targetId: string) {
    const timer = saveTimers.get(targetId)
    if (!timer) return
    clearTimeout(timer)
    saveTimers.delete(targetId)
    const params = draftByTarget()[targetId]
    if (!params) return
    persistNow(targetId, params)
  }

  function persistNow(targetId: string, params: TParams) {
    const attempt = (persistAttemptByTarget.get(targetId) ?? 0) + 1
    persistAttemptByTarget.set(targetId, attempt)
    const serialized = options.serializeParams(params)
    void Promise.resolve()
      .then(() => options.persistParams(targetId, params))
      .catch(() => {
      if (persistAttemptByTarget.get(targetId) !== attempt) return
      const current = draftByTarget()[targetId]
      if (!current) return
      if (options.serializeParams(current) !== serialized) return
      clearDraft(targetId)
      })
  }

  function persistOrSchedule(targetId: string, params: TParams) {
    const debounceMs = options.debounceMs ?? 0
    if (debounceMs <= 0) {
      persistNow(targetId, params)
      return
    }

    const previousTimer = saveTimers.get(targetId)
    if (previousTimer) clearTimeout(previousTimer)
    // Batch quick effect tweaks into one persistence write and cancel any
    // leftover timers during cleanup.
    saveTimers.set(targetId, setTimeout(() => flushTarget(targetId), debounceMs))
  }

  function applyUpdate(targetId: string, updater: (prev: TParams) => TParams) {
    const previous = readCurrent(targetId)
    const initial = previous ?? options.createInitialParams(targetId)
    if (!initial) return

    const next = updater(initial)
    lastLocalEdit.set(targetId, Date.now())
    setDraftByTarget((prev) => ({
      ...prev,
      [targetId]: next,
    }))
    persistOrSchedule(targetId, next)
    options.onParamsCommitted?.(targetId, previous, next)
  }

  const params = createMemo(() => {
    const targetId = options.targetId()
    if (!targetId) return undefined
    return readCurrent(targetId)
  })

  function syncRemote(targetId: string, nextParams: TParams | undefined) {
    setRemoteByTarget((prev) => {
      if (prev[targetId] === nextParams) return prev
      return { ...prev, [targetId]: nextParams }
    })

    const draft = draftByTarget()[targetId]
    if (!draft) return

    const nextSerialized = nextParams ? options.serializeParams(nextParams) : undefined
    const draftSerialized = options.serializeParams(draft)
    if (nextSerialized && draftSerialized === nextSerialized) {
      clearDraft(targetId)
      return
    }

    const overwriteAfterMs = options.remoteOverwriteAfterMs ?? 0
    if (overwriteAfterMs <= 0 || saveTimers.has(targetId)) return
    const lastEdit = lastLocalEdit.get(targetId) ?? 0
    if (Date.now() - lastEdit >= overwriteAfterMs) {
      clearDraft(targetId)
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

  onCleanup(() => {
    for (const timer of saveTimers.values()) {
      clearTimeout(timer)
    }
    saveTimers.clear()
  })

  return {
    add: () => {
      const targetId = options.targetId()
      if (!targetId) return
      const initial = options.createInitialParams(targetId)
      if (!initial) return
      applyUpdate(targetId, () => initial)
    },
    flushPending: () => {
      for (const targetId of Array.from(saveTimers.keys())) {
        flushTarget(targetId)
      }
      saveTimers.clear()
    },
    params,
    readDraftForTarget: (targetId) => draftByTarget()[targetId],
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
