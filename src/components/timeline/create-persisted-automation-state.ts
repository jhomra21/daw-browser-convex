import { createMemo, createSignal, type Accessor } from 'solid-js'
import type { AutomationEnvelope } from '@daw-browser/shared'

type PersistedAutomationContext = {
  projectId?: string
  userId?: string
}

type PersistedAutomationStateOptions = {
  targetKey: Accessor<string | undefined>
  envelopes: Accessor<AutomationEnvelope[]>
  applyToEngine: (envelopes: AutomationEnvelope[], previousEnvelopes: AutomationEnvelope[], changedTargetKeys: ReadonlySet<string>) => void
  persistEnvelope: (envelope: AutomationEnvelope, context: PersistedAutomationContext) => void | Promise<unknown>
  deleteEnvelope: (targetKey: string, context: PersistedAutomationContext) => void | Promise<unknown>
  createPersistContext?: () => PersistedAutomationContext
  onEnvelopeCommitted?: (previous: AutomationEnvelope | undefined, next: AutomationEnvelope | undefined, context: PersistedAutomationContext) => void
}

export function createPersistedAutomationState(options: PersistedAutomationStateOptions) {
  const [draftByTargetKey, setDraftByTargetKey] = createSignal<Record<string, AutomationEnvelope | undefined>>({})
  const [dirtyTargetKeys, setDirtyTargetKeys] = createSignal<ReadonlySet<string>>(new Set())
  let lastAppliedEnvelopes = options.envelopes()

  const persistedByTargetKey = createMemo(() => new Map(options.envelopes().map((envelope) => [envelope.targetKey, envelope])))

  const envelopes = createMemo(() => {
    const drafts = draftByTargetKey()
    const next = new Map(persistedByTargetKey())
    for (const [targetKey, draft] of Object.entries(drafts)) {
      if (draft) next.set(targetKey, draft)
      else next.delete(targetKey)
    }
    return Array.from(next.values())
  })

  const selectedEnvelope = createMemo(() => {
    const targetKey = options.targetKey()
    return targetKey ? draftByTargetKey()[targetKey] ?? persistedByTargetKey().get(targetKey) : undefined
  })

  const markDirty = (targetKey: string) => {
    setDirtyTargetKeys((prev) => new Set([...prev, targetKey]))
  }

  const clearDirty = (targetKey: string) => {
    setDirtyTargetKeys((prev) => {
      if (!prev.has(targetKey)) return prev
      const next = new Set(prev)
      next.delete(targetKey)
      return next
    })
  }

  const applyToEngine = (nextEnvelopes: AutomationEnvelope[], changedTargetKeys: ReadonlySet<string>) => {
    const previousEnvelopes = lastAppliedEnvelopes
    options.applyToEngine(nextEnvelopes, previousEnvelopes, changedTargetKeys)
    lastAppliedEnvelopes = nextEnvelopes
  }

  const previewEnvelope = (envelope: AutomationEnvelope | undefined) => {
    const targetKey = envelope?.targetKey ?? options.targetKey()
    if (!targetKey) return
    markDirty(targetKey)
    const nextDrafts = { ...draftByTargetKey(), [targetKey]: envelope }
    setDraftByTargetKey(nextDrafts)
    const next = new Map(persistedByTargetKey())
    for (const [draftTargetKey, draft] of Object.entries(nextDrafts)) {
      if (draft) next.set(draftTargetKey, draft)
      else next.delete(draftTargetKey)
    }
    applyToEngine(Array.from(next.values()), new Set([targetKey]))
  }

  const commitEnvelope = async (envelope: AutomationEnvelope | undefined, explicitTargetKey?: string) => {
    const targetKey = envelope?.targetKey ?? explicitTargetKey ?? options.targetKey()
    if (!targetKey) return
    const previous = persistedByTargetKey().get(targetKey)
    const context = options.createPersistContext?.() ?? {}
    if (envelope) await options.persistEnvelope(envelope, context)
    else await options.deleteEnvelope(targetKey, context)
    const next = new Map(persistedByTargetKey())
    if (envelope) next.set(targetKey, envelope)
    else next.delete(targetKey)
    clearDirty(targetKey)
    setDraftByTargetKey((prev) => {
      const next = { ...prev }
      delete next[targetKey]
      return next
    })
    applyToEngine(Array.from(next.values()), new Set([targetKey]))
    options.onEnvelopeCommitted?.(previous, envelope, context)
  }

  const cancelPreview = (targetKey = options.targetKey()) => {
    if (!targetKey) return
    clearDirty(targetKey)
    setDraftByTargetKey((prev) => {
      if (!(targetKey in prev)) return prev
      const next = { ...prev }
      delete next[targetKey]
      return next
    })
    applyToEngine(options.envelopes(), new Set([targetKey]))
  }

  const syncRemote = () => {
    const dirty = dirtyTargetKeys()
    const nextEnvelopes = options.envelopes()
    if (dirty.size === 0) {
      applyToEngine(nextEnvelopes, new Set())
      return
    }
    applyToEngine(envelopes(), dirty)
  }

  return {
    commitEnvelope,
    cancelPreview,
    envelopes,
    previewEnvelope,
    selectedEnvelope,
    syncRemote,
  }
}
