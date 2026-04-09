import { createMemo, type Accessor } from "solid-js";
import { getTrackChannelRole } from "~/lib/track-routing";
import type { Track, TrackSend } from "~/types/timeline";

type UseEffectsPanelTargetOptions = {
  selectedFXTarget: Accessor<string>;
  tracks: Accessor<Track[]>;
  canWriteTrackRouting?: (trackId: Track["id"]) => boolean;
};

type UseEffectsPanelTargetReturn = {
  currentTargetId: Accessor<string>;
  targetName: Accessor<string>;
  currentTrack: Accessor<Track | undefined>;
  currentTrackId: Accessor<Track["id"] | undefined>;
  isInstrumentTrack: Accessor<boolean>;
  isGroupTrack: Accessor<boolean>;
  canEditSends: Accessor<boolean>;
  canWriteCurrentTrackRouting: Accessor<boolean>;
  returnTracks: Accessor<Track[]>;
  groupTracks: Accessor<Track[]>;
  currentTrackSends: Accessor<TrackSend[]>;
  currentTrackOutputTargetId: Accessor<string>;
  currentSendAmountByTarget: Accessor<Map<Track["id"], number>>;
  resolveTrackByTargetId: (targetId: string) => Track | undefined;
};

export function useEffectsPanelTarget(
  options: UseEffectsPanelTargetOptions,
): UseEffectsPanelTargetReturn {
  const currentTargetId = createMemo(() => options.selectedFXTarget() || "master");
  const tracksByTargetId = createMemo(() => new Map<string, Track>(options.tracks().map((track) => [track.id, track])));

  function resolveTrackByTargetId(targetId: string): Track | undefined {
    if (!targetId || targetId === "master") return undefined;
    return tracksByTargetId().get(targetId);
  }

  const currentTrack = createMemo(() => resolveTrackByTargetId(currentTargetId()));
  const currentTrackId = createMemo(() => currentTrack()?.id);
  const currentTrackRole = createMemo(() => getTrackChannelRole(currentTrack()));
  const targetName = createMemo(() => currentTargetId() === "master" ? "Master" : currentTrack()?.name ?? "Track");
  const isInstrumentTrack = createMemo(() => currentTrack()?.kind === "instrument");
  const isGroupTrack = createMemo(() => currentTrackRole() === "group");
  const canEditSends = createMemo(() => currentTrackRole() === "track");
  const canWriteCurrentTrackRouting = createMemo(() => {
    const track = currentTrack();
    if (!track) return false;
    return options.canWriteTrackRouting ? options.canWriteTrackRouting(track.id) : true;
  });
  const returnTracks = createMemo(() =>
    options.tracks().filter((track) => getTrackChannelRole(track) === "return" && track.id !== currentTargetId()),
  );
  const groupTracks = createMemo(() =>
    options.tracks().filter((track) => getTrackChannelRole(track) === "group" && track.id !== currentTargetId()),
  );
  const currentTrackSends = createMemo(() => currentTrack()?.sends ?? []);
  const currentTrackOutputTargetId = createMemo(() => currentTrack()?.outputTargetId ?? "");
  const currentSendAmountByTarget = createMemo(() => {
    const next = new Map<Track["id"], number>();
    for (const send of currentTrackSends()) {
      next.set(send.targetId, send.amount);
    }
    return next;
  });

  return {
    currentTargetId,
    targetName,
    currentTrack,
    currentTrackId,
    isInstrumentTrack,
    isGroupTrack,
    canEditSends,
    canWriteCurrentTrackRouting,
    returnTracks,
    groupTracks,
    currentTrackSends,
    currentTrackOutputTargetId,
    currentSendAmountByTarget,
    resolveTrackByTargetId,
  };
}
