import { type Component, For } from 'solid-js'
import type { Track } from '@daw-browser/timeline-core/types'
import { LANE_HEIGHT } from '~/lib/timeline-utils'
import ClipComponent, { type ClipContextMenuActions } from './ClipComponent'
import AutomationLane from './automation-lane'
import type { AutomationEnvelope } from '@daw-browser/shared'
import TimelineContextMenu, { type TimelineContextMenuItem } from './context-menu/timeline-context-menu'

type TrackLaneProps = {
  track: Track
  topPx: number
  automationHeightPx: number
  selectedClipIds: Set<string>
  onClipPointerDown: (trackId: Track['id'], clipId: string, e: PointerEvent) => void
  onClipPointerUp: (trackId: Track['id'], clipId: string, e: PointerEvent) => void
  onClipResizeStart: (trackId: Track['id'], clipId: string, edge: 'left' | 'right', e: PointerEvent) => void
  isDropTarget?: boolean
  onClipDblClick?: (trackId: Track['id'], clipId: string) => void
  clipContextMenu: ClipContextMenuActions
  onRetryMedia: (clipId: string) => void
  onReplaceMedia: (trackId: Track['id'], clipId: string) => void
  onRemoveMissingMedia: (trackId: Track['id'], clipId: string) => void
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
  onAddMidiClip?: (trackId: Track['id']) => void
  onDeleteTrack?: (trackId: Track['id']) => void
  bpm: number
  viewportRedrawVersion: number
  automation: {
    projectId: string
    visible: boolean
    parameterIds: string[]
    laneHeightPx: number
    envelopeForParameter: (parameterId: string) => AutomationEnvelope | undefined
    durationSec: number
    onPreview: (envelope: AutomationEnvelope | undefined) => void
    onCommit: (envelope: AutomationEnvelope | undefined, targetKey: string) => void
    onCancelPreview: (targetKey: string) => void
  }
}

const TrackLane: Component<TrackLaneProps> = (props) => {
  const contextMenuItems = (): TimelineContextMenuItem[] => {
    const items: TimelineContextMenuItem[] = [
      { kind: 'label', label: props.track.name },
    ]
    if (props.track.kind === 'instrument' && props.onAddMidiClip) {
      items.push({
        kind: 'item',
        label: 'Add MIDI clip',
        onSelect: () => props.onAddMidiClip?.(props.track.id),
      })
    }
    if (props.onDeleteTrack) {
      if (items.length > 1) items.push({ kind: 'separator' })
      items.push({
        kind: 'item',
        label: 'Delete track',
        shortcut: '⌫',
        onSelect: () => props.onDeleteTrack?.(props.track.id),
      })
    }
    return items
  }

  const laneContainer = () => (
    <div
      class="absolute left-0 right-0 overflow-hidden bg-neutral-950"
      classList={{ 'bg-green-500/10': props.isDropTarget }}
      style={{ top: `${props.topPx}px`, height: `${LANE_HEIGHT + props.automationHeightPx}px` }}
    >
      <div class="absolute left-0 right-0 h-px bg-neutral-800" style={{ top: `${LANE_HEIGHT - 1}px` }} />
      {props.automation.visible ? (
        <div
          class="absolute inset-x-0 z-30 border-t border-red-500/30 bg-neutral-950/95"
          style={{ top: `${LANE_HEIGHT}px`, height: `${props.automationHeightPx}px` }}
        >
          <For each={props.automation.parameterIds}>
            {(parameterId, index) => (
              <div
                class="absolute inset-x-0 border-b border-red-500/20"
                style={{
                  top: `${index() * props.automation.laneHeightPx}px`,
                  height: `${props.automation.laneHeightPx}px`,
                }}
              >
                <AutomationLane
                  projectId={props.automation.projectId}
                  target={{ kind: 'track', trackId: props.track.id }}
                  parameterId={parameterId}
                  envelope={props.automation.envelopeForParameter(parameterId)}
                  durationSec={props.automation.durationSec}
                  heightPx={props.automation.laneHeightPx}
                  onPreview={props.automation.onPreview}
                  onCommit={props.automation.onCommit}
                  onCancelPreview={props.automation.onCancelPreview}
                />
              </div>
            )}
          </For>
        </div>
      ) : null}
      <For each={props.track.clips}>
        {(clip) => (
          <ClipComponent
            clip={clip}
            trackId={props.track.id}
            isSelected={props.selectedClipIds.has(clip.id)}
            onPointerDown={props.onClipPointerDown}
            onPointerUp={props.onClipPointerUp}
            onResizeStart={props.onClipResizeStart}
            onDblClick={props.onClipDblClick}
            contextMenu={props.clipContextMenu}
            onRetryMedia={props.onRetryMedia}
            onReplaceMedia={props.onReplaceMedia}
            onRemoveMissingMedia={props.onRemoveMissingMedia}
            ensureClipBuffer={props.ensureClipBuffer}
            bpm={props.bpm}
            viewportRedrawVersion={props.viewportRedrawVersion}
          />
        )}
      </For>
    </div>
  )

  return (
    <>
      {props.onAddMidiClip || props.onDeleteTrack ? (
        <TimelineContextMenu items={contextMenuItems}>
          {laneContainer()}
        </TimelineContextMenu>
      ) : laneContainer()}
    </>
  )
}

export default TrackLane
