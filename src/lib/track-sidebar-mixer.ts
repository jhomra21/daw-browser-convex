import type { Track } from "@daw-browser/timeline-core/types";

export const trackNumberById = (
  tracks: readonly Pick<Track, "id">[],
): ReadonlyMap<Track["id"], number> =>
  new Map(tracks.map((track, index) => [track.id, index + 1]));

export const formatTrackVolumeDb = (volume: number): string => {
  const normalizedVolume = Number.isFinite(volume)
    ? Math.max(0, Math.min(1, volume))
    : 0;
  if (normalizedVolume === 0) return "-inf";
  return (20 * Math.log10(normalizedVolume)).toFixed(1);
};
