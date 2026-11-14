import type { Accessor } from "solid-js";
import type { Track } from "@daw-browser/timeline-core/types";
import type { useTimelineHistory } from "~/hooks/useTimelineHistory";
import { buildEffectParamsHistoryEntry } from "~/lib/undo/builders";
import type { EffectParamsCommitOptions, EffectParamsCommitPayload } from "~/lib/undo/types";

export default function createTimelineEffectCommit(input: {
  projectId: Accessor<string | undefined>;
  tracks: Accessor<Track[]>;
  pushHistory: ReturnType<typeof useTimelineHistory>["pushHistory"];
}) {
  return {
    committed(payload: EffectParamsCommitPayload, committedProjectId?: string, options?: EffectParamsCommitOptions) {
      const rid = committedProjectId ?? input.projectId();
      if (!rid) return;
      if (rid !== input.projectId()) return;
      const entry = buildEffectParamsHistoryEntry({ projectId: rid, tracks: input.tracks(), payload });
      if (options?.mergeHistory === false) {
        input.pushHistory(entry);
        return;
      }
      input.pushHistory(entry, `fx:${payload.effect}:${payload.targetId}:${payload.instanceId ?? ""}`, 600);
    },
  };
}
