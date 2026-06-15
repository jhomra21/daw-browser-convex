import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import type { AudioWarp, Clip } from "@daw-browser/timeline-core/types";
import { createTimelineClipWriteAdapter } from "~/lib/timeline-clip-write-adapter";
import { buildClipTimingHistoryEntry } from "~/lib/undo/builders";
import type { TimelineSelectionController } from "~/hooks/useTimelineSelectionState";
import type { TimelineTrackIndex } from "@daw-browser/timeline-core/track-index";
import type { HistoryEntry } from "~/lib/undo/types";

type BottomPanelMode = "effects" | "sample-detail";

type AudioWarpController = {
  changeAudioWarp: (clip: Clip, audioWarp: AudioWarp) => Promise<boolean> | boolean | void;
};

type Options = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  mode: Accessor<BottomPanelMode>;
  setMode: Setter<BottomPanelMode>;
  setOpen: Setter<boolean>;
  trackLookup: Accessor<TimelineTrackIndex<AudioBuffer>>;
  selection: TimelineSelectionController;
  canWriteClip: (clipId: string) => boolean;
  projection: {
    commitClipGain: (clipId: string, gain: number) => void;
  };
  audioWarpController: AudioWarpController;
  rescheduleChangedClips: (clipIds: string[]) => void;
  pushHistory: (entry: HistoryEntry, key?: string, debounceMs?: number) => void;
};

export const isTimelineSampleDetailClip = (clip: Clip<AudioBuffer> | undefined) => {
  if (!clip || clip.midi) return false;
  return Boolean(
    clip.sampleUrl ||
      clip.sourceAssetKey ||
      clip.sourceKind ||
      clip.buffer,
  );
};

export function useTimelineSampleDetailController(options: Options) {
  const [markerDragging, setMarkerDragging] = createSignal(false);
  const selectedClip = createMemo(() => {
    const selected = options.selection.selectedClip();
    if (!selected) return undefined;
    const match = options.trackLookup().clipEntryById.get(selected.clipId);
    if (!match || match.trackId !== selected.trackId) return undefined;
    return isTimelineSampleDetailClip(match.clip) ? match.clip : undefined;
  });

  const close = () => {
    options.setMode("effects");
    options.setOpen(true);
  };

  createEffect(() => {
    if (options.mode() !== "sample-detail") return;
    if (selectedClip()) return;
    close();
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || options.mode() !== "sample-detail") return;
      if (markerDragging()) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown, { capture: true }));
  });

  const changeGain = async (clip: Clip, gain: number) => {
    const project = options.projectId();
    if (!project || !options.canWriteClip(clip.id)) return false;
    const normalizedGain = Math.min(2, Math.max(0, gain));
    if (normalizedGain === (clip.gain ?? 1)) return true;
    const applied = await createTimelineClipWriteAdapter({
      projectId: project,
      userId: options.userId(),
    }).setGain(clip.id, normalizedGain);
    if (!applied) return false;
    options.projection.commitClipGain(clip.id, normalizedGain);
    options.rescheduleChangedClips([clip.id]);
    options.pushHistory(buildClipTimingHistoryEntry({
      projectId: project,
      clip,
      from: { startSec: clip.startSec, duration: clip.duration, leftPadSec: clip.leftPadSec, bufferOffsetSec: clip.bufferOffsetSec, midiOffsetBeats: clip.midiOffsetBeats, gain: clip.gain ?? 1 },
      to: { startSec: clip.startSec, duration: clip.duration, leftPadSec: clip.leftPadSec, bufferOffsetSec: clip.bufferOffsetSec, midiOffsetBeats: clip.midiOffsetBeats, gain: normalizedGain },
    }));
    return true;
  };

  return {
    selectedClip,
    changeWarp: (clip: Clip, audioWarp: AudioWarp) => options.audioWarpController.changeAudioWarp(clip, audioWarp),
    changeGain,
    markerDragging,
    setMarkerDragging,
    close,
  };
}
