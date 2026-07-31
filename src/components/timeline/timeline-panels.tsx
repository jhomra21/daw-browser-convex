import { type Component, Show, Suspense, createEffect, lazy } from 'solid-js'
import { Button } from '~/components/ui/button'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { isLocalId, type AutomationEnvelope } from '@daw-browser/shared'
import { ExportProvider } from '~/context/export'
import ExportProgressOverlay from '~/components/export/ExportProgressOverlay'
import EffectsPanel from '~/components/timeline/EffectsPanel'
import SampleDetailPanel from '~/components/timeline/SampleDetailPanel'
import ExportDialog from '~/components/timeline/ExportDialog'
import type { OptimisticGrantWrite } from '~/lib/optimistic-grant-scope'
import type { EffectParamsCommitPayload, EffectType } from '~/lib/undo/types'
import type { BpmDetectionService } from '~/lib/bpm-detection-service'
import type { Clip, ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import type { ExternalProcessor } from '@daw-browser/external-plugins'
import type { TimelineBottomPanelShellControls } from '~/components/timeline/TimelineBottomPanelShell'
import type { TimelineDeviceInsertActions } from '~/components/timeline/timeline-device-insert-actions'
import type { EffectsPanelAudioEffects, EffectsPanelExportSnapshot } from '~/components/timeline/create-effects-panel-controller'
import type { ExportQueue } from '~/lib/export/export-queue'
import type { TimelineExportService } from '~/lib/export/timeline-export-service'

const SharedChat = lazy(() => import('~/components/SharedChat'))

export type TimelinePanelsProps = {
  exportQueue: ExportQueue
  exportService: TimelineExportService
  chat: {
    bottomOffsetPx: number
    sharedChatOpen: boolean
    projectId?: string
    userId?: string
    toggleSharedChat: () => void
    closeSharedChat: () => void
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
    sidechainRoutes: ExternalSidechainRoute[]
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
    onEffectInstanceParamsReplayChange?: (replay: EffectsPanelAudioEffects['replayInstanceParams'] | undefined) => void
    onLocalSaveFailed?: (message: string) => void
    onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void
    onExportSnapshotChange?: (snapshot: EffectsPanelExportSnapshot | undefined) => void
    onEffectChainElementChange?: (element: HTMLElement | undefined) => void
    autoOpenExternalProcessorId?: string
    onExternalProcessorAutoOpenHandled?: (instanceId: string) => void
    onExternalProcessorUpdated?: (processor: ExternalProcessor, previous: ExternalProcessor) => void
    automationEnvelopes?: AutomationEnvelope[]
    evaluatedValuesByTargetKey?: ReadonlyMap<string, number>
    onSelectAutomationParameter?: (targetKey: Track['id'] | 'master', parameterId: string, effectInstanceId?: string) => void
    onManualAutomationOverride?: (targetKey: Track['id'] | 'master', parameterId: string, effectInstanceId?: string) => void
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
    onHide: () => void
  }
  exportDialog: {
    isOpen: boolean
    getTracks: () => Track[]
    selectedTrackIds: readonly string[]
    bpm: number
    masterVolume: number
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    projectId?: string
    userId?: string
    sidechainRoutes: ExternalSidechainRoute[]
    ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
    onClose: () => void
  }
}

const TimelinePanels: Component<TimelinePanelsProps> = (props) => {
  const floatingButtonOffset = () => props.chat.bottomOffsetPx > 0 ? `${props.chat.bottomOffsetPx}px` : '16px'
  const canUseSharedChat = () => Boolean(props.chat.projectId && !isLocalId('project', props.chat.projectId))

  createEffect(() => {
    if (!canUseSharedChat() && props.chat.sharedChatOpen) {
      props.chat.closeSharedChat()
    }
  })

  return (
    <ExportProvider queue={props.exportQueue} service={props.exportService}>
      <Show when={canUseSharedChat()}>
        <Button
          variant="outline"
          size="sm"
          class="fixed left-4 z-40 bg-muted text-foreground hover:bg-secondary"
          style={{ bottom: floatingButtonOffset() }}
          aria-label="Toggle Room Chat"
          onClick={props.chat.toggleSharedChat}
        >
          Room Chat
        </Button>
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

      <EffectsPanel
        isOpen={props.effectsPanel.isOpen}
        showOpenButton={props.effectsPanel.showOpenButton}
        shell={props.effectsPanel.shell}
        clipTab={props.effectsPanel.clipTab}
        selectedFXTarget={props.effectsPanel.selectedFXTarget}
        tracks={props.effectsPanel.tracks}
          sidechainRoutes={props.effectsPanel.sidechainRoutes}
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
        onEffectInstanceParamsReplayChange={props.effectsPanel.onEffectInstanceParamsReplayChange}
        onLocalSaveFailed={props.effectsPanel.onLocalSaveFailed}
        onDeviceInsertActionsChange={props.effectsPanel.onDeviceInsertActionsChange}
        onExportSnapshotChange={props.effectsPanel.onExportSnapshotChange}
        onEffectChainElementChange={props.effectsPanel.onEffectChainElementChange}
        autoOpenExternalProcessorId={props.effectsPanel.autoOpenExternalProcessorId}
        onExternalProcessorAutoOpenHandled={props.effectsPanel.onExternalProcessorAutoOpenHandled}
        onExternalProcessorUpdated={props.effectsPanel.onExternalProcessorUpdated}
        automationEnvelopes={props.effectsPanel.automationEnvelopes}
        evaluatedValuesByTargetKey={props.effectsPanel.evaluatedValuesByTargetKey}
        onSelectAutomationParameter={props.effectsPanel.onSelectAutomationParameter}
        onManualAutomationOverride={props.effectsPanel.onManualAutomationOverride}
      />

      <Show when={props.sampleDetailPanel.isOpen && props.sampleDetailPanel.selectedClip}>
        {(clip) => (
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
            onHide={props.sampleDetailPanel.onHide}
          />
        )}
      </Show>

      <Show when={props.exportDialog.isOpen}>
        <ExportDialog
          isOpen={props.exportDialog.isOpen}
          onClose={props.exportDialog.onClose}
          getTracks={props.exportDialog.getTracks}
          selectedTrackIds={props.exportDialog.selectedTrackIds}
          bpm={props.exportDialog.bpm}
          masterVolume={props.exportDialog.masterVolume}
          loopEnabled={props.exportDialog.loopEnabled}
          loopStartSec={props.exportDialog.loopStartSec}
          loopEndSec={props.exportDialog.loopEndSec}
          projectId={props.exportDialog.projectId}
          userId={props.exportDialog.userId}
          sidechainRoutes={props.exportDialog.sidechainRoutes}
          ensureClipBuffer={props.exportDialog.ensureClipBuffer}
        />
      </Show>
      <Show when={!props.exportDialog.isOpen}>
        <ExportProgressOverlay />
      </Show>
    </ExportProvider>
  )
}

export default TimelinePanels
