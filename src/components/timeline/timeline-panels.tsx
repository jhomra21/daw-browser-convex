import { type Component, Show, Suspense, createEffect, lazy } from 'solid-js'
import { Button } from '~/components/ui/button'
import type { AudioEngine, SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import { isLocalId, type AutomationEnvelope, type TrackInstrumentParams } from '@daw-browser/shared'
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
import type { TimelinePlaybackRebuildIntent } from '~/hooks/useTimelinePlayback'
import type { EffectsPanelAudioEffects, EffectsPanelExportSnapshot } from '~/components/timeline/create-effects-panel-controller'
import type { ExportQueue } from '~/lib/export/export-queue'
import type { TimelineExportService } from '~/lib/export/timeline-export-service'
import type { createDrumRackBufferSync } from '~/lib/drum-rack-buffer-sync'
import type { createSamplerBufferSync } from '~/lib/sampler-buffer-sync'

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
    samplerBufferSync: ReturnType<typeof createSamplerBufferSync>
    drumRackBufferSync: ReturnType<typeof createDrumRackBufferSync>
    spectrumProvider?: (targetId: string, listener: (frame: SpectrumFrame | null) => void) => () => void
    canWriteTrackRouting: (trackId: Track['id']) => boolean
    grantClipWrite: OptimisticGrantWrite
    onSelectClip: (trackId: Track['id'], clipId: string, startSec: number) => void
    insertLocalClip: (trackId: Track['id'], clip: Clip) => void
    onClose: () => void
    onOpen: () => void
    onEffectParamsCommitted: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void
    onStructuralPlaybackChange?: (targetId: Track['id'], next: TrackInstrumentParams) => void
    usesLegacyAudioEngine?: () => boolean
    projectGeneration?: () => number
    onEffectParamsPreview?: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => void
    onEffectParamsFlush?: (payload: EffectParamsCommitPayload<"eq" | "master-eq">) => void | Promise<void>
    onPreviewNote?: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void
    onEffectInstanceParamsReplayChange?: (replay: EffectsPanelAudioEffects['replayInstanceParams'] | undefined) => void
    onLocalSaveFailed?: (message: string) => void
    onDeviceInsertActionsChange?: (actions: TimelineDeviceInsertActions) => void
    onExportSnapshotChange?: (snapshot: EffectsPanelExportSnapshot | undefined) => void
    onEffectChainElementChange?: (element: HTMLElement | undefined) => void
    autoOpenExternalProcessorId?: string
    onExternalProcessorAutoOpenHandled?: (instanceId: string) => void
    onExternalProcessorUpdated?: (
      processor: ExternalProcessor,
      previous: ExternalProcessor,
      intent?: TimelinePlaybackRebuildIntent,
    ) => void
    captureStructuralPlaybackIntent?: () => TimelinePlaybackRebuildIntent
    onMixedReorderCommitted?: (intent?: TimelinePlaybackRebuildIntent) => void
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

type TimelinePanelsContainerProps = {
  panels: TimelinePanelsProps
}

const TimelinePanels: Component<TimelinePanelsContainerProps> = (props) => {
  const panels = () => props.panels
  const floatingButtonOffset = () => panels().chat.bottomOffsetPx > 0 ? `${panels().chat.bottomOffsetPx}px` : '16px'
  const canUseSharedChat = () => {
    const projectId = panels().chat.projectId
    return Boolean(projectId && !isLocalId('project', projectId))
  }

  createEffect(() => {
    if (!canUseSharedChat() && panels().chat.sharedChatOpen) {
      panels().chat.closeSharedChat()
    }
  })

  return (
    <ExportProvider queue={panels().exportQueue} service={panels().exportService}>
      <Show when={canUseSharedChat()}>
        <Button
          variant="outline"
          size="sm"
          class="fixed left-4 z-40 bg-muted text-foreground hover:bg-secondary"
          style={{ bottom: floatingButtonOffset() }}
          aria-label="Toggle Room Chat"
          onClick={panels().chat.toggleSharedChat}
        >
          Room Chat
        </Button>
      </Show>

      <Show when={canUseSharedChat() && panels().chat.sharedChatOpen}>
        <Suspense fallback={null}>
          <SharedChat
            isOpen={panels().chat.sharedChatOpen}
            onClose={panels().chat.closeSharedChat}
            projectId={panels().chat.projectId}
            userId={panels().chat.userId}
            bottomOffsetPx={panels().chat.bottomOffsetPx}
          />
        </Suspense>
      </Show>

      <EffectsPanel
        isOpen={panels().effectsPanel.isOpen}
        showOpenButton={panels().effectsPanel.showOpenButton}
        shell={panels().effectsPanel.shell}
        clipTab={panels().effectsPanel.clipTab}
        selectedFXTarget={panels().effectsPanel.selectedFXTarget}
        tracks={panels().effectsPanel.tracks}
        sidechainRoutes={panels().effectsPanel.sidechainRoutes}
        onClose={panels().effectsPanel.onClose}
        onOpen={panels().effectsPanel.onOpen}
        audioEngine={panels().effectsPanel.audioEngine}
        samplerBufferSync={panels().effectsPanel.samplerBufferSync}
        drumRackBufferSync={panels().effectsPanel.drumRackBufferSync}
        spectrumProvider={panels().effectsPanel.spectrumProvider}
        projectId={panels().effectsPanel.projectId}
        userId={panels().effectsPanel.userId}
        canWriteTrackRouting={panels().effectsPanel.canWriteTrackRouting}
        grantClipWrite={panels().effectsPanel.grantClipWrite}
        playheadSec={panels().effectsPanel.playheadSec}
        onSelectClip={panels().effectsPanel.onSelectClip}
        insertLocalClip={panels().effectsPanel.insertLocalClip}
        onEffectParamsCommitted={panels().effectsPanel.onEffectParamsCommitted}
        onStructuralPlaybackChange={panels().effectsPanel.onStructuralPlaybackChange}
        usesLegacyAudioEngine={panels().effectsPanel.usesLegacyAudioEngine}
        projectGeneration={panels().effectsPanel.projectGeneration}
        onEffectParamsPreview={panels().effectsPanel.onEffectParamsPreview}
        onEffectParamsFlush={panels().effectsPanel.onEffectParamsFlush}
        onPreviewNote={panels().effectsPanel.onPreviewNote}
        onEffectInstanceParamsReplayChange={panels().effectsPanel.onEffectInstanceParamsReplayChange}
        onLocalSaveFailed={panels().effectsPanel.onLocalSaveFailed}
        onDeviceInsertActionsChange={panels().effectsPanel.onDeviceInsertActionsChange}
        onExportSnapshotChange={panels().effectsPanel.onExportSnapshotChange}
        onEffectChainElementChange={panels().effectsPanel.onEffectChainElementChange}
        autoOpenExternalProcessorId={panels().effectsPanel.autoOpenExternalProcessorId}
        onExternalProcessorAutoOpenHandled={panels().effectsPanel.onExternalProcessorAutoOpenHandled}
        onExternalProcessorUpdated={panels().effectsPanel.onExternalProcessorUpdated}
        captureStructuralPlaybackIntent={panels().effectsPanel.captureStructuralPlaybackIntent}
        onMixedReorderCommitted={panels().effectsPanel.onMixedReorderCommitted}
        automationEnvelopes={panels().effectsPanel.automationEnvelopes}
        evaluatedValuesByTargetKey={panels().effectsPanel.evaluatedValuesByTargetKey}
        onSelectAutomationParameter={panels().effectsPanel.onSelectAutomationParameter}
        onManualAutomationOverride={panels().effectsPanel.onManualAutomationOverride}
      />

      <Show when={panels().sampleDetailPanel.isOpen && panels().sampleDetailPanel.selectedClip}>
        {(clip) => (
          <SampleDetailPanel
            clip={clip()}
            projectBpm={panels().sampleDetailPanel.projectBpm}
            audioEngine={panels().sampleDetailPanel.audioEngine}
            bpmDetection={panels().sampleDetailPanel.bpmDetection}
            ensureClipBuffer={panels().sampleDetailPanel.ensureClipBuffer}
            canWriteClip={panels().sampleDetailPanel.canWriteClip}
            onWarpChange={panels().sampleDetailPanel.onChange}
            onGainChange={panels().sampleDetailPanel.onGainChange}
            onMarkerDragStateChange={panels().sampleDetailPanel.onMarkerDragStateChange}
            shell={panels().sampleDetailPanel.shell}
            onClose={panels().sampleDetailPanel.onClose}
            onHide={panels().sampleDetailPanel.onHide}
          />
        )}
      </Show>

      <Show when={panels().exportDialog.isOpen}>
        <ExportDialog
          isOpen={panels().exportDialog.isOpen}
          onClose={panels().exportDialog.onClose}
          getTracks={panels().exportDialog.getTracks}
          selectedTrackIds={panels().exportDialog.selectedTrackIds}
          bpm={panels().exportDialog.bpm}
          masterVolume={panels().exportDialog.masterVolume}
          loopEnabled={panels().exportDialog.loopEnabled}
          loopStartSec={panels().exportDialog.loopStartSec}
          loopEndSec={panels().exportDialog.loopEndSec}
          projectId={panels().exportDialog.projectId}
          userId={panels().exportDialog.userId}
          sidechainRoutes={panels().exportDialog.sidechainRoutes}
          ensureClipBuffer={panels().exportDialog.ensureClipBuffer}
        />
      </Show>
      <Show when={!panels().exportDialog.isOpen}>
        <ExportProgressOverlay />
      </Show>
    </ExportProvider>
  )
}

export default TimelinePanels
