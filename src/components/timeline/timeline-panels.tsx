import { type Component, Show, Suspense, lazy } from 'solid-js'
import { Button } from '~/components/ui/button'
import type { AudioEngine } from '~/lib/audio-engine'
import type { OptimisticGrantWrite } from '~/lib/optimistic-grant-scope'
import type { EffectParamsCommitPayload, EffectType } from '~/lib/undo/types'
import type { Track, TrackSend } from '~/types/timeline'

const AgentChat = lazy(() => import('~/components/AgentChat'))
const SharedChat = lazy(() => import('~/components/SharedChat'))
const EffectsPanel = lazy(() => import('~/components/timeline/EffectsPanel'))
const ExportDialog = lazy(() => import('~/components/timeline/ExportDialog'))

type TimelinePanelsProps = {
  chat: {
    bottomOffsetPx: number
    agentPanelOpen: boolean
    sharedChatOpen: boolean
    roomId?: string
    userId?: string
    bpm: number
    toggleAgentPanel: () => void
    toggleSharedChat: () => void
    closeAgentPanel: () => void
    closeSharedChat: () => void
    applyAgentMixOps: (ops: Array<{ type: 'setMute' | 'setSolo'; indices: number[]; value: boolean; exclusive?: boolean; issuedAt: number }>) => void
  }
  effectsPanel: {
    isOpen: boolean
    selectedFXTarget: string
    tracks: Track[]
    playheadSec: number
    roomId?: string
    userId?: string
    audioEngine: AudioEngine
    canWriteTrackRouting: (trackId: Track['id']) => boolean
    grantClipWrite: OptimisticGrantWrite
    onTrackSendsChange: (trackId: Track['id'], sends: TrackSend[]) => void
    onTrackOutputTargetChange: (trackId: Track['id'], outputTargetId?: Track['id']) => void
    onSelectClip: (trackId: Track['id'], clipId: string, startSec: number) => void
    onClose: () => void
    onOpen: () => void
    onEffectParamsCommitted: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>) => void
  }
  exportDialog: {
    isOpen: boolean
    tracks: Track[]
    bpm: number
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    roomId?: string
    userId?: string
    ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
    onClose: () => void
  }
}

const TimelinePanels: Component<TimelinePanelsProps> = (props) => {
  const floatingButtonOffset = () => props.chat.bottomOffsetPx > 0 ? `${props.chat.bottomOffsetPx}px` : '16px'

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        class="fixed left-4 z-40 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        style={{ bottom: floatingButtonOffset() }}
        aria-label="Toggle AI Chat"
        onClick={props.chat.toggleAgentPanel}
      >
        AI Chat
      </Button>

      <Button
        variant="outline"
        size="sm"
        class="fixed left-24 z-40 bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
        style={{ bottom: floatingButtonOffset() }}
        aria-label="Toggle Room Chat"
        onClick={props.chat.toggleSharedChat}
      >
        Room Chat
      </Button>

      <Show when={props.chat.agentPanelOpen}>
        <Suspense fallback={null}>
          <AgentChat
            isOpen={props.chat.agentPanelOpen}
            onClose={props.chat.closeAgentPanel}
            roomId={props.chat.roomId}
            userId={props.chat.userId}
            bpm={props.chat.bpm}
            bottomOffsetPx={props.chat.bottomOffsetPx}
            onApplyMixOps={props.chat.applyAgentMixOps}
          />
        </Suspense>
      </Show>

      <Show when={props.chat.sharedChatOpen}>
        <Suspense fallback={null}>
          <SharedChat
            isOpen={props.chat.sharedChatOpen}
            onClose={props.chat.closeSharedChat}
            roomId={props.chat.roomId}
            userId={props.chat.userId}
            bottomOffsetPx={props.chat.bottomOffsetPx}
          />
        </Suspense>
      </Show>

      <Suspense fallback={null}>
        <EffectsPanel
          isOpen={props.effectsPanel.isOpen}
          selectedFXTarget={props.effectsPanel.selectedFXTarget}
          tracks={props.effectsPanel.tracks}
          onClose={props.effectsPanel.onClose}
          onOpen={props.effectsPanel.onOpen}
          audioEngine={props.effectsPanel.audioEngine}
          roomId={props.effectsPanel.roomId}
          userId={props.effectsPanel.userId}
          canWriteTrackRouting={props.effectsPanel.canWriteTrackRouting}
          grantClipWrite={props.effectsPanel.grantClipWrite}
          playheadSec={props.effectsPanel.playheadSec}
          onTrackSendsChange={props.effectsPanel.onTrackSendsChange}
          onTrackOutputTargetChange={props.effectsPanel.onTrackOutputTargetChange}
          onSelectClip={props.effectsPanel.onSelectClip}
          onEffectParamsCommitted={props.effectsPanel.onEffectParamsCommitted}
        />
      </Suspense>

      <Show when={props.exportDialog.isOpen}>
        <Suspense fallback={null}>
          <ExportDialog
            isOpen={props.exportDialog.isOpen}
            onClose={props.exportDialog.onClose}
            tracks={props.exportDialog.tracks}
            bpm={props.exportDialog.bpm}
            loopEnabled={props.exportDialog.loopEnabled}
            loopStartSec={props.exportDialog.loopStartSec}
            loopEndSec={props.exportDialog.loopEndSec}
            roomId={props.exportDialog.roomId}
            userId={props.exportDialog.userId}
            ensureClipBuffer={props.exportDialog.ensureClipBuffer}
          />
        </Suspense>
      </Show>
    </>
  )
}

export default TimelinePanels
