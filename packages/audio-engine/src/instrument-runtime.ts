import { createDrumRackRuntime, type DrumRackResolvedBuffers } from './drum-rack-runtime'
import { createSynthRuntime } from './synth-runtime'
import type { SourceRegistry } from './source-registry'
import type { ArpParams, SynthParamsInput, TrackInstrumentParams } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

type InstrumentRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
}

export type SetTrackInstrumentInput =
  | { instrument: Extract<TrackInstrumentParams, { kind: 'synth' }> }
  | { instrument: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>; buffers?: DrumRackResolvedBuffers }

export function createInstrumentRuntime(options: InstrumentRuntimeOptions) {
  const activeKinds = new Map<string, TrackInstrumentParams['kind']>()
  const arpeggiators = new Map<string, ArpParams>()
  const synthRuntime = createSynthRuntime({ ...options, getArpeggiator: (trackId) => arpeggiators.get(trackId) })
  const drumRackRuntime = createDrumRackRuntime({ ...options, getArpeggiator: (trackId) => arpeggiators.get(trackId) })

  const setTrackSynth = (trackId: string, params: SynthParamsInput) => {
    if (activeKinds.get(trackId) === 'drum-rack') drumRackRuntime.clearTrackDrumRack(trackId)
    activeKinds.set(trackId, 'synth')
    synthRuntime.setTrackSynth(trackId, params)
  }

  const clearTrackSynth = (trackId: string) => {
    if (activeKinds.get(trackId) === 'synth') activeKinds.delete(trackId)
    synthRuntime.disposeTrack(trackId)
  }

  const clearTrackInstrument = (trackId: string) => {
    activeKinds.delete(trackId)
    synthRuntime.disposeTrack(trackId)
    drumRackRuntime.clearTrackDrumRack(trackId)
  }

  return {
    setTrackInstrument: (trackId: string, input: SetTrackInstrumentInput) => {
      if (input.instrument.kind === 'synth') {
        setTrackSynth(trackId, input.instrument.params)
        return
      }
      if (activeKinds.get(trackId) === 'synth') synthRuntime.disposeTrack(trackId)
      activeKinds.set(trackId, 'drum-rack')
      drumRackRuntime.setTrackDrumRack(trackId, input.instrument.params, 'buffers' in input ? input.buffers : undefined)
    },
    clearTrackInstrument,
    setTrackSynth,
    clearTrackSynth,
    setTrackDrumRack: (trackId: string, params: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>['params'], buffers?: DrumRackResolvedBuffers) => {
      if (activeKinds.get(trackId) === 'synth') synthRuntime.disposeTrack(trackId)
      activeKinds.set(trackId, 'drum-rack')
      drumRackRuntime.setTrackDrumRack(trackId, params, buffers)
    },
    clearTrackDrumRack: (trackId: string) => {
      if (activeKinds.get(trackId) === 'drum-rack') activeKinds.delete(trackId)
      drumRackRuntime.clearTrackDrumRack(trackId)
    },
    setTrackArpeggiator: (trackId: string, params: ArpParams) => {
      arpeggiators.set(trackId, params)
    },
    clearTrackArpeggiator: (trackId: string) => {
      arpeggiators.delete(trackId)
    },
    getTrackInstrumentKind: (trackId: string) => activeKinds.get(trackId),
    getTrackSynthGainNode: synthRuntime.getTrackSynthGainNode,
    getTrackSynthPreviewState: synthRuntime.getTrackSynthPreviewState,
    scheduleMidiClip: (track: RuntimeTrack, clip: RuntimeClip, playheadSec: number, nowCtx: number, endLimitSec?: number): boolean => {
      if (activeKinds.get(track.id) === 'drum-rack') return drumRackRuntime.scheduleMidiClip(track, clip, playheadSec, nowCtx, endLimitSec)
      return synthRuntime.scheduleMidiClip(track, clip, playheadSec, nowCtx, endLimitSec)
    },
    previewDrumRackPad: drumRackRuntime.previewPad,
    previewDrumRackNote: drumRackRuntime.previewNote,
    stopClip: (clipId: string) => {
      synthRuntime.stopClip(clipId)
      drumRackRuntime.stopClip(clipId)
    },
    stopAll: () => {
      synthRuntime.stopAll()
      drumRackRuntime.stopAll()
    },
    disposeTrack: (trackId: string) => {
      activeKinds.delete(trackId)
      arpeggiators.delete(trackId)
      synthRuntime.disposeTrack(trackId)
      drumRackRuntime.disposeTrack(trackId)
    },
    clearActiveOscillators: synthRuntime.clearActiveOscillators,
    clear: () => {
      activeKinds.clear()
      arpeggiators.clear()
      synthRuntime.clear()
      drumRackRuntime.clear()
    },
  }
}
