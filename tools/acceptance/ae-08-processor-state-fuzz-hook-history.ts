import { ConvexClient } from "convex/browser"
import type { Accessor } from "solid-js"
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import { isAudioEffectKind, normalizeTrackInstrumentParams } from "@daw-browser/shared"
import type { Track } from "@daw-browser/timeline-core/types"
import { api } from "../../convex/_generated/api"
import { createAudioEffectParameterPayload } from "../../src/components/timeline/audio-effect-parameter-payload"
import type { createProcessorEditRegistry } from "../../src/components/timeline/create-processor-edit-registry"
import type { createEffectsPanelAudioDevice } from "../../src/components/timeline/create-effects-panel-audio-effects-state"
import { createDrumRackBufferSync } from "../../src/lib/drum-rack-buffer-sync"
import { useTimelineHistory, type TimelineHistoryActions } from "../../src/hooks/useTimelineHistory"

// Local projects never reach the Convex client; useTimelineHistory only forwards
// it. A real client over a socket that never opens keeps the type honest with
// no network and no timers.
class InertSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  binaryType: BinaryType = "blob"
  readonly bufferedAmount = 0
  readonly extensions = ""
  readonly protocol = ""
  readonly readyState = 0
  readonly url: string
  onclose: WebSocket["onclose"] = null
  onerror: WebSocket["onerror"] = null
  onmessage: WebSocket["onmessage"] = null
  onopen: WebSocket["onopen"] = null
  constructor(url: string | URL) { super(); this.url = String(url) }
  send() {}
  close() {}
}

const unexpected = (name: string) => () => { throw new Error(`Effect history reached unexpected action ${name}`) }
const unexpectedActions: TimelineHistoryActions = {
  insertLocalTrack: unexpected("insertLocalTrack"), removeLocalTrack: unexpected("removeLocalTrack"),
  insertLocalClip: unexpected("insertLocalClip"), replaceLocalClip: unexpected("replaceLocalClip"),
  removeLocalClips: unexpected("removeLocalClips"), commitClipMoves: unexpected("commitClipMoves"),
  commitClipTiming: unexpected("commitClipTiming"), commitClipAudioWarp: unexpected("commitClipAudioWarp"),
  commitClipFades: unexpected("commitClipFades"), commitClipMidi: unexpected("commitClipMidi"),
  rescheduleChangedClips: unexpected("rescheduleChangedClips"),
  cancelTrackVolumeWrite: unexpected("cancelTrackVolumeWrite"), cancelTrackRoutingWrite: unexpected("cancelTrackRoutingWrite"),
  cancelTrackMixWrite: unexpected("cancelTrackMixWrite"), applyTrackVolume: unexpected("applyTrackVolume"),
  applyTrackMixState: unexpected("applyTrackMixState"), applyTrackRouting: unexpected("applyTrackRouting"),
  applyTrackPatch: unexpected("applyTrackPatch"), applyAutomationEnvelope: unexpected("applyAutomationEnvelope"),
}

type Input = {
  projectId: string
  tracks: Accessor<Track[]>
  engine: AudioEngine
  panel: Pick<ReturnType<typeof createEffectsPanelAudioDevice>, "replayInstanceParams">
  processorEdits: ReturnType<typeof createProcessorEditRegistry>
  notify: (title: string, message: string) => void
}

// The production history adapter over the local project store, wired exactly as
// Timeline.tsx wires the processor-edit reservation and replay seams.
export default function mountHookHistory(input: Input) {
  const client = new ConvexClient("https://inert.invalid", {
    webSocketConstructor: InertSocket, skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false,
  })
  const history = useTimelineHistory({
    projectId: () => input.projectId,
    userId: () => "local",
    getTracks: input.tracks,
    convexClient: client,
    convexApi: api,
    audioEngine: input.engine,
    replayInstanceEffectParams: (payload) => input.panel.replayInstanceParams(payload),
    releaseInstanceEffectEdit: input.processorEdits.release,
    reserveInstanceEffectEdit: ({ targetId, effect, instanceId, params }) => {
      if (effect === "instrument") {
        const instrument = normalizeTrackInstrumentParams(params)
        return instrument && input.processorEdits.reserve({ targetId, effect, from: instrument, to: instrument })
      }
      const kind = effect.replace(/^master-/, "")
      return instanceId && isAudioEffectKind(kind)
        ? input.processorEdits.reserve(createAudioEffectParameterPayload({ targetId, instanceId, kind }, params, params))
        : undefined
    },
    grantTrackWrite: () => {},
    grantClipWrite: () => {},
    persistLocalMix: unexpected("persistLocalMix"),
    drumRackBufferSync: createDrumRackBufferSync(),
    notify: input.notify,
    getActions: () => unexpectedActions,
  })
  return { ...history, close: () => client.close() }
}
