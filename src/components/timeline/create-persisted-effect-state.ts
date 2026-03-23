import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'

type PersistedEffectStateOptions<TParams> = {
  targetId: Accessor<string | undefined>
  row: Accessor<unknown>
  readQueryParams: (row: any) => TParams | undefined
  readVisibleParams?: (targetId: string) => TParams | undefined
  createInitialParams: (targetId: string) => TParams | undefined
  serializeParams: (params: TParams) => string
  applyToEngine: (targetId: string, params: TParams) => void
  clearFromEngine?: (targetId: string) => void
  persistParams: (targetId: string, params: TParams) => void | Promise<unknown>
  onParamsCommitted?: (targetId: string, previous: TParams | undefined, next: TParams) => void
  onQueryRow?: (targetId: string, row: any) => void
  debounceMs?: number
  remoteOverwriteAfterMs?: number
}

type PersistedEffectState<TParams> = {
  add: () => void
  flushPending: () => void
  params: Accessor<TParams | undefined>
  readForTarget: (targetId: string) => TParams | undefined
  reset: () => void
  update: (updater: (prev: TParams) => TParams) => void
  updateForTarget: (targetId: string, updater: (prev: TParams) => TParams) => void
}

export function createPersistedEffectState<TParams>(
  options: PersistedEffectStateOptions<TParams>,
): PersistedEffectState<TParams> {
  const [remoteByTarget, setRemoteByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const [draftByTarget, setDraftByTarget] = createSignal<Record<string, TParams | undefined>>({})
  const saveTimers = new Map<string, number>()
  const lastLocalEdit = new Map<string, number>()

  function clearDraft(targetId: string) {
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
    void Promise.resolve(options.persistParams(targetId, params))
  }

  function persistOrSchedule(targetId: string, params: TParams) {
    const debounceMs = options.debounceMs ?? 0
    if (debounceMs <= 0) {
      void Promise.resolve(options.persistParams(targetId, params))
      return
    }

    const previousTimer = saveTimers.get(targetId)
    if (previousTimer) clearTimeout(previousTimer)
    saveTimers.set(targetId, window.setTimeout(() => flushTarget(targetId), debounceMs))
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

  createEffect(() => {
    const targetId = options.targetId()
    if (!targetId) return

    const row = options.row()
    if (row === undefined) return

    options.onQueryRow?.(targetId, row)

    const nextParams = options.readQueryParams(row)
    setRemoteByTarget((prev) => ({ ...prev, [targetId]: nextParams }))

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
    readForTarget: readCurrent,
    reset: () => {
      const targetId = options.targetId()
      if (!targetId) return
      const initial = options.createInitialParams(targetId)
      if (!initial) return
      applyUpdate(targetId, () => initial)
    },
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
