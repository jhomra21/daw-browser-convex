import { type Component, Show, Suspense, lazy } from 'solid-js'
import { Button } from '~/components/ui/button'
import type { AudioEngine } from '~/lib/audio-engine'
import type { Track, TrackSend } from '~/types/timeline'

const AgentChat = lazy(() => import('~/components/AgentChat'))
const SharedChat = lazy(() => import('~/components/SharedChat'))
const EffectsPanel = lazy(() => import('~/components/timeline/EffectsPanel'))
const ExportDialog = lazy(() => import('~/components/timeline/ExportDialog'))

type TimelinePanelsProps = {
  timeline: {
    bottomFXOpen: boolean
    agentPanelOpen: boolean
    sharedChatOpen: boolean
    exportOpen: boolean
    bottomOffsetPx: number
    selectedFXTarget: string
    tracks: Track[]
    playheadSec: number
    bpm: number
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    roomId?: string
    userId?: string
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
  audioEngine: AudioEngine
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
}

const TimelinePanels: Component<TimelinePanelsProps> = (props) => {
  const timeline = props.timeline
  const floatingButtonOffset = () => timeline.bottomOffsetPx > 0 ? `${timeline.bottomOffsetPx}px` : '16px'

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        class="fixed left-4 z-40 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        style={{ bottom: floatingButtonOffset() }}
        aria-label="Toggle AI Chat"
        onClick={timeline.toggleAgentPanel}
      >
        AI Chat
      </Button>

      <Button
        variant="outline"
        size="sm"
        class="fixed left-24 z-40 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        style={{ bottom: floatingButtonOffset() }}
        aria-label="Toggle Room Chat"
        onClick={timeline.toggleSharedChat}
      >
        Room Chat
      </Button>

      <Show when={timeline.agentPanelOpen}>
        <Suspense fallback={null}>
          <AgentChat
            isOpen={timeline.agentPanelOpen}
            onClose={timeline.closeAgentPanel}
            roomId={timeline.roomId}
            userId={timeline.userId}
            bpm={timeline.bpm}
            bottomOffsetPx={timeline.bottomOffsetPx}
            onApplyMixOps={timeline.applyAgentMixOps}
          />
        </Suspense>
      </Show>

      <Show when={timeline.sharedChatOpen}>
        <Suspense fallback={null}>
          <SharedChat
            isOpen={timeline.sharedChatOpen}
            onClose={timeline.closeSharedChat}
            roomId={timeline.roomId}
            userId={timeline.userId}
            bottomOffsetPx={timeline.bottomOffsetPx}
          />
        </Suspense>
      </Show>

      <Suspense fallback={null}>
        <EffectsPanel
          isOpen={timeline.bottomFXOpen}
          selectedFXTarget={timeline.selectedFXTarget}
          tracks={timeline.tracks}
          onClose={timeline.closeEffects}
          onOpen={timeline.openEffects}
          audioEngine={props.audioEngine}
          roomId={timeline.roomId}
          userId={timeline.userId}
          canWriteTrackRouting={timeline.canWriteTrackRouting}
          grantClipWrite={timeline.grantClipWrite}
          playheadSec={timeline.playheadSec}
          onTrackSendsChange={timeline.trackSendsChange}
          onTrackOutputTargetChange={timeline.trackOutputTargetChange}
          onSelectClip={timeline.selectClip}
          onEffectParamsCommitted={timeline.effectParamsCommitted}
        />
      </Suspense>

      <Show when={timeline.exportOpen}>
        <Suspense fallback={null}>
          <ExportDialog
            isOpen={timeline.exportOpen}
            onClose={timeline.closeExport}
            tracks={timeline.tracks}
            bpm={timeline.bpm}
            loopEnabled={timeline.loopEnabled}
            loopStartSec={timeline.loopStartSec}
            loopEndSec={timeline.loopEndSec}
            roomId={timeline.roomId}
            userId={timeline.userId}
            ensureClipBuffer={props.ensureClipBuffer}
          />
        </Suspense>
      </Show>
    </>
  )
}

export default TimelinePanels
