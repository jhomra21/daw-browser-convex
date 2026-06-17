import { createMemo, type Accessor } from "solid-js";
import type { Track } from "@daw-browser/timeline-core/types";

type UseEffectsPanelTargetOptions = {
  selectedFXTarget: Accessor<Track["id"] | "master">;
  tracks: Accessor<Track[]>;
  canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
};

type UseEffectsPanelTargetReturn = {
  currentTargetId: Accessor<Track["id"] | "master">;
  currentTrack: Accessor<Track | undefined>;
  currentTrackId: Accessor<Track["id"] | undefined>;
  isInstrumentTrack: Accessor<boolean>;
  canWriteCurrentTrackRouting: Accessor<boolean>;
  resolveTrackByTargetId: (targetId: string) => Track | undefined;
};

export function useEffectsPanelTarget(
  options: UseEffectsPanelTargetOptions,
): UseEffectsPanelTargetReturn {
  const currentTargetId = createMemo(() => options.selectedFXTarget());
  const tracksByTargetId = createMemo(() => new Map<string, Track>(options.tracks().map((track) => [track.id, track])));

  function resolveTrackByTargetId(targetId: string): Track | undefined {
    if (!targetId || targetId === "master") return undefined;
    return tracksByTargetId().get(targetId);
  }

  const currentTrack = createMemo(() => resolveTrackByTargetId(currentTargetId()));
  const currentTrackId = createMemo(() => currentTrack()?.id);
  const isInstrumentTrack = createMemo(() => currentTrack()?.kind === "instrument");
  const canWriteCurrentTrackRouting = createMemo(() => {
    const track = currentTrack();
    if (!track) return false;
    return options.canWriteTrackRouting ? options.canWriteTrackRouting(track.id) : true;
  });

  return {
    currentTargetId,
    currentTrack,
    currentTrackId,
    isInstrumentTrack,
    canWriteCurrentTrackRouting,
    resolveTrackByTargetId,
  };
}
