import type { ArpParams, SynthParamsInput, TrackInstrumentParams } from '@daw-browser/shared'
import type { EngineDisposition } from './engine-disposition'
import type {
  DrumRackRegionUse,
  DrumRackResolvedBuffers,
  GranularInstalledBuffer,
  SamplerNoteMiss,
  SamplerRegionUse,
  SamplerResolvedBuffers,
} from './sampled-instrument-region'

export type SetTrackInstrumentInput =
  | { instrument: Pick<Extract<TrackInstrumentParams, { kind: 'synth' }>, 'kind' | 'params'> & { instanceId?: string } }
  | { instrument: { kind: 'drum-rack'; params: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>['params'] }; buffers?: DrumRackResolvedBuffers }
  | { instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>; buffers?: SamplerResolvedBuffers }
  | { instrument: Extract<TrackInstrumentParams, { kind: 'granular' }>; installedBuffer?: GranularInstalledBuffer }

type InstrumentRuntimeListeners = {
  onNoteMiss?: (miss: SamplerNoteMiss) => void
  onAssetUse?: (use: SamplerRegionUse) => void
  onDrumRackAssetUse?: (use: DrumRackRegionUse) => void
}

// The browser engine plays no instrument voices: the portable session renders them. This registry only records each
// track's declared instrument kind and arpeggiator so the editor and the portable compiler read one source.
export function createInstrumentRuntime() {
  const additionalListeners = new Set<InstrumentRuntimeListeners>()
  const activeKinds = new Map<string, TrackInstrumentParams['kind']>()
  const arpeggiators = new Map<string, ArpParams>()

  const declare = (trackId: string, kind: TrackInstrumentParams['kind']): EngineDisposition => {
    activeKinds.set(trackId, kind)

    return 'applied'
  }

  return {
    setTrackInstrument: (trackId: string, input: SetTrackInstrumentInput): EngineDisposition => declare(trackId, input.instrument.kind),
    clearTrackInstrument: (trackId: string) => {
      activeKinds.delete(trackId)
    },
    setTrackSynth: (trackId: string, _params: SynthParamsInput, _instanceId?: string): EngineDisposition => declare(trackId, 'synth'),
    setTrackDrumRack: (trackId: string, _params: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>['params'], _buffers?: DrumRackResolvedBuffers): EngineDisposition => declare(trackId, 'drum-rack'),
    clearTrackDrumRack: (trackId: string) => {
      if (activeKinds.get(trackId) === 'drum-rack') activeKinds.delete(trackId)
    },
    setTrackSampler: (trackId: string, _params: Extract<TrackInstrumentParams, { kind: 'sampler' }>['params'], _buffers?: SamplerResolvedBuffers, _instanceId?: string) => {
      declare(trackId, 'sampler')
    },
    setTrackGranular: (trackId: string, _params: Extract<TrackInstrumentParams, { kind: 'granular' }>['params'], _installedBuffer?: GranularInstalledBuffer, _instanceId?: string): Promise<EngineDisposition> => (
      Promise.resolve(declare(trackId, 'granular'))
    ),
    setTrackArpeggiator: (trackId: string, params: ArpParams) => {
      arpeggiators.set(trackId, params)
    },
    getTrackArpeggiator: (trackId: string) => arpeggiators.get(trackId),
    clearTrackArpeggiator: (trackId: string) => {
      arpeggiators.delete(trackId)
    },
    getTrackInstrumentKind: (trackId: string) => activeKinds.get(trackId),
    addSamplerRuntimeListeners: (listeners: InstrumentRuntimeListeners) => {
      additionalListeners.add(listeners)

      return () => additionalListeners.delete(listeners)
    },
    disposeTrack: (trackId: string) => {
      activeKinds.delete(trackId)
      arpeggiators.delete(trackId)
    },
    clear: () => {
      activeKinds.clear()
      arpeggiators.clear()
    },
  }
}
