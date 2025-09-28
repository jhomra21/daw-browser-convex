import { type Component, Show, For, createSignal, createMemo, createEffect } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Button } from '~/components/ui/button'
import Eq, { createDefaultEqParams, type EqParams } from '~/components/effects/Eq'
import type { AudioEngine, EqParamsLite, ReverbParamsLite } from '~/lib/audio-engine'
import { convexClient, convexApi } from '~/lib/convex'
import Reverb, { createDefaultReverbParams, type ReverbParams } from '~/components/effects/Reverb'

type EffectsPanelProps = {
  isOpen: boolean
  selectedFXTarget: string
  tracks: Track[]
  onClose: () => void
  onOpen: () => void
  audioEngine?: AudioEngine
  roomId?: string
  userId?: string
}

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const targetName = () => {
    const id = props.selectedFXTarget
    if (id === 'master') return 'Master'
    const track = props.tracks.find(t => t.id === id)
    return track?.name ?? 'Track'
  }

  // Local EQ params per FX target (trackId or 'master'); undefined = no EQ yet
  const [eqByTarget, setEqByTarget] = createSignal<Record<string, EqParams | undefined>>({})
  const currentTargetId = () => props.selectedFXTarget || 'master'

  const eqForTarget = createMemo(() => {
    const id = currentTargetId()
    const map = eqByTarget()
    return map[id]
  })

  function updateEqForTarget(updater: (prev: EqParams) => EqParams) {
    const id = currentTargetId()
    setEqByTarget(prev => ({ ...prev, [id]: updater(prev[id] ?? createDefaultEqParams()) }))
  }

  const handleBandChange = (bandId: string, updates: Partial<EqParams['bands'][number]>) => {
    updateEqForTarget(prev => ({
      ...prev!,
      bands: prev!.bands.map(b => b.id === bandId ? { ...b, ...updates } : b)
    }))
  }
  const handleBandToggle = (bandId: string) => {
    updateEqForTarget(prev => ({
      ...prev!,
      bands: prev!.bands.map(b => b.id === bandId ? { ...b, enabled: !b.enabled } : b)
    }))
  }
  const handleToggleEnabled = (enabled: boolean) => {
    updateEqForTarget(prev => ({ ...prev!, enabled }))
  }
  const handleReset = () => {
    updateEqForTarget(() => createDefaultEqParams())
  }

  // Load EQ from Convex for selected target, if any
  const lastSaved = new Map<string, string>()
  createEffect(() => {
    const id = currentTargetId()
    if (!id) return
    ;(async () => {
      try {
        if (id === 'master') {
          if (!props.roomId) return
          const row = await convexClient.query(convexApi.effects.getEqForMaster, { roomId: props.roomId })
          if (row?.params) {
            setEqByTarget(prev => ({ ...prev, [id]: row.params as EqParams }))
            lastSaved.set(id, JSON.stringify(row.params))
            props.audioEngine?.setMasterEq(row.params as EqParamsLite)
            // record order index
            setEffectOrderForTarget(id, 'eq', (row as any).index)
          } else {
            setEqByTarget(prev => ({ ...prev, [id]: undefined }))
          }
        } else {
          const row = await convexClient.query(convexApi.effects.getEqForTrack, { trackId: id as any })
          if (row?.params) {
            setEqByTarget(prev => ({ ...prev, [id]: row.params as EqParams }))
            lastSaved.set(id, JSON.stringify(row.params))
            props.audioEngine?.setTrackEq(id, row.params as EqParamsLite)
            setEffectOrderForTarget(id, 'eq', (row as any).index)
          } else {
            setEqByTarget(prev => ({ ...prev, [id]: undefined }))
          }
        }
      } catch {
        setEqByTarget(prev => ({ ...prev, [id]: undefined }))
      }
    })()
  })

  // Apply to audio engine and persist when params change
  createEffect(() => {
    const id = currentTargetId()
    if (!id) return
    const params = eqForTarget()
    if (!params) return
    const json = JSON.stringify(params)
    if (lastSaved.get(id) === json) return
    lastSaved.set(id, json)
    // Realtime apply
    if (id === 'master') {
      props.audioEngine?.setMasterEq(params as unknown as EqParamsLite)
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setMasterEqParams, {
          roomId: props.roomId,
          userId: props.userId,
          params,
        })
      }
    } else {
      props.audioEngine?.setTrackEq(id, params as unknown as EqParamsLite)
      // Persist, if we have identity context
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setEqParams, {
          roomId: props.roomId,
          trackId: id as any,
          userId: props.userId,
          params,
        })
      }
    }
  })

  // ===== Reverb wiring (parallel to EQ) =====
  const [reverbByTarget, setReverbByTarget] = createSignal<Record<string, ReverbParams | undefined>>({})
  const reverbForTarget = createMemo(() => reverbByTarget()[currentTargetId()])
  const updateReverbForTarget = (updater: (prev: ReverbParams) => ReverbParams) => {
    const id = currentTargetId()
    setReverbByTarget(prev => ({ ...prev, [id]: updater(prev[id] ?? createDefaultReverbParams()) }))
  }
  const handleReverbChange = (updates: Partial<ReverbParams>) => {
    updateReverbForTarget(prev => ({ ...prev!, ...updates }))
  }
  const handleReverbToggle = (enabled: boolean) => {
    updateReverbForTarget(prev => ({ ...prev!, enabled }))
  }
  const handleReverbReset = () => {
    updateReverbForTarget(() => createDefaultReverbParams())
  }

  // Load reverb from Convex for selected target
  const lastSavedReverb = new Map<string, string>()
  createEffect(() => {
    const id = currentTargetId(); if (!id) return
    ;(async () => {
      try {
        if (id === 'master') {
          if (!props.roomId) return
          const row = await convexClient.query(convexApi.effects.getReverbForMaster, { roomId: props.roomId })
          if (row?.params) {
            setReverbByTarget(prev => ({ ...prev, [id]: row.params as ReverbParams }))
            lastSavedReverb.set(id, JSON.stringify(row.params))
            props.audioEngine?.setMasterReverb(row.params as unknown as ReverbParamsLite)
            setEffectOrderForTarget(id, 'reverb', (row as any).index)
          } else {
            setReverbByTarget(prev => ({ ...prev, [id]: undefined }))
          }
        } else {
          const row = await convexClient.query(convexApi.effects.getReverbForTrack, { trackId: id as any })
          if (row?.params) {
            setReverbByTarget(prev => ({ ...prev, [id]: row.params as ReverbParams }))
            lastSavedReverb.set(id, JSON.stringify(row.params))
            props.audioEngine?.setTrackReverb(id, row.params as unknown as ReverbParamsLite)
            setEffectOrderForTarget(id, 'reverb', (row as any).index)
          } else {
            setReverbByTarget(prev => ({ ...prev, [id]: undefined }))
          }
        }
      } catch {
        setReverbByTarget(prev => ({ ...prev, [id]: undefined }))
      }
    })()
  })

  // Apply/persist reverb when params change
  createEffect(() => {
    const id = currentTargetId(); if (!id) return
    const params = reverbForTarget(); if (!params) return
    const json = JSON.stringify(params)
    if (lastSavedReverb.get(id) === json) return
    lastSavedReverb.set(id, json)
    if (id === 'master') {
      props.audioEngine?.setMasterReverb(params as unknown as ReverbParamsLite)
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setMasterReverbParams, {
          roomId: props.roomId,
          userId: props.userId,
          params,
        })
      }
    } else {
      props.audioEngine?.setTrackReverb(id, params as unknown as ReverbParamsLite)
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setReverbParams, {
          roomId: props.roomId,
          trackId: id as any,
          userId: props.userId,
          params,
        })
      }
    }
  })

  // ===== Effect ordering (per target) =====
  type EffectKind = 'eq' | 'reverb'
  const [effectOrderByTarget, setEffectOrderByTarget] = createSignal<Record<string, EffectKind[]>>({})
  const [effectIndexByTarget, setEffectIndexByTarget] = createSignal<Record<string, Partial<Record<EffectKind, number>>>>({})

  function setEffectOrderForTarget(targetId: string, kind: EffectKind, index?: number) {
    if (typeof index === 'number') {
      setEffectIndexByTarget(prev => {
        const next = { ...prev }
        next[targetId] = { ...(next[targetId] ?? {}), [kind]: index }
        return next
      })
      const idx = { ...(effectIndexByTarget()[targetId] ?? {}), [kind]: index }
      const entries: { kind: EffectKind; idx: number }[] = []
      if (typeof idx.eq === 'number') entries.push({ kind: 'eq', idx: idx.eq as number })
      if (typeof idx.reverb === 'number') entries.push({ kind: 'reverb', idx: idx.reverb as number })
      if (entries.length > 0) {
        entries.sort((a, b) => a.idx - b.idx)
        setEffectOrderByTarget(prev => ({ ...prev, [targetId]: entries.map(e => e.kind) }))
        return
      }
    }
    appendEffectOrder(targetId, kind)
  }

  function appendEffectOrder(targetId: string, kind: EffectKind) {
    setEffectOrderByTarget(prev => {
      const arr = prev[targetId] ?? []
      if (arr.includes(kind)) return prev
      return { ...prev, [targetId]: [...arr, kind] }
    })
  }

  const orderedEffects = createMemo<EffectKind[]>(() => {
    const id = currentTargetId()
    const map = effectOrderByTarget()
    const arr = map[id]
    if (arr && arr.length > 0) return arr
    // Fallback by presence
    const present: EffectKind[] = []
    if (eqForTarget()) present.push('eq')
    if (reverbForTarget()) present.push('reverb')
    if (present.length === 2) return ['eq', 'reverb']
    return present
  })

  async function handleAddEq() {
    const id = currentTargetId()
    if (!id) return
    const params = createDefaultEqParams()
    setEqByTarget(prev => ({ ...prev, [id]: params }))
    appendEffectOrder(id, 'eq')
    // Apply immediately
    if (id === 'master') {
      props.audioEngine?.setMasterEq(params as unknown as EqParamsLite)
      if (props.roomId && props.userId) {
        void convexClient.mutation((convexApi as any).effects.setMasterEqParams, {
          roomId: props.roomId,
          userId: props.userId,
          params,
        })
      }
    } else {
      props.audioEngine?.setTrackEq(id, params as EqParamsLite)
      if (props.roomId && props.userId) {
        void convexClient.mutation(convexApi.effects.setEqParams, {
          roomId: props.roomId,
          trackId: id as any,
          userId: props.userId,
          params,
        })
      }
    }
    lastSaved.set(id, JSON.stringify(params))
  }

  return (
    <>
      <Show when={props.isOpen}>
        <div class="fixed left-0 right-0 bottom-0 border-t border-neutral-800 bg-neutral-900">
          <div class="flex max-h-[340px]">
            <div class="flex w-20 flex-col items-center gap-4 border-r border-neutral-800 px-3 pt-2">
              <Button variant="outline" size="sm" class="w-full" onClick={props.onClose}>Collapse</Button>
              <div class="flex flex-1 items-start justify-center pt-6">
                <span
                  class="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-neutral-300"
                  style={{ transform: 'rotate(-90deg)' }}
                >
                  <span class="whitespace-nowrap">{targetName()}</span>
                </span>
              </div>
            </div>
            <div class="flex flex-1 flex-col overflow-hidden !-mt-2 p-1">
              <div class="flex flex-wrap items-center justify-end gap-2">
                <Show when={!eqForTarget()}>
                  <Button variant="default" size="sm" onClick={handleAddEq}>Add EQ</Button>
                </Show>
                <Show when={!reverbForTarget()}>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      const id = currentTargetId(); if (!id) return
                      const params = createDefaultReverbParams()
                      setReverbByTarget(prev => ({ ...prev, [id]: params }))
                      appendEffectOrder(id, 'reverb')
                      if (id === 'master') {
                        props.audioEngine?.setMasterReverb(params as unknown as ReverbParamsLite)
                        if (props.roomId && props.userId) {
                          void convexClient.mutation(convexApi.effects.setMasterReverbParams, { roomId: props.roomId, userId: props.userId, params })
                        }
                      } else {
                        props.audioEngine?.setTrackReverb(id, params as unknown as ReverbParamsLite)
                        if (props.roomId && props.userId) {
                          void convexClient.mutation(convexApi.effects.setReverbParams, { roomId: props.roomId, trackId: id as any, userId: props.userId, params })
                        }
                      }
                      lastSavedReverb.set(id, JSON.stringify(params))
                    }}
                  >Add Reverb</Button>
                </Show>
              </div>
              <div class="mt-3 flex-1 overflow-y-auto pr-1">
                <div class="flex items-start gap-3 flex-wrap">
                  <For each={orderedEffects()}>{(eff) => (
                    <Show when={eff === 'eq'} fallback={
                      <Show when={!!reverbForTarget()}>
                        <Reverb
                          params={reverbForTarget()!}
                          onChange={handleReverbChange}
                          onToggleEnabled={handleReverbToggle}
                          onReset={handleReverbReset}
                        />
                      </Show>
                    }>
                      <Show when={!!eqForTarget()}>
                        <Eq
                          bands={eqForTarget()!.bands}
                          enabled={eqForTarget()!.enabled}
                          onBandChange={handleBandChange}
                          onBandToggle={handleBandToggle}
                          onToggleEnabled={handleToggleEnabled}
                          onReset={handleReset}
                        />
                      </Show>
                    </Show>
                  )}</For>
                </div>
                <Show when={!eqForTarget() && !reverbForTarget()}>
                  <div class="mt-4 text-sm text-neutral-400">
                    No effects on this {currentTargetId() === 'master' ? 'master bus' : 'track'}. Use Add EQ or Add Reverb.
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={!props.isOpen}>
        <button
          class="fixed bottom-4 right-4 bg-neutral-800 text-white rounded-md px-3 py-2 border border-neutral-700 hover:bg-neutral-700"
          onClick={props.onOpen}
        >
          Open Effects
        </button>
      </Show>
    </>
  )
}

export default EffectsPanel