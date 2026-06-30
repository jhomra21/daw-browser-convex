import { type Component, For } from 'solid-js'
import { cn } from '~/lib/utils'
import type { Track } from '@daw-browser/timeline-core/types'
import { LANE_HEIGHT } from '~/lib/timeline-utils'
import ClipComponent from './ClipComponent'
import AutomationLane from './automation-lane'
import type { AutomationEnvelope } from '@daw-browser/shared'

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
  onRetryMedia?: (clipId: string) => void
  onReplaceMedia?: (trackId: Track['id'], clipId: string) => void
  onRemoveMissingMedia?: (trackId: Track['id'], clipId: string) => void
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
  bpm: number
  viewportRedrawVersion: number
  automation?: {
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
  const automation = () => props.automation
  return (
    <div
      class={cn('absolute left-0 right-0 overflow-hidden bg-neutral-950', props.isDropTarget && 'bg-green-500/10')}
      style={{ top: `${props.topPx}px`, height: `${LANE_HEIGHT + props.automationHeightPx}px` }}
    >
      <div class="absolute left-0 right-0 h-[1.5px] bg-neutral-800" style={{ top: `${LANE_HEIGHT - 1}px` }} />
      {automation()?.visible ? (
        <div
          class="absolute inset-x-0 z-30 border-t border-red-500/30 bg-neutral-950/95"
          style={{ top: `${LANE_HEIGHT}px`, height: `${props.automationHeightPx}px` }}
        >
          <For each={automation()?.parameterIds ?? []}>
            {(parameterId, index) => (
              <div
                class="absolute inset-x-0 border-b border-red-500/20"
                style={{
                  top: `${index() * (automation()?.laneHeightPx ?? 0)}px`,
                  height: `${automation()?.laneHeightPx ?? 0}px`,
                }}
              >
                <AutomationLane
                  projectId={automation()?.projectId ?? ''}
                  target={{ kind: 'track', trackId: props.track.id }}
                  parameterId={parameterId}
                  envelope={automation()?.envelopeForParameter(parameterId)}
                  durationSec={automation()?.durationSec ?? 0}
                  heightPx={automation()?.laneHeightPx ?? 0}
                  onPreview={(envelope) => automation()?.onPreview(envelope)}
                  onCommit={(envelope, targetKey) => automation()?.onCommit(envelope, targetKey)}
                  onCancelPreview={(targetKey) => automation()?.onCancelPreview(targetKey)}
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
}

export default TrackLane
