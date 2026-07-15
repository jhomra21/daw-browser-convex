import { createMemo, type Component, For } from 'solid-js'
import type { Track } from '@daw-browser/timeline-core/types'
import { useAppPreferences } from '~/context/app-preferences'
import { createClipVisualColors, resolveClipColor } from '~/lib/clip-color'
import { PPS } from '~/lib/timeline-utils'
import { clipRangeOverlap, type TimelineRangeSelection } from '~/lib/timeline-range-selection'
import ClipComponent, { type ClipContextMenuActions } from './ClipComponent'
import AutomationLane from './automation-lane'
import type { AutomationEnvelope, AutomationParameterSelection } from '@daw-browser/shared'
import TimelineContextMenu, { type TimelineContextMenuItem } from './context-menu/timeline-context-menu'
import type { GroupClipOverviewSegment, TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import type { ClipFades } from '@daw-browser/timeline-core/clip-fades'

type TrackLaneProps = {
  track: Track
  layout: Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx' | 'clipLaneHeightPx' | 'automationHeightPx'>
  groupClipOverview: GroupClipOverviewSegment[]
  selectedClipIds: Set<string>
  rangeSelection: TimelineRangeSelection | null
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
  canEditClipFades: (clipId: string) => boolean
  onCommitClipFades: (clipId: string, fades: ClipFades, baseline: ClipFades) => void
  automation: {
    projectId: string
    visible: boolean
    selections: AutomationParameterSelection[]
    laneHeightPx: number
    envelopeForSelection: (selection: AutomationParameterSelection) => AutomationEnvelope | undefined
    durationSec: number
    onPreview: (envelope: AutomationEnvelope | undefined) => void
    onCommit: (envelope: AutomationEnvelope | undefined, targetKey: string) => void
    onCancelPreview: (targetKey: string) => void
  }
}

const TrackLane: Component<TrackLaneProps> = (props) => {
  const appPreferences = useAppPreferences()
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

  const rangeForLane = createMemo(() => {
    const range = props.rangeSelection
    if (!range?.trackIds.includes(props.track.id)) return null
    return range
  })
  const collapsedSegments = createMemo(() => {
    if (props.track.channelRole === 'group') return props.groupClipOverview
    return props.track.clips.map((clip) => ({
      startSec: clip.startSec,
      endSec: clip.startSec + clip.duration,
      color: clip.color,
    }))
  })
  const segmentVisualColors = (color: string) => createClipVisualColors(
    resolveClipColor(color, appPreferences.appearance.themeTokens()),
    false,
    false,
  )

  const laneContainer = () => (
    <div
      class="absolute left-0 right-0 overflow-hidden bg-timeline-background"
      classList={{ 'bg-green-500/10': props.isDropTarget }}
      style={{ top: `${props.layout.topPx}px`, height: `${props.layout.heightPx}px` }}
    >
      <div class="absolute left-0 right-0 h-px bg-timeline-surface-muted" style={{ top: `${props.layout.clipLaneHeightPx - 1}px` }} />
      {props.automation.visible && props.layout.automationHeightPx > 0 ? (
        <div
          class="absolute inset-x-0 z-30 border-t border-automation/30 bg-timeline-background/95"
          style={{ top: `${props.layout.clipLaneHeightPx}px`, height: `${props.layout.automationHeightPx}px` }}
        >
          <For each={props.automation.selections}>
            {(selection, index) => (
              <div
                class="absolute inset-x-0 border-b border-automation/20"
                style={{
                  top: `${index() * props.automation.laneHeightPx}px`,
                  height: `${props.automation.laneHeightPx}px`,
                }}
              >
                <AutomationLane
                  projectId={props.automation.projectId}
                  target={{ kind: 'track', trackId: props.track.id, effectInstanceId: selection.effectInstanceId }}
                  parameterId={selection.parameterId}
                  envelope={props.automation.envelopeForSelection(selection)}
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
      {props.track.collapsed ? (
        <For each={collapsedSegments()}>
          {(segment) => (
            <div
              class="absolute top-1 bottom-1 rounded-sm border"
              style={{
                left: `${segment.startSec * PPS}px`,
                width: `${Math.max(2, (segment.endSec - segment.startSec) * PPS)}px`,
                ...segmentVisualColors(segment.color),
              }}
            />
          )}
        </For>
      ) : (
        <For each={props.track.clips}>
          {(clip) => (
            <ClipComponent
              clip={clip}
              trackId={props.track.id}
              isSelected={props.selectedClipIds.has(clip.id)}
              rangeOverlap={clipRangeOverlap(clip, rangeForLane())}
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
              canEditFades={() => props.canEditClipFades(clip.id)}
              onCommitFades={props.onCommitClipFades}
            />
          )}
        </For>
      )}
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
