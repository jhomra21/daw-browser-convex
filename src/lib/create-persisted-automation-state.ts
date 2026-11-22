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
  persistEnvelope: (envelope: AutomationEnvelope, context: PersistedAutomationContext) => void | Promise<void>
  deleteEnvelope: (targetKey: string, context: PersistedAutomationContext) => void | Promise<void>
  createPersistContext?: () => PersistedAutomationContext
  onEnvelopeCommitted?: (previous: AutomationEnvelope | undefined, next: AutomationEnvelope | undefined, context: PersistedAutomationContext) => void
}

export function createPersistedAutomationState(options: PersistedAutomationStateOptions) {
  // Drafts and dirty keys are the working state of the preview/commit methods below, which read them back in the same
  // call; the draft signal only publishes the drafts to the envelopes memo.
  let drafts: Record<string, AutomationEnvelope | undefined> = {}
  let dirty: ReadonlySet<string> = new Set()
  const [draftByTargetKey, publishDrafts] = createSignal(drafts)
  const setDrafts = (next: Record<string, AutomationEnvelope | undefined>) => {
    drafts = next
    publishDrafts(next)
  }
  let lastAppliedEnvelopes = options.envelopes()

  const persistedByTargetKey = createMemo(() => new Map(options.envelopes().map((envelope) => [envelope.targetKey, envelope])))

  const mergeDrafts = (persisted: AutomationEnvelope[], drafts: Record<string, AutomationEnvelope | undefined>) => {
    const next = new Map(persisted.map((envelope) => [envelope.targetKey, envelope]))

    for (const [targetKey, draft] of Object.entries(drafts)) {
      if (draft) next.set(targetKey, draft)
      else next.delete(targetKey)
    }

    return Array.from(next.values())
  }

  const envelopes = createMemo(() => mergeDrafts(options.envelopes(), draftByTargetKey()))

  const markDirty = (targetKey: string) => {
    dirty = new Set([...dirty, targetKey])
  }

  const clearDirty = (targetKey: string) => {
    if (!dirty.has(targetKey)) return
    const next = new Set(dirty)
    next.delete(targetKey)
    dirty = next
  }

  const applyToEngine = (nextEnvelopes: AutomationEnvelope[], changedTargetKeys: ReadonlySet<string>) => {
    const previousEnvelopes = lastAppliedEnvelopes
    options.applyToEngine(nextEnvelopes, previousEnvelopes, changedTargetKeys)
    lastAppliedEnvelopes = nextEnvelopes
  }

  const hasEnvelopeSchedulingChanged = (previous: AutomationEnvelope | undefined, next: AutomationEnvelope) => {
    if (!previous) return true

    if (previous.updatedAt !== next.updatedAt || previous.enabled !== next.enabled || previous.parameterId !== next.parameterId) return true

    if (previous.points.length !== next.points.length) return true

    return next.points.some((point, index) => {
      const previousPoint = previous.points[index]

      return !previousPoint
        || previousPoint.id !== point.id
        || previousPoint.timeSec !== point.timeSec
        || previousPoint.value !== point.value
        || previousPoint.interpolation !== point.interpolation
    })
  }

  const changedTargetKeysFromLastApplied = (nextEnvelopes: AutomationEnvelope[]) => {
    const previousByTargetKey = new Map(lastAppliedEnvelopes.map((envelope) => [envelope.targetKey, envelope]))
    const nextByTargetKey = new Map(nextEnvelopes.map((envelope) => [envelope.targetKey, envelope]))
    const changed = new Set<string>()

    for (const [targetKey, next] of nextByTargetKey) {
      const previous = previousByTargetKey.get(targetKey)

      if (hasEnvelopeSchedulingChanged(previous, next)) {
        changed.add(targetKey)
      }
    }

    for (const targetKey of previousByTargetKey.keys()) {
      if (!nextByTargetKey.has(targetKey)) changed.add(targetKey)
    }

    return changed
  }

  const previewEnvelope = (envelope: AutomationEnvelope | undefined) => {
    const targetKey = envelope?.targetKey ?? options.targetKey()

    if (!targetKey) return
    markDirty(targetKey)
    const nextDrafts = { ...drafts, [targetKey]: envelope }
    setDrafts(nextDrafts)
    applyToEngine(mergeDrafts(options.envelopes(), nextDrafts), new Set([targetKey]))
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
    const { [targetKey]: _committed, ...remainingDrafts } = drafts
    setDrafts(remainingDrafts)
    applyToEngine(Array.from(next.values()), new Set([targetKey]))
    options.onEnvelopeCommitted?.(previous, envelope, context)
  }

  const cancelPreview = (targetKey = options.targetKey()) => {
    if (!targetKey) return
    clearDirty(targetKey)
    if (targetKey in drafts) {
      const { [targetKey]: _cancelled, ...remainingDrafts } = drafts
      setDrafts(remainingDrafts)
    }

    applyToEngine(options.envelopes(), new Set([targetKey]))
  }

  // A caller that just wrote the persisted envelopes passes them, since the accessor still shows the committed ones.
  const syncRemote = (nextEnvelopes = options.envelopes()) => {
    if (dirty.size === 0) {
      const changed = changedTargetKeysFromLastApplied(nextEnvelopes)

      if (changed.size > 0) applyToEngine(nextEnvelopes, changed)

      return
    }

    const merged = mergeDrafts(nextEnvelopes, drafts)
    const changed = changedTargetKeysFromLastApplied(merged)
    applyToEngine(merged, new Set([...dirty, ...changed]))
  }

  return {
    commitEnvelope,
    cancelPreview,
    envelopes,
    snapshotPatches: () => Object.entries(drafts).map(([targetKey, envelope]) => ({ targetKey, envelope })),
    previewEnvelope,
    syncRemote,
  }
}
