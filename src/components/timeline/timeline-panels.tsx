import { type Component, Show, Suspense, createEffect, lazy } from 'solid-js'
import { Button } from '~/components/ui/button'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { isLocalId } from '@daw-browser/shared'
import { ExportProvider } from '~/context/export'
import ExportProgressOverlay from '~/components/export/ExportProgressOverlay'
import type { OptimisticGrantWrite } from '~/lib/optimistic-grant-scope'
import type { EffectParamsCommitPayload, EffectType } from '~/lib/undo/types'
import type { BpmDetectionService } from '~/lib/bpm-detection-service'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { TimelineBottomPanelShellControls } from '~/components/timeline/TimelineBottomPanelShell'

const AgentChat = lazy(() => import('~/components/AgentChat'))
const SharedChat = lazy(() => import('~/components/SharedChat'))
const EffectsPanel = lazy(() => import('~/components/timeline/EffectsPanel'))
const SampleDetailPanel = lazy(() => import('~/components/timeline/SampleDetailPanel'))
const ExportDialog = lazy(() => import('~/components/timeline/ExportDialog'))

export type TimelinePanelsProps = {
  chat: {
    bottomOffsetPx: number
    agentPanelOpen: boolean
    sharedChatOpen: boolean
    projectId?: string
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
    showOpenButton: boolean
    shell: TimelineBottomPanelShellControls
    clipTab: {
      canOpen: boolean
      onOpen: () => void
    }
    selectedFXTarget: Track['id'] | 'master'
    tracks: Track[]
    playheadSec: number
    projectId?: string
    userId?: string
    audioEngine: AudioEngine
    canWriteTrackRouting: (trackId: Track['id']) => boolean
    grantClipWrite: OptimisticGrantWrite
    onSelectClip: (trackId: Track['id'], clipId: string, startSec: number) => void
    insertLocalClip: (trackId: Track['id'], clip: Clip) => void
    onClose: () => void
    onOpen: () => void
    onEffectParamsCommitted: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void
    onLocalSaveFailed?: (message: string) => void
  }
  sampleDetailPanel: {
    isOpen: boolean
    selectedClip?: Clip<AudioBuffer>
    projectBpm: number
    audioEngine: AudioEngine
    bpmDetection: BpmDetectionService
    ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
    canWriteClip: (clipId: string) => boolean
    onChange: (clip: Clip, audioWarp: NonNullable<Clip['audioWarp']>) => Promise<boolean> | boolean | void
    onGainChange: (clip: Clip, gain: number) => Promise<boolean> | boolean | void
    onMarkerDragStateChange?: (dragging: boolean) => void
    shell: TimelineBottomPanelShellControls
    onClose: () => void
  }
  exportDialog: {
    isOpen: boolean
    tracks: Track[]
    getTracks: () => Track[]
    selectedTrackId?: string
    bpm: number
    masterVolume: number
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    projectId?: string
    userId?: string
    ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
    onClose: () => void
  }
}

const TimelinePanels: Component<TimelinePanelsProps> = (props) => {
  const floatingButtonOffset = () => props.chat.bottomOffsetPx > 0 ? `${props.chat.bottomOffsetPx}px` : '16px'
  const canUseAgentChat = () => !props.chat.projectId || !isLocalId('project', props.chat.projectId)
  const canUseSharedChat = () => Boolean(props.chat.projectId && !isLocalId('project', props.chat.projectId))

  createEffect(() => {
    if (!canUseAgentChat() && props.chat.agentPanelOpen) {
      props.chat.closeAgentPanel()
    }
    if (!canUseSharedChat() && props.chat.sharedChatOpen) {
      props.chat.closeSharedChat()
    }
  })

  return (
    <ExportProvider>
      <Show when={canUseAgentChat()}>
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
      </Show>

      <Show when={canUseSharedChat()}>
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
      </Show>

      <Show when={canUseAgentChat() && props.chat.agentPanelOpen}>
        <Suspense fallback={null}>
          <AgentChat
            isOpen={props.chat.agentPanelOpen}
            onClose={props.chat.closeAgentPanel}
            projectId={props.chat.projectId}
            userId={props.chat.userId}
            bpm={props.chat.bpm}
            bottomOffsetPx={props.chat.bottomOffsetPx}
            onApplyMixOps={props.chat.applyAgentMixOps}
          />
        </Suspense>
      </Show>

      <Show when={canUseSharedChat() && props.chat.sharedChatOpen}>
        <Suspense fallback={null}>
          <SharedChat
            isOpen={props.chat.sharedChatOpen}
            onClose={props.chat.closeSharedChat}
            projectId={props.chat.projectId}
            userId={props.chat.userId}
            bottomOffsetPx={props.chat.bottomOffsetPx}
          />
        </Suspense>
      </Show>

      <Suspense fallback={null}>
        <EffectsPanel
          isOpen={props.effectsPanel.isOpen}
          showOpenButton={props.effectsPanel.showOpenButton}
          shell={props.effectsPanel.shell}
          clipTab={props.effectsPanel.clipTab}
          selectedFXTarget={props.effectsPanel.selectedFXTarget}
          tracks={props.effectsPanel.tracks}
          onClose={props.effectsPanel.onClose}
          onOpen={props.effectsPanel.onOpen}
          audioEngine={props.effectsPanel.audioEngine}
          projectId={props.effectsPanel.projectId}
          userId={props.effectsPanel.userId}
          canWriteTrackRouting={props.effectsPanel.canWriteTrackRouting}
          grantClipWrite={props.effectsPanel.grantClipWrite}
          playheadSec={props.effectsPanel.playheadSec}
          onSelectClip={props.effectsPanel.onSelectClip}
          insertLocalClip={props.effectsPanel.insertLocalClip}
          onEffectParamsCommitted={props.effectsPanel.onEffectParamsCommitted}
          onLocalSaveFailed={props.effectsPanel.onLocalSaveFailed}
        />
      </Suspense>

      <Show when={props.sampleDetailPanel.isOpen && props.sampleDetailPanel.selectedClip}>
        {(clip) => (
          <Suspense fallback={null}>
            <SampleDetailPanel
              clip={clip()}
              projectBpm={props.sampleDetailPanel.projectBpm}
              audioEngine={props.sampleDetailPanel.audioEngine}
              bpmDetection={props.sampleDetailPanel.bpmDetection}
              ensureClipBuffer={props.sampleDetailPanel.ensureClipBuffer}
              canWriteClip={props.sampleDetailPanel.canWriteClip}
              onWarpChange={props.sampleDetailPanel.onChange}
              onGainChange={props.sampleDetailPanel.onGainChange}
              onMarkerDragStateChange={props.sampleDetailPanel.onMarkerDragStateChange}
              shell={props.sampleDetailPanel.shell}
              onClose={props.sampleDetailPanel.onClose}
            />
          </Suspense>
        )}
      </Show>

      <Show when={props.exportDialog.isOpen}>
        <Suspense fallback={null}>
          <ExportDialog
            isOpen={props.exportDialog.isOpen}
            onClose={props.exportDialog.onClose}
            tracks={props.exportDialog.tracks}
            getTracks={props.exportDialog.getTracks}
            selectedTrackId={props.exportDialog.selectedTrackId}
            bpm={props.exportDialog.bpm}
            masterVolume={props.exportDialog.masterVolume}
            loopEnabled={props.exportDialog.loopEnabled}
            loopStartSec={props.exportDialog.loopStartSec}
            loopEndSec={props.exportDialog.loopEndSec}
            projectId={props.exportDialog.projectId}
            userId={props.exportDialog.userId}
            ensureClipBuffer={props.exportDialog.ensureClipBuffer}
          />
        </Suspense>
      </Show>
      <ExportProgressOverlay />
    </ExportProvider>
  )
}

export default TimelinePanels
