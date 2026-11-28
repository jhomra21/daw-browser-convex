import { createEffect, createSignal } from "solid-js";
import type { ExternalProcessor } from "@daw-browser/external-plugins";
import type { Track } from "@daw-browser/timeline-core/types";
import type { TimelineEditIntent } from "~/hooks/timeline-playback-types";
import type { CapturedLocalExternalProcessorState } from "~/lib/external-plugins";
import { instanceLimit, vstInstanceFailed } from "~/lib/desktop/vst-instance-failures";

type ExternalProcessorEditorRequest = {
  instanceId: string;
  projectId: string;
  projectGeneration: number;
  requestToken: number;
  ready: boolean;
};

type PersistVstState = (
  projectId: string,
  instanceId: string,
  state: CapturedLocalExternalProcessorState,
) => Promise<ExternalProcessor | undefined>;

export const createCapturedEditorStatePersister = (persistState: PersistVstState) =>
  async (payload: { projectId: string; instanceId: string; state: CapturedLocalExternalProcessorState }) => {
    const persisted = await persistState(payload.projectId, payload.instanceId, payload.state).catch((error) => {
      console.error("[native-vst3] editor teardown state persistence failed", {
        projectId: payload.projectId,
        instanceId: payload.instanceId,
        error: error instanceof Error ? error.message : "unknown error",
      });
      throw error;
    });

    if (!persisted) throw new Error(`The captured native VST editor processor "${payload.instanceId}" no longer exists.`);
  };

// An inserted plug-in's editor opens only once the playback rebuild that hosts it has finished, and only for the
// project and generation that asked for it.
export const createExternalProcessorEditorRequests = (deps: {
  projectId: () => string;
  mountedProjectGeneration: () => number;
  openEffectsForTarget: (targetId: Track["id"]) => void;
  captureStructuralPlaybackIntent: () => TimelineEditIntent;
  syncPlaybackBackend: (tracks: Track[], intent: TimelineEditIntent) => Promise<void>;
  renderTracks: () => Track[];
  nativePlaybackEnabled: () => boolean;
  captureVstState: (
    instanceId: string,
  ) => Promise<(CapturedLocalExternalProcessorState & { ok: true }) | { ok: false; error?: string } | undefined>;
  persistState: PersistVstState;
}) => {
  const [pending, setPending] = createSignal<ExternalProcessorEditorRequest>();
  let requestToken = 0;

  const isCurrent = (request: ExternalProcessorEditorRequest) =>
    request.projectId === deps.projectId() && request.projectGeneration === deps.mountedProjectGeneration();

  const clearIfPending = (request: ExternalProcessorEditorRequest) => {
    if (pending()?.requestToken === request.requestToken) setPending();
  };

  createEffect(() => {
    const request = pending();

    if (request && !isCurrent(request)) setPending();
  });

  const inserted = async (processor: ExternalProcessor, playbackIntent?: TimelineEditIntent) => {
    deps.openEffectsForTarget(processor.targetId);
    const intent = playbackIntent ?? deps.captureStructuralPlaybackIntent();
    const insertedProjectId = intent.projectId ?? deps.projectId();

    // The drop's project guards the insertion; the transport is the session's own when it adopts it.
    const insertionIntent: TimelineEditIntent = {
      projectId: intent.projectId,
      projectGeneration: intent.projectGeneration,
      externalProcessor: { projectId: insertedProjectId, processor },
    };

    const request: ExternalProcessorEditorRequest = {
      instanceId: processor.instanceId,
      projectId: insertedProjectId,
      projectGeneration: intent.projectGeneration ?? deps.mountedProjectGeneration(),
      requestToken: ++requestToken,
      ready: false,
    };

    setPending(request);
    const nativePlaybackEnabled = deps.nativePlaybackEnabled();
    console.info("[native-vst3] external plugin inserted", {
      instanceId: processor.instanceId,
      targetId: processor.targetId,
      nativePlaybackEnabled,
    });

    try {
      await deps.syncPlaybackBackend(deps.renderTracks(), insertionIntent);

      // A plug-in that crashed while staged is shown failed on its device; there is no instance to read or edit.
      if (vstInstanceFailed(processor.instanceId)) throw new Error("The plug-in failed while it was staged.");

      // A browser session holds no instance of the plug-in, so there is no state to read and no editor to open.
      if (instanceLimit(processor.instanceId)) {
        clearIfPending(request);

        return;
      }

      if (processor.manifest.supportsState) {
        const capture = await deps.captureVstState(processor.instanceId);

        if (!capture?.ok) {
          throw new Error(`Native VST3 baseline state capture failed${capture?.error ? `: ${capture.error}` : "."}`);
        }

        await deps.persistState(insertedProjectId, processor.instanceId, capture);
      }

      console.info("[native-vst3] insertion reached playback", {
        instanceId: processor.instanceId,
        targetId: processor.targetId,
          nativePlaybackEnabled,
      });
    } catch (error) {
      // The insertion stays in the project and the playing graph is unchanged; the next adoption retries it.
      console.error("[native-vst3] live insertion did not reach playback", {
        instanceId: processor.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      clearIfPending(request);

      return;
    }

    const current = pending();

    if (current?.requestToken === request.requestToken && isCurrent(current)) setPending({ ...current, ready: true });
  };

  return {
    inserted,
    autoOpenInstanceId: () => {
      const request = pending();

      return request?.ready && isCurrent(request) ? request.instanceId : undefined;
    },
    autoOpenHandled: (instanceId: string) => {
      const request = pending();

      if (request?.ready && request.instanceId === instanceId) setPending();
    },
  };
};
