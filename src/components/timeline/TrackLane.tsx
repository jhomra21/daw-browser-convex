import { createMemo, createSignal, type Accessor, type Component, For, Show } from 'solid-js'
import type { Track } from '@daw-browser/timeline-core/types'
import { useAppPreferences } from '~/context/app-preferences'
import { createClipVisualColors, resolveClipColor } from '~/lib/clip-color'
import { clipRangeOverlap, type TimelineRangeSelection } from '~/lib/timeline-range-selection'
import ClipComponent, { type ClipContextMenuActions } from './ClipComponent'
import AutomationLane from './automation-lane'
import { createAutomationTarget, type AutomationEnvelope, type AutomationParameterSelection } from '@daw-browser/shared'
import TimelineContextMenu, { type TimelineContextMenuItem } from './context-menu/timeline-context-menu'
import type { GroupClipOverviewSegment, TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import type { ClipFades } from '@daw-browser/timeline-core/clip-fades'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import { intersectTimelineRangeWithViewport } from '~/lib/timeline-viewport-geometry'
import { isClipWithinRenderRange } from './clip-render-range'
import { quantizeSecToGrid } from '~/lib/timeline-utils'
import { RECORDING_TARGET_FINISHING, RECORDING_TARGET_LOCKED_BADGE, RECORDING_TARGET_LOCKED_REASON, type RecordingTargetLock } from '~/lib/track-recording-target'

type TrackLaneProps = {
  track: Track
  layout: Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx' | 'clipLaneHeightPx' | 'automationHeightPx'>
  groupClipOverview: GroupClipOverviewSegment[]
  selectedClipIds: Set<string>
  rangeSelection: TimelineRangeSelection | null
  onClipPointerDown: (trackId: Track['id'], clipId: string, e: PointerEvent) => void
  onClipPointerUp: (trackId: Track['id'], clipId: string, e: PointerEvent) => void
  onClipResizeStart: (trackId: Track['id'], clipId: string, edge: 'left' | 'right', e: PointerEvent) => void
  isDropTarget?: Accessor<boolean>
  onClipDblClick?: (trackId: Track['id'], clipId: string) => void
  clipContextMenu: ClipContextMenuActions
  onRetryMedia: (clipId: string) => void
  onReplaceMedia: (trackId: Track['id'], clipId: string) => void
  onRemoveMissingMedia: (trackId: Track['id'], clipId: string) => void
  resolveAudioSource: AudioPcmSourceResolver
  onAddMidiClip?: (trackId: Track['id'], startSec: number) => void
  onDeleteTrack?: (trackId: Track['id']) => void
  recordingTargetLock: RecordingTargetLock
  bpm: number
  pixelsPerSecond: number
  visibleRange: { startSec: number; endSec: number }
  clipVisibleRange: { startSec: number; endSec: number }
  viewportWidthPx: number
  timeToX: (timeSec: number) => number
  clientXToTime: (clientX: number) => number
  gridEnabled: boolean
  gridDenominator: number
  viewportRedrawVersion: number
  devicePixelRatio: number
  waveformVisible?: boolean
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
  const [insertStartSec, setInsertStartSec] = createSignal(0)
  const contextMenuItems = (): TimelineContextMenuItem[] => {
    const items: TimelineContextMenuItem[] = [
      { kind: 'label', label: props.track.name },
    ]
    if (props.track.kind === 'instrument' && props.onAddMidiClip) {
      items.push({
        kind: 'item',
        label: 'Add MIDI clip',
        onSelect: () => props.onAddMidiClip?.(props.track.id, insertStartSec()),
      })
    }
    if (props.onDeleteTrack) {
      if (items.length > 1) items.push({ kind: 'separator' })
      const locked = props.recordingTargetLock.holds(props.track.id)
      if (locked) items.push({ kind: 'label', label: RECORDING_TARGET_LOCKED_REASON })
      items.push({
        kind: 'item',
        label: 'Delete track',
        shortcut: '⌫',
        disabled: locked,
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
      data-timeline-track-lane={props.track.id}
      class="absolute left-0 right-0 overflow-hidden bg-timeline-background"
      classList={{ 'bg-green-500/10': props.isDropTarget?.() }}
      style={{ top: `${props.layout.topPx}px`, height: `${props.layout.heightPx}px` }}
      onContextMenu={(event) => {
        if (
          !(event.target instanceof Element) ||
          event.target.closest('[data-timeline-clip="1"]')
        ) return
        const timeSec = props.clientXToTime(event.clientX)
        setInsertStartSec(
          props.gridEnabled
            ? quantizeSecToGrid(timeSec, props.bpm, props.gridDenominator, 'round')
            : timeSec,
        )
      }}
    >
      <div class="absolute left-0 right-0 h-px bg-timeline-surface-muted" style={{ top: `${props.layout.clipLaneHeightPx - 1}px` }} />
      <Show when={props.recordingTargetLock.targetId() === props.track.id}>
        <span
          title={RECORDING_TARGET_LOCKED_REASON}
          class="pointer-events-none absolute right-2 top-1 z-20 border border-border bg-timeline-background px-1.5 text-[10px] leading-4 text-muted-foreground"
        >
          {RECORDING_TARGET_LOCKED_BADGE}
          <Show when={props.recordingTargetLock.state() === 'finishing'}> · {RECORDING_TARGET_FINISHING}</Show>
        </span>
      </Show>
      {props.automation.visible && props.layout.automationHeightPx > 0 ? (
        <div
          data-timeline-automation-surface="true"
          data-track-id={props.track.id}
          class="absolute inset-x-0 z-30 pointer-events-auto border-t border-automation/30 bg-timeline-background/95"
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
                  target={createAutomationTarget({ kind: 'track', trackId: props.track.id }, selection.effectInstanceId)}
                  parameterId={selection.parameterId}
                  envelope={props.automation.envelopeForSelection(selection)}
                  durationSec={props.automation.durationSec}
                  bpm={props.bpm}
                  pixelsPerSecond={props.pixelsPerSecond}
                  visibleStartSec={props.visibleRange.startSec}
                  viewportWidthPx={(props.visibleRange.endSec - props.visibleRange.startSec) * props.pixelsPerSecond}
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
          <Show when={segment.endSec >= props.clipVisibleRange.startSec && segment.startSec <= props.clipVisibleRange.endSec}>
            <Show when={intersectTimelineRangeWithViewport({
              range: segment,
              visibleStartSec: props.visibleRange.startSec,
              viewportWidthPx: props.viewportWidthPx,
              pixelsPerSecond: props.pixelsPerSecond,
            })}>
              {(projection) => (
                <div
                  class="absolute top-1 bottom-1 rounded-sm border"
                  style={{
                    left: `${projection().leftPx}px`,
                    width: `${projection().widthPx}px`,
                    ...segmentVisualColors(segment.color),
                  }}
                />
              )}
            </Show>
            </Show>
          )}
        </For>
      ) : (
        <For each={props.track.clips.filter((clip) => isClipWithinRenderRange(clip, props.clipVisibleRange))}>
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
              resolveAudioSource={props.resolveAudioSource}
              bpm={props.bpm}
              pixelsPerSecond={props.pixelsPerSecond}
              visibleRange={props.visibleRange}
              timeToX={props.timeToX}
              viewportRedrawVersion={props.viewportRedrawVersion}
              devicePixelRatio={props.devicePixelRatio}
              waveformVisible={props.waveformVisible}
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
