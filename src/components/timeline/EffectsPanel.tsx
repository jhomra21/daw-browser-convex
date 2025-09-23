import { type Component, Show, createSignal, createMemo, createEffect } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Button } from '~/components/ui/button'
import Eq, { createDefaultEqParams, type EqParams } from '~/components/effects/Eq'
import type { AudioEngine, EqParamsLite } from '~/lib/audio-engine'
import { convexClient, convexApi } from '~/lib/convex'

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
          } else {
            setEqByTarget(prev => ({ ...prev, [id]: undefined }))
          }
        } else {
          const row = await convexClient.query(convexApi.effects.getEqForTrack, { trackId: id as any })
          if (row?.params) {
            setEqByTarget(prev => ({ ...prev, [id]: row.params as EqParams }))
            lastSaved.set(id, JSON.stringify(row.params))
            props.audioEngine?.setTrackEq(id, row.params as EqParamsLite)
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

  async function handleAddEq() {
    const id = currentTargetId()
    if (!id) return
    const params = createDefaultEqParams()
    setEqByTarget(prev => ({ ...prev, [id]: params }))
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
      props.audioEngine?.setTrackEq(id, params as unknown as EqParamsLite)
      if (props.roomId && props.userId) {
        void convexClient.mutation((convexApi as any).effects.setEqParams, {
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
          <div class="h-10 px-4 flex items-center justify-between">
            <div class="font-semibold">Effects — {targetName()}</div>
            <div class="flex items-center gap-2">
              <Show when={!eqForTarget()}>
                <Button variant="default" size="sm" onClick={handleAddEq}>Add EQ</Button>
              </Show>
              <Button variant="outline" size="sm" onClick={props.onClose}>Collapse</Button>
            </div>
          </div>
          <div class="px-4 pb-4">
            <Show when={eqForTarget()} fallback={
              <div class="text-sm text-neutral-400">
                No EQ on this {currentTargetId() === 'master' ? 'master bus' : 'track'}. Click "Add EQ" to insert one.
              </div>
            }>
              <Eq
                bands={eqForTarget()!.bands}
                enabled={eqForTarget()!.enabled}
                onBandChange={handleBandChange}
                onBandToggle={handleBandToggle}
                onToggleEnabled={handleToggleEnabled}
                onReset={handleReset}
              />
            </Show>
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