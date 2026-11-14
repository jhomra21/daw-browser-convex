import type { Track } from "@daw-browser/timeline-core/types";
import { parseSharedTimelineOperation, type SharedTimelineOperation } from "@daw-browser/shared";
import { createComponent, createEffect, createRoot, untrack } from "solid-js";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { convexApi, convexClient, useConvexQuery } from "~/lib/convex";
import type { FunctionReturnType } from "convex/server";
import type { Deps } from "~/lib/undo/exec";
import type { HistoryEntry } from "~/lib/undo/types";
import { createLocalControlService } from "~/lib/local-control/local-control-service";
import { controlCapabilitiesV2, type ControlActionV1 } from "@daw-browser/control";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { z } from "zod";
import { structuredCloneJsonValue } from "~/lib/structured-clone-json";

export const b5CloudDatabase = () => convexTest(schema, {
  "./_generated/api.ts": () => import("../../convex/_generated/api"),
  "./control.ts": () => import("../../convex/control"),
  "./projects.ts": () => import("../../convex/projects"),
  "./assets.ts": () => import("../../convex/assets"),
  "./resumableAssetUploads.ts": () => import("../../convex/resumableAssetUploads"),
  "./r2Deletes.ts": () => import("../../convex/r2Deletes"),
});

export const b5AgentCommit = async (
  local: boolean, projectId: string, db: ReturnType<typeof b5CloudDatabase>, action: ControlActionV1,
) => {
  const key = `b5-agent-${crypto.randomUUID()}`;
  if (local) {
    const service = createLocalControlService({ actor: { subject: "b5-agent" } });
    const capabilities = service.capabilitiesV2();
    if (capabilities.executionTarget !== "local-project") throw new Error("Wrong B5 local capabilities");
    const before = await service.snapshotV2({ projectId });
    const request = { version: "v1", projectId, expectedRevision: before.project.revision, actions: [z.json().parse(structuredCloneJsonValue(action))] };
    const preview = await service.preview(request);
    if (!preview.applied) throw new Error(`B5 local preview rejected: ${JSON.stringify(preview)}`);
    const approval = preview.approval?.required ? await service.requestApproval(request) : undefined;
    const commitRequest = { ...request, idempotencyKey: key };
    const result = await service.commit(approval ? { ...commitRequest, approvalToken: approval.approvalToken } : commitRequest);
    if (!result.applied) throw new Error(`B5 local commit rejected: ${JSON.stringify(result)}`);
    const after = await service.snapshotV2({ projectId });
    if (after.project.revision <= before.project.revision) throw new Error("B5 local commit did not advance revision");
    return after;
  }
  if (controlCapabilitiesV2.executionTarget !== "cloud-project") throw new Error("Wrong B5 cloud capabilities");
  const actor = db.withIdentity({ subject: "b5-agent" });
  const before = await actor.query(convexApi.control.snapshotV2, { projectId });
  const request = { version: "v1", projectId, expectedRevision: before.project.revision, actions: [action] };
  const preview = await actor.query(convexApi.control.previewV1, { request });
  if (!preview.applied) throw new Error(`B5 cloud preview rejected: ${JSON.stringify(preview)}`);
  const approval = preview.approval?.required ? await actor.mutation(convexApi.control.requestApprovalV1, { request }) : undefined;
  const result = await actor.mutation(convexApi.control.commitV1, {
    request: { ...request, idempotencyKey: key, approvalToken: approval?.approvalToken },
  });
  if (!result.applied) throw new Error(`B5 cloud commit rejected: ${JSON.stringify(result)}`);
  const after = await actor.query(convexApi.control.snapshotV2, { projectId });
  if (after.project.revision <= before.project.revision) throw new Error("B5 cloud commit did not advance revision");
  return after;
};

// These fixtures execute real history persistence and row observation; unrelated
// timeline actions are deliberately inert. No instrument owner.replay is wired.
export const b5HistoryDeps = (projectId: string, track: Track, entry: HistoryEntry): Deps => ({
  projectId, userId: "b5-history-user", convexClient, convexApi,
  getTracks: () => [track], getHistoryEntries: () => [entry],
  persistLocalMix: () => {}, grantTrackWrite: () => {}, grantClipWrite: () => {},
  actions: {
    insertLocalTrack: () => {}, removeLocalTrack: () => {}, insertLocalClip: () => {},
    replaceLocalClip: () => {}, removeLocalClips: () => {}, commitClipMoves: () => {},
    commitClipTiming: () => {}, commitClipAudioWarp: () => {}, commitClipFades: () => {},
    commitClipMidi: () => {}, rescheduleChangedClips: () => {}, cancelTrackVolumeWrite: () => {},
    cancelTrackRoutingWrite: () => {}, cancelTrackMixWrite: () => {}, applyTrackVolume: () => {},
    applyTrackMixState: () => {}, applyTrackRouting: () => {}, applyTrackPatch: () => {},
    applyAutomationEnvelope: () => {},
  },
});

// The modeled HTTP boundary persists into the fixture's real row store. It is
// history transport coverage, not a claim about server authorization or agents.
export const b5HistoryTransport = (apply: (operation: SharedTimelineOperation) => Promise<void>) => {
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const operation = parseSharedTimelineOperation(JSON.parse(init?.body?.toString() ?? "null"));
    if (!operation) throw new Error("Invalid B5 history operation");
    await apply(operation);
    return Response.json({ status: "applied", effectId: "b5-history-row", revision: 2 });
  }, { preconnect: previous.preconnect });
  return () => { globalThis.fetch = previous; };
};

// Fixed effects-query transport only. The real useConvexQuery subscription
// callback updates TanStack's cache; no query injection is called collaboration.
export const b5EffectsSubscription = <Row>(read: () => Promise<Row[]>) => {
  const queryDescriptor = Object.getOwnPropertyDescriptor(convexClient, "query");
  const updateDescriptor = Object.getOwnPropertyDescriptor(convexClient, "onUpdate");
  const listeners = new Set<(rows: Row[]) => void>();
  Object.defineProperty(convexClient, "query", { configurable: true, value: read });
  Object.defineProperty(convexClient, "onUpdate", { configurable: true,
    value: (_query: typeof convexApi.effects.listByRoom, _args: { projectId: string }, listener: (rows: Row[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    } });
  return {
    publish: async () => {
      const rows = await read();
      if (listeners.size !== 1) throw new Error(`Expected one effects subscription, got ${listeners.size}`);
      for (const listener of listeners) listener(rows);
    },
    close: () => {
      if (queryDescriptor) Object.defineProperty(convexClient, "query", queryDescriptor);
      else Reflect.deleteProperty(convexClient, "query");
      if (updateDescriptor) Object.defineProperty(convexClient, "onUpdate", updateDescriptor);
      else Reflect.deleteProperty(convexClient, "onUpdate");
      if (listeners.size !== 0) throw new Error("B5 effects subscription was not disposed");
    },
  };
};

export const b5SubscribeEffects = (
  projectId: string,
  read: () => Promise<FunctionReturnType<typeof convexApi.effects.listByRoom>>,
  publishRows: (rows: FunctionReturnType<typeof convexApi.effects.listByRoom>) => void,
) => {
  const transport = b5EffectsSubscription(read), client = new QueryClient();
  const wasOnline = onlineManager.isOnline();
  onlineManager.setOnline(false);
  let dispose = () => {};
  createRoot(end => {
    dispose = end;
    return createComponent(QueryClientProvider, { client, get children() {
      const query = untrack(() => useConvexQuery(convexApi.effects.listByRoom, () => ({ projectId }),
        () => ["b5-subscription", projectId]));
      createEffect(() => { const rows = query.data; if (rows) publishRows(rows); });
      return null;
    } });
  });
  return {
    publish: transport.publish,
    close: () => { dispose(); client.clear(); transport.close(); onlineManager.setOnline(wasOnline); },
  };
};
