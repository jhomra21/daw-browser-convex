import {
  compilePortableSessionInput,
  compilePreparedPortableSession,
  type PortableAssetRegistryInput,
} from '@daw-browser/audio-engine/portable-session-compiler'
import type { LivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import {
  compilePortableFrameSchedule,
  type PortableFrameScheduleAdapterInput,
} from '~/lib/portable-frame-schedule'

/**
 * App boundary only: the engine receives portable data and never imports the
 * browser's AudioBuffer-bearing playback snapshot.
 */
export const compilePortableLiveSession = (snapshot: LivePlaybackSnapshot) =>
  compilePortableSessionInput({
    mixer: snapshot.mixer.graph,
    fx: snapshot.mixer.fx,
    automationEnvelopes: snapshot.mixer.automationEnvelopes,
  })

export const compilePortableLiveFrameSchedule = (
  snapshot: LivePlaybackSnapshot,
  input: Omit<PortableFrameScheduleAdapterInput, 'revision' | 'bpm' | 'tracks' | 'automationEnvelopes' | 'arpeggiators'>,
) => compilePortableFrameSchedule({
  ...input,
  revision: snapshot.revision,
  bpm: snapshot.bpm,
  tracks: snapshot.tracks,
  automationEnvelopes: snapshot.mixer.automationEnvelopes,
  arpeggiators: new Map(Object.entries(snapshot.mixer.fx.trackFx ?? {}).map(([trackId, fx]) => [trackId, fx.arp])),
})

type PortableLiveSessionAdapterInput = Omit<
  PortableFrameScheduleAdapterInput,
  'revision' | 'bpm' | 'tracks' | 'automationEnvelopes' | 'arpeggiators'
> & {
  assetRegistry: PortableAssetRegistryInput
}

/**
 * App-only assembly: browser timeline authorities produce the schedule while
 * the engine owns every portable graph, asset, and target validation rule.
 */
export const compilePreparedPortableLiveSession = (
  snapshot: LivePlaybackSnapshot,
  input: PortableLiveSessionAdapterInput,
) => compilePreparedPortableSession({
  mixer: snapshot.mixer.graph,
  fx: snapshot.mixer.fx,
  automationEnvelopes: snapshot.mixer.automationEnvelopes,
  tracks: snapshot.tracks,
  assetRegistry: input.assetRegistry,
  revision: snapshot.revision,
  sampleRateHz: input.sampleRateHz,
  bpm: snapshot.bpm,
  sidechainRoutes: snapshot.mixer.sidechainRoutes,
  sourceRangeEndSec: input.rangeEndSec,
  sourceFirstSequence: 1,
  schedule: compilePortableLiveFrameSchedule(snapshot, input),
})
