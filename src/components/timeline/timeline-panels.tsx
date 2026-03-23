import { type Accessor, type Component, Show, Suspense, lazy } from 'solid-js'
import { Button } from '~/components/ui/button'
import type { AudioEngine } from '~/lib/audio-engine'
import type { Track, TrackSend } from '~/types/timeline'

const AgentChat = lazy(() => import('~/components/AgentChat'))
const SharedChat = lazy(() => import('~/components/SharedChat'))
const EffectsPanel = lazy(() => import('~/components/timeline/EffectsPanel'))
const ExportDialog = lazy(() => import('~/components/timeline/ExportDialog'))

type TimelinePanelsState = {
  bottomFXOpen: Accessor<boolean>
  agentPanelOpen: Accessor<boolean>
  sharedChatOpen: Accessor<boolean>
  exportOpen: Accessor<boolean>
  bottomOffsetPx: Accessor<number>
  selectedFXTarget: Accessor<string>
  tracks: Accessor<Track[]>
  playheadSec: Accessor<number>
  bpm: Accessor<number>
  loopEnabled: Accessor<boolean>
  loopStartSec: Accessor<number>
  loopEndSec: Accessor<number>
}

type TimelinePanelsSession = {
  roomId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
}

type TimelinePanelsActions = {
  toggleAgentPanel: () => void
  toggleSharedChat: () => void
  closeAgentPanel: () => void
  closeSharedChat: () => void
  closeEffects: () => void
  openEffects: () => void
  closeExport: () => void
  canWriteTrackRouting: (trackId: string) => boolean
  grantClipWrite: (clipId: string) => void
  trackSendsChange: (trackId: string, sends: TrackSend[]) => void
  trackOutputTargetChange: (trackId: string, outputTargetId?: string) => void
  selectClip: (trackId: string, clipId: string, startSec: number) => void
  applyAgentMixOps: (ops: Array<{ type: 'setMute' | 'setSolo'; indices: number[]; value: boolean; exclusive?: boolean }>) => void
  effectParamsCommitted: (payload: { targetId: string; effect: 'eq'|'reverb'|'synth'|'arp'|'master-eq'|'master-reverb'; from: any; to: any }) => void
}

type TimelinePanelsProps = {
  state: TimelinePanelsState
  session: TimelinePanelsSession
  audioEngine: AudioEngine
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  actions: TimelinePanelsActions
}

const TimelinePanels: Component<TimelinePanelsProps> = (props) => {
  const floatingButtonOffset = () => props.state.bottomOffsetPx() > 0 ? `${props.state.bottomOffsetPx()}px` : '16px'

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        class="fixed left-4 z-40 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        style={{ bottom: floatingButtonOffset() }}
        aria-label="Toggle AI Chat"
        onClick={props.actions.toggleAgentPanel}
      >
        AI Chat
      </Button>

      <Button
        variant="outline"
        size="sm"
        class="fixed left-24 z-40 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        style={{ bottom: floatingButtonOffset() }}
        aria-label="Toggle Room Chat"
        onClick={props.actions.toggleSharedChat}
      >
        Room Chat
      </Button>

      <Show when={props.state.agentPanelOpen()}>
        <Suspense fallback={null}>
          <AgentChat
            isOpen={props.state.agentPanelOpen()}
            onClose={props.actions.closeAgentPanel}
            roomId={props.session.roomId()}
            userId={props.session.userId()}
            bpm={props.state.bpm()}
            bottomOffsetPx={props.state.bottomOffsetPx()}
            onApplyMixOps={props.actions.applyAgentMixOps}
          />
        </Suspense>
      </Show>

      <Show when={props.state.sharedChatOpen()}>
        <Suspense fallback={null}>
          <SharedChat
            isOpen={props.state.sharedChatOpen()}
            onClose={props.actions.closeSharedChat}
            roomId={props.session.roomId()}
            userId={props.session.userId()}
            bottomOffsetPx={props.state.bottomOffsetPx()}
          />
        </Suspense>
      </Show>

      <Suspense fallback={null}>
        <EffectsPanel
          isOpen={props.state.bottomFXOpen()}
          selectedFXTarget={props.state.selectedFXTarget()}
          tracks={props.state.tracks()}
          onClose={props.actions.closeEffects}
          onOpen={props.actions.openEffects}
          audioEngine={props.audioEngine}
          roomId={props.session.roomId()}
          userId={props.session.userId()}
          canWriteTrackRouting={props.actions.canWriteTrackRouting}
          grantClipWrite={props.actions.grantClipWrite}
          playheadSec={props.state.playheadSec()}
          onTrackSendsChange={props.actions.trackSendsChange}
          onTrackOutputTargetChange={props.actions.trackOutputTargetChange}
          onSelectClip={props.actions.selectClip}
          onEffectParamsCommitted={props.actions.effectParamsCommitted}
        />
      </Suspense>

      <Show when={props.state.exportOpen()}>
        <Suspense fallback={null}>
          <ExportDialog
            isOpen={props.state.exportOpen()}
            onClose={props.actions.closeExport}
            tracks={props.state.tracks()}
            bpm={props.state.bpm()}
            loopEnabled={props.state.loopEnabled()}
            loopStartSec={props.state.loopStartSec()}
            loopEndSec={props.state.loopEndSec()}
            roomId={props.session.roomId()}
            userId={props.session.userId()}
            ensureClipBuffer={props.ensureClipBuffer}
          />
        </Suspense>
      </Show>
    </>
  )
}

export default TimelinePanels
