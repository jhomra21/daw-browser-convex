import type { Track } from "@daw-browser/timeline-core/types";

export const trackNumberById = (
  tracks: readonly Pick<Track, "id">[],
): ReadonlyMap<Track["id"], number> =>
  new Map(tracks.map((track, index) => [track.id, index + 1]));
