import type { Accessor } from "solid-js"
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import type { Track } from "@daw-browser/timeline-core/types"
import type { createNativePlaybackController } from "~/lib/desktop/native-playback-controller"
import type { LivePlaybackCompileContext, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import type { PlaybackAcceptanceObserver } from "~/lib/desktop/acceptance-observer"
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver"

export type LoopOptions = {
  bpm?: Accessor<number>
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  getTracks?: Accessor<Track[]>
  preflightPlayback?: () => Promise<boolean>
}

export type NativePlaybackOptions = {
  requiresNativeAudio?: boolean
  enabled?: Accessor<boolean>
  projectId?: Accessor<string>
  projectGeneration?: Accessor<number>
  outputDeviceId?: Accessor<string>
  isRecording?: Accessor<boolean>
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  captureNativeVstStates?: (capture: { projectId: string; instanceIds: readonly string[] }) => Promise<void>
  reportFault?: Parameters<typeof createNativePlaybackController>[0]["reportFault"]
  instrumentBudget?: Parameters<typeof createNativePlaybackController>[0]['instrumentBudget']
  onInstrumentPreparation?: Parameters<typeof createNativePlaybackController>[0]['onInstrumentPreparation']
  resolveAudioSource?: AudioPcmSourceResolver
  keepLatencyNodeIds?: Accessor<ReadonlySet<string>>
  playbackInputs?: Accessor<object>
  getDesiredProcessorState?: Parameters<typeof createNativePlaybackController>[0]["getDesiredProcessorState"]
  getProcessorTarget?: Parameters<typeof createNativePlaybackController>[0]["getProcessorTarget"]
  acceptance?: PlaybackAcceptanceObserver
}

export type PortableBrowserPlaybackOptions = {
  projectGeneration?: Accessor<number>
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  reportFault?: (message: string) => void
  resolveAudioSource?: AudioPcmSourceResolver
}

// What an edit carries from its gesture. It names the project it was made in and what its compile needs; the transport it
// joins is the one its session has when it is adopted.
export type TimelineEditIntent = {
  projectId?: string
  projectGeneration?: number
  instrumentOverride?: LivePlaybackCompileContext["instrumentOverride"]
  externalProcessor?: LivePlaybackCompileContext["externalProcessor"]
}

// A lifecycle rebuild replaces its session at the transport it names.
export type TimelinePlaybackRebuildIntent = TimelineEditIntent & {
  resumePlayback: boolean
  playheadSec: number
  owner?: 'native' | 'portable-browser'
}

export type TimelineScheduleOptions =
  | (TimelineEditIntent & { rebuildBackend?: false })
  | (TimelineEditIntent & Partial<TimelinePlaybackRebuildIntent> & Pick<TimelinePlaybackRebuildIntent, "resumePlayback"> & { rebuildBackend: true })

export type ActiveAudioBackend = 'idle' | 'portable-browser' | 'native'

export type TimelinePlaybackAudioEngine = Pick<
  AudioEngine,
  | 'currentTimelineSec'
  | 'ensureAudio'
  | 'applyAutomationAtTimelineSec'
  | 'cancelAutomationSchedules'
  | 'onTransportPause'
  | 'onTransportSeek'
  | 'onTransportStart'
  | 'onTransportStop'
  | 'resume'
  | 'scheduleAutomationFromPlayhead'
  | 'stopAllSources'
> & {
  getAudioContext?: () => AudioContext | null
  getTrackSpectrum?: AudioEngine['getTrackSpectrum']
  getMasterSpectrum?: AudioEngine['getMasterSpectrum']
  subscribeTrackStereoLevels?: AudioEngine['subscribeTrackStereoLevels']
  subscribeMasterStereoLevels?: AudioEngine['subscribeMasterStereoLevels']
}

export type RecoveryAttempt = {
  generation: number
  token: number
  cancelled: boolean
  promise?: Promise<void>
}
