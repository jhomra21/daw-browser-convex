import { type Component, Show, For, createSignal, createMemo, createEffect } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Button } from '~/components/ui/button'
import Eq, { createDefaultEqParams, type EqParams } from '~/components/effects/Eq'
import type { AudioEngine, EqParamsLite, ReverbParamsLite } from '~/lib/audio-engine'
import { convexClient, convexApi } from '~/lib/convex'
import Reverb, { createDefaultReverbParams, type ReverbParams } from '~/components/effects/Reverb'
import Synth, { createDefaultSynthParams, type SynthParams } from '~/components/effects/Synth'
import Arpeggiator, { createDefaultArpeggiatorParams, type ArpeggiatorParams } from '~/components/effects/Arpeggiator'

type EffectsPanelProps = {
  isOpen: boolean
  selectedFXTarget: string
  tracks: Track[]
  onClose: () => void
  onOpen: () => void
  audioEngine?: AudioEngine
  roomId?: string
  userId?: string
  // Timeline context
  playheadSec?: number
  onSelectClip?: (trackId: string, clipId: string, startSec: number) => void
}

const EffectsPanel: Component<EffectsPanelProps> = (props) => {
  const targetName = () => {
    const id = props.selectedFXTarget
    if (id === 'master') return 'Master'
    const track = props.tracks.find(t => t.id === id)
    return track?.name ?? 'Track'
  }

  // Target helpers must be defined before any usage below
  const currentTargetId = () => props.selectedFXTarget || 'master'
  const currentTrack = createMemo(() => {
    const id = currentTargetId()
    if (!id || id === 'master') return undefined
    return props.tracks.find(t => t.id === id)
  })

  // ===== Arpeggiator (MIDI effect for instrument tracks) =====
  const [arpByTarget, setArpByTarget] = createSignal<Record<string, ArpeggiatorParams | undefined>>({})
  const arpForTarget = createMemo(() => arpByTarget()[currentTargetId()])

  // ===== Synth (instrument tracks) =====
  const [synthByTarget, setSynthByTarget] = createSignal<Record<string, SynthParams | undefined>>({})
  const synthForTarget = createMemo(() => synthByTarget()[currentTargetId()])

  // Load arpeggiator from Convex for selected track
  const lastSavedArp = new Map<string, string>()
  createEffect(() => {
    const id = currentTargetId(); if (!id || id === 'master') return
    ;(async () => {
      try {
        const row = await convexClient.query((convexApi as any).effects.getArpeggiatorForTrack, { trackId: id as any })
        if (row?.params) {
          const p = row.params as ArpeggiatorParams
          setArpByTarget(prev => ({ ...prev, [id]: p }))
          lastSavedArp.set(id, JSON.stringify(p))
          props.audioEngine?.setTrackArpeggiator(id, p)
        } else {
          setArpByTarget(prev => ({ ...prev, [id]: undefined }))
          props.audioEngine?.clearTrackArpeggiator?.(id)
        }
      } catch {
        setArpByTarget(prev => ({ ...prev, [id]: undefined }))
        props.audioEngine?.clearTrackArpeggiator?.(id)
      }
    })()
  })

  // Apply/persist arpeggiator on change
  createEffect(() => {
    const id = currentTargetId(); if (!id || id === 'master') return
    const params = arpForTarget(); if (!params) return
    const json = JSON.stringify(params)
    if (lastSavedArp.get(id) === json) return
    lastSavedArp.set(id, json)
    props.audioEngine?.setTrackArpeggiator(id, params)
    if (props.roomId && props.userId) {
      void convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, {
        roomId: props.roomId,
        trackId: id as any,
        userId: props.userId,
        params,
      })
    }
  })

  function updateArp(updater: (prev: ArpeggiatorParams) => ArpeggiatorParams) {
    const id = currentTargetId(); if (!id) return
    setArpByTarget(prev => ({ ...prev, [id]: updater(prev[id] ?? createDefaultArpeggiatorParams()) }))
  }

  function handleArpChange(updates: Partial<ArpeggiatorParams>) {
    updateArp(prev => ({ ...prev!, ...updates }))
  }

  function handleArpToggle(enabled: boolean) {
    updateArp(prev => ({ ...prev!, enabled }))
  }

  function handleArpReset() {
    updateArp(() => createDefaultArpeggiatorParams())
  }

  // Load synth from Convex for selected track
  const lastSavedSynth = new Map<string, string>()
  createEffect(() => {
    const id = currentTargetId(); if (!id || id === 'master') return
    ;(async () => {
      try {
        const row = await convexClient.query((convexApi as any).effects.getSynthForTrack, { trackId: id as any })
        if (row?.params) {
          const p = row.params as SynthParams
          setSynthByTarget(prev => ({ ...prev, [id]: p }))
          lastSavedSynth.set(id, JSON.stringify(p))
          props.audioEngine?.setTrackSynth(id, p)
        } else {
          const track = props.tracks.find(t => t.id === id)
          if (track?.kind === 'instrument') {
            setSynthByTarget(prev => {
              if (prev[id]) return prev
              return { ...prev, [id]: createDefaultSynthParams() }
            })
          } else {
            setSynthByTarget(prev => ({ ...prev, [id]: undefined }))
          }
        }
      } catch {
        setSynthByTarget(prev => ({ ...prev, [id]: undefined }))
      }
    })()
  })

  // Apply/persist on change
  createEffect(() => {
    const id = currentTargetId(); if (!id || id === 'master') return
    const params = synthForTarget(); if (!params) return
    const json = JSON.stringify(params)
    if (lastSavedSynth.get(id) === json) return
    lastSavedSynth.set(id, json)
    props.audioEngine?.setTrackSynth(id, params)
    if (props.roomId && props.userId) {
      void convexClient.mutation((convexApi as any).effects.setSynthParams, {
        roomId: props.roomId,
        trackId: id as any,
        userId: props.userId,
        params,
      })
    }
  })

  function updateSynth(updater: (prev: SynthParams) => SynthParams) {
    const id = currentTargetId(); if (!id) return
    setSynthByTarget(prev => ({ ...prev, [id]: updater(prev[id] ?? createDefaultSynthParams()) }))
  }

  function handleSynthChange(updates: Partial<SynthParams>) {
    updateSynth(prev => ({ ...prev!, ...updates }))
  }

  function handleSynthReset() {
    updateSynth(() => createDefaultSynthParams())
  }

  // ===== MIDI: Add MIDI Clip on instrument tracks =====
  async function handleAddMidiClip() {
    const track = currentTrack(); if (!track) return
    if ((track.kind as any) !== 'instrument') return
    const rid = props.roomId; const uid = props.userId
    if (!rid || !uid) return
    const start = Math.max(0, Math.round((props.playheadSec ?? 0) * 1000) / 1000)
    try {
      const clipId = await convexClient.mutation(convexApi.clips.create as any, {
        roomId: rid,
        trackId: track.id as any,
        startSec: start,
        duration: 1,
        userId: uid,
        name: 'MIDI Clip',
      } as any) as any as string
      if (!clipId) return
      await convexClient.mutation((convexApi as any).clips.setMidi, {
        clipId: clipId as any,
        midi: {
          wave: 'sawtooth',
          gain: 0.8,
          notes: [],
        },
        userId: uid,
      })
      // Hint parent to select/jump
      props.onSelectClip?.(track.id, clipId, start)
    } catch (err) {
      console.warn('[EffectsPanel] failed to add MIDI clip', err)
    }
  }

  // Local EQ params per FX target (trackId or 'master'); undefined = no EQ yet
  const [eqByTarget, setEqByTarget] = createSignal<Record<string, EqParams | undefined>>({})

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
          <div class="flex h-[280px]">
            <div class="flex w-20 flex-col items-center gap-2 border-r border-neutral-800 px-2 py-2">
              <Button variant="outline" size="sm" class="w-full text-[10px] py-1" onClick={props.onClose}>Hide</Button>
              <Show when={currentTrack() && currentTrack()!.kind === 'instrument'}>
                <Button variant="default" size="sm" class="w-full text-[10px] py-1 px-1" onClick={handleAddMidiClip}>+ MIDI</Button>
              </Show>
              <div class="flex flex-1 items-center justify-center">
                <span
                  class="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-neutral-300"
                  style={{ transform: 'rotate(-90deg)', 'white-space': 'nowrap' }}
                >
                  {targetName()}
                </span>
              </div>
            </div>
            <div class="flex flex-1 flex-col overflow-hidden">
              <div class="flex flex-wrap items-center gap-1.5 px-2 py-0.5 border-b border-neutral-800/50 min-h-[28px]">
                <Show when={currentTrack() && currentTrack()!.kind === 'instrument' && !arpForTarget()}>
                  <Button variant="default" size="sm" class="text-[11px] py-0.5 px-2 h-6" onClick={() => {
                    const id = currentTargetId(); if (!id) return
                    const params = createDefaultArpeggiatorParams()
                    setArpByTarget(prev => ({ ...prev, [id]: params }))
                    props.audioEngine?.setTrackArpeggiator(id, params)
                    if (props.roomId && props.userId) {
                      void convexClient.mutation((convexApi as any).effects.setArpeggiatorParams, {
                        roomId: props.roomId,
                        trackId: id as any,
                        userId: props.userId,
                        params,
                      })
                    }
                    lastSavedArp.set(id, JSON.stringify(params))
                  }}>+ Arp</Button>
                </Show>
                <Show when={!eqForTarget()}>
                  <Button variant="default" size="sm" class="text-[11px] py-0.5 px-2 h-6" onClick={handleAddEq}>+ EQ</Button>
                </Show>
                <Show when={!reverbForTarget()}>
                  <Button
                    variant="default"
                    size="sm"
                    class="text-[11px] py-0.5 px-2 h-6"
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
                  >+ Reverb</Button>
                </Show>
              </div>
              <div class="flex-1 overflow-x-auto overflow-y-hidden px-2 py-2">
                <div class="flex items-stretch gap-3 h-full min-w-min">
                  {/* MIDI Effects (pre-synth) - LEFTMOST */}
                  <Show when={currentTrack() && currentTrack()!.kind === 'instrument' && !!arpForTarget()}>
                    <Arpeggiator
                      params={arpForTarget()!}
                      onChange={handleArpChange}
                      onToggleEnabled={handleArpToggle}
                      onReset={handleArpReset}
                      class="min-w-[280px]"
                    />
                  </Show>
                  
                  {/* Instrument (Synth) */}
                  <Show when={currentTrack() && currentTrack()!.kind === 'instrument' && !!synthForTarget()}>
                    <Synth
                      params={synthForTarget()!}
                      onChange={handleSynthChange}
                      onReset={handleSynthReset}
                      class="min-w-[280px]"
                    />
                  </Show>
                  
                  <For each={orderedEffects()}>{(eff) => (
                    <Show when={eff === 'eq'} fallback={
                      <Show when={!!reverbForTarget()}>
                        <Reverb
                          params={reverbForTarget()!}
                          onChange={handleReverbChange}
                          onToggleEnabled={handleReverbToggle}
                          onReset={handleReverbReset}
                          class="min-w-[280px]"
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
                          class="min-w-[320px]"
                        />
                      </Show>
                    </Show>
                  )}</For>
                  
                  <Show when={!eqForTarget() && !reverbForTarget() && !arpForTarget() && (!synthForTarget() || !currentTrack() || currentTrack()!.kind !== 'instrument')}>
                    <div class="flex items-center text-sm text-neutral-400 px-4">
                      No effects on this {currentTargetId() === 'master' ? 'master bus' : 'track'}. Use Add EQ or Add Reverb.
                    </div>
                  </Show>
                </div>
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