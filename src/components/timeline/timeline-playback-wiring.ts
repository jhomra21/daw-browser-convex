import type { Track } from "@daw-browser/timeline-core/types";
import type { TrackInstrumentParams } from "@daw-browser/shared";
import type { EffectsPanelExportSnapshot } from "~/components/timeline/create-effects-panel-controller";
import type { TimelineEditIntent, TimelineScheduleOptions } from "~/hooks/timeline-playback-types";
import type { LivePlaybackCompileContext } from "~/lib/live-playback-snapshot";
import type { LiveProcessorControl, LiveProcessorEditIdentity } from "~/lib/live-processor-control";
import { SYNTH_KIND_ID } from "~/lib/processor-edit-semantics";
import { addInstanceLimit } from "~/lib/desktop/vst-instance-failures";

type CompileEffects = Pick<EffectsPanelExportSnapshot, "awaitInstrumentReadiness" | "snapshotEffectsProjection">;
type InstrumentOverride = { targetId: Track["id"]; instrument: TrackInstrumentParams };
type PlaybackBackendSync = (
  tracks: Track[],
  intent?: TimelineEditIntent,
  instrumentOverride?: InstrumentOverride,
) => Promise<void>;
type PreparedSessions = {
  isNativePlaybackPrepared: () => boolean;
  isPortableBrowserPlaybackPrepared: () => boolean;
};

// A compile reads the canonical effects draft without draining its owner: that drain could wait on a structural
// handoff that awaits this same preparation.
export const awaitCompileInstruments = async (
  effects: CompileEffects | undefined,
  context: LivePlaybackCompileContext | undefined,
) => {
  context?.mark?.("compile-start");
  const readiness = await effects?.awaitInstrumentReadiness(context?.instrumentOverride);
  context?.mark?.("compile-instruments-ready");
  return readiness;
};

export const compileEffectsProjection = (
  effects: CompileEffects | undefined,
  readiness: Awaited<ReturnType<typeof awaitCompileInstruments>>,
) => readiness?.projection ?? effects?.snapshotEffectsProjection();

// A prepared session, native or browser, playing or paused, adopts a structural edit in place; only a session still
// starting is rebuilt.
export const createSyncPlaybackBackend = (deps: PreparedSessions & {
  rebuildPlaybackBackend: (tracks: Track[], intent: TimelineEditIntent, instrumentOverride?: InstrumentOverride) => Promise<void>;
  restartTimelineSchedule: (tracks: Track[], options?: TimelineScheduleOptions) => Promise<void>;
  captureStructuralPlaybackIntent: () => TimelineEditIntent;
}): PlaybackBackendSync => (tracks, intent, instrumentOverride) => {
  if (!deps.isNativePlaybackPrepared() && !deps.isPortableBrowserPlaybackPrepared()) {
    return deps.rebuildPlaybackBackend(tracks, intent ?? deps.captureStructuralPlaybackIntent(), instrumentOverride);
  }
  const inserted = intent?.externalProcessor?.processor;
  // A browser session cannot host a VST3: it adopts the edit without it, and the device shows the limitation (E6).
  if (inserted && !deps.isNativePlaybackPrepared()) {
    addInstanceLimit(inserted.instanceId, "The browser engine does not host VST3 plug-ins yet.");
    console.info("[native-vst3] insertion not hosted by the browser engine; the session adopts the edit without it", {
      instanceId: inserted.instanceId,
    });
  }
  return deps.restartTimelineSchedule(tracks, { ...(intent ?? deps.captureStructuralPlaybackIntent()), instrumentOverride });
};

export const createInstrumentPlaybackChange = (deps: PreparedSessions & {
  mountedProjectGeneration: () => number;
  awaitPlaybackPreparation: () => Promise<void>;
  preparedInstrument: (targetId: Track["id"]) => TrackInstrumentParams | undefined;
  isStructuralRebuildInProgress: () => boolean;
  isPreparingPlayback: () => boolean;
  isPlaying: () => boolean;
  syncPlaybackBackend: PlaybackBackendSync;
  renderTracks: () => Track[];
  captureStructuralPlaybackIntent: () => TimelineEditIntent;
}) => {
  // Serialize graph decisions with live flushes so the newest notification wins.
  let tail = Promise.resolve();
  return (targetId: Track["id"], instrument: TrackInstrumentParams | undefined) => {
    const generation = deps.mountedProjectGeneration();
    return tail = tail.then(async () => {
      await deps.awaitPlaybackPreparation();
      if (generation !== deps.mountedProjectGeneration()) return;
      const previous = deps.preparedInstrument(targetId);
      // Equality is safe only at rest: a queued B must not supersede a newer A.
      if (!deps.isStructuralRebuildInProgress() && !deps.isPreparingPlayback()) {
        if (JSON.stringify(previous) === JSON.stringify(instrument)) return;
      }
      if (!deps.isPlaying() && !deps.isNativePlaybackPrepared() && !deps.isPortableBrowserPlaybackPrepared()
        && !deps.isStructuralRebuildInProgress()
        && !deps.isPreparingPlayback()) return;
      // A prepared browser session, playing or paused, adopts an instrument edit or replacement through the hook's follow.
      if (deps.isPortableBrowserPlaybackPrepared() && !deps.isNativePlaybackPrepared()) return;
      // A playing native session carries an edit to the same instrument as a published configuration: the schedule
      // follow adopts it, so there is no graph to rebuild.
      if (deps.isPlaying() && previous && instrument && previous.kind === instrument.kind
        && previous.instanceId === instrument.instanceId) return;
      await deps.syncPlaybackBackend(deps.renderTracks(), deps.captureStructuralPlaybackIntent(),
        instrument ? { targetId, instrument } : undefined);
    }).catch((cause: unknown) => {
      console.error("[Timeline] failed to apply an instrument change to native playback", cause);
    });
  };
};

export const createApplyPortableProcessor = (deps: PreparedSessions & {
  liveProcessorControl: () => Pick<LiveProcessorControl, "flush"> | undefined;
  syncPlaybackBackend: PlaybackBackendSync;
  renderTracks: () => Track[];
}) => async (edit: LiveProcessorEditIdentity) => {
  const control = deps.liveProcessorControl();
  if (!control) return undefined;
  const result = await control.flush({
    instanceId: edit.target.instanceId,
    values: Object.entries(edit.content.values ?? {}).map(([parameterId, value]) => ({ parameterId, value })),
    edit,
  });
  if (result.accepted) return "applied";
  if (result.reason === "cancelled" || result.reason === "stale") return "superseded";
  if (result.reason === "unavailable" || result.reason === "unprepared") return "dropped";
  if (result.reason !== "unsupported") throw new Error(result.error ?? "The portable processor update failed.");
  // A prepared browser session takes what it cannot take live through the schedule follow, which adopts it at a seam;
  // a Synth edit is carried by the release announce.
  if ((deps.isPortableBrowserPlaybackPrepared() && !deps.isNativePlaybackPrepared()) || edit.target.kindId === SYNTH_KIND_ID) return undefined;
  await deps.syncPlaybackBackend(deps.renderTracks());
  return "applied";
};

export const createMixedReorderCommitted = (deps: PreparedSessions & {
  isPlaying: () => boolean;
  syncPlaybackBackend: PlaybackBackendSync;
  renderTracks: () => Track[];
  captureStructuralPlaybackIntent: () => TimelineEditIntent;
}) => (playbackIntent: TimelineEditIntent | undefined) => {
  // A prepared browser session adopts the new effect order through the hook's follow.
  if (deps.isPortableBrowserPlaybackPrepared() && !deps.isNativePlaybackPrepared()) return;
  if (!deps.isPlaying() && !deps.isNativePlaybackPrepared()) return;
  void deps.syncPlaybackBackend(deps.renderTracks(), playbackIntent ?? deps.captureStructuralPlaybackIntent()).catch((cause: unknown) => {
    console.error("[Timeline] failed to apply an effect reorder to native playback", cause);
  });
};
