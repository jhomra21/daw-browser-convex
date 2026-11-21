import { maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"
import type { Accessor } from "solid-js"
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types"
import { isLocalId } from "@daw-browser/shared"
import {
  awaitCompileInstruments,
  compileEffectsProjection,
} from "~/components/timeline/timeline-playback-wiring"
import type { EffectsPanelExportSnapshot } from "~/components/timeline/create-effects-panel-controller"
import type { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry"
import type { useTimelineData } from "~/hooks/useTimelineData"
import type { useTimelineMasterVolume } from "~/hooks/useTimelineMasterVolume"
import { compileNativeExternalAttachmentPlan } from "~/lib/desktop/native-external-attachment-plan"
import { resolveNativeLivePlaybackProcessors } from "~/lib/desktop/native-live-playback-processors"
import { type createLocalExternalProcessorCache, getLocalExternalProcessor, readLocalExternalProcessorState } from "~/lib/external-plugins"
import { createExportRenderStateSnapshot } from "~/lib/export/export-render-state"
import { withInstrumentOverride } from "~/lib/export/export-effect-rows"
import type { ExportAutomationPatch } from "~/lib/desired-playback-state"
import { compileLivePlaybackSnapshot, type LivePlaybackCompileContext, type LivePlaybackTransport } from "~/lib/live-playback-snapshot"

type PlaybackSnapshotCompilerInput = {
  projectId: Accessor<string>
  userId: Accessor<string>
  fullView: ReturnType<typeof useTimelineData>["fullView"]
  renderTracks: Accessor<Track[]>
  bpm: Accessor<number>
  sidechainRoutes: Accessor<ExternalSidechainRoute[]>
  masterVolume: Pick<ReturnType<typeof useTimelineMasterVolume>, "volume">
  effectsExportSnapshot: Accessor<EffectsPanelExportSnapshot | undefined>
  processorEdits: Pick<ReturnType<typeof createProcessorEditRegistry>, "sequence">
  localExternalProcessors: Pick<ReturnType<typeof createLocalExternalProcessorCache>, "read">
  playbackRevision: () => number
}

export const createPlaybackSnapshotCompiler = (input: PlaybackSnapshotCompilerInput) => {
  const {
    projectId,
    userId,
    fullView,
    renderTracks,
    bpm,
    sidechainRoutes,
    masterVolume,
    effectsExportSnapshot,
    processorEdits,
    localExternalProcessors,
    playbackRevision,
  } = input

  return async (
    transport: LivePlaybackTransport,
    context: LivePlaybackCompileContext | undefined,
    automationPatches: () => ExportAutomationPatch[],
  ) => {
    const effects = effectsExportSnapshot();
    const instrumentReadiness = await awaitCompileInstruments(effects, context);

    try {
      const effectsProjection = compileEffectsProjection(effects, instrumentReadiness);
      const processorStateSequence = processorEdits.sequence();
      const snapshotTracks = renderTracks();
      const snapshotBpm = bpm();

      const snapshotTimeSignature = {
        numerator: fullView.data?.project.timeSignatureNumerator ?? 4,
        denominator: fullView.data?.project.timeSignatureDenominator ?? 4,
      };

      const snapshotSidechains = effects?.snapshotSidechainRoutes() ?? sidechainRoutes();

      const projectedEffects = !instrumentReadiness && context?.instrumentOverride
        ? withInstrumentOverride(effectsProjection ?? { replaceAudioEffectTargets: [], upsertDeviceRows: [] }, context.instrumentOverride.targetId, context.instrumentOverride.instrument)
        : effectsProjection;

      const compiledProjectId = projectId();

      // The processor list does not depend on the render state, so its read (a cache hit unless the project changed) runs beside it.
      const persistedProcessors = isLocalId("project", compiledProjectId)
        ? localExternalProcessors.read(compiledProjectId)
        : undefined;

      const renderState = await createExportRenderStateSnapshot({
        projectId: projectId(),
        userId: userId(),
        masterVolume: masterVolume.volume(),
        externalPluginPolicy: "native-playback",
        cloudRows: fullView.data
          ? {
              effects: fullView.data.effects,
              automationEnvelopes: fullView.data.automationEnvelopes,
            }
          : undefined,
        effectsProjection: projectedEffects,
        automationPatches: automationPatches(),
      });

      context?.mark?.("compile-render-state-ready");

      const hydratedRenderState = instrumentReadiness?.hydrateInstrumentBuffers(renderState)
        ?? effects?.hydrateInstrumentBuffers?.(renderState) ?? renderState;

      const result = compileLivePlaybackSnapshot({
        revision: playbackRevision(),
        processorStateSequence,
        bpm: snapshotBpm,
        timeSignature: snapshotTimeSignature,
        transport,
        tracks: snapshotTracks,
        renderState: hydratedRenderState,
        sidechainRoutes: snapshotSidechains,
      });

      if (!result.supported || !persistedProcessors) return result;

      const liveProcessors = (await persistedProcessors)
        .filter((processor) => !processor.bypassed && processor.health.state !== "degraded");

      const processors = await resolveNativeLivePlaybackProcessors({
        projectId: compiledProjectId,
        persisted: liveProcessors,
        seed: context?.externalProcessor,
        readPersisted: getLocalExternalProcessor,
      });

      context?.mark?.("compile-processors-ready");

      if (processors.length === 0) return result;

      const attachmentPlan = compileNativeExternalAttachmentPlan({
        target: "native",
        graph: result.snapshot.mixer.graph,
        processors,
        workerTransport: {
          slotCount: 2,
          maximumFrames: maxVst3WorkerFrames,
          maximumEventsPerBlock: 128,
        },
      });

      if (!attachmentPlan.supported) {
        return {
          supported: true as const,
          snapshot: {
            ...result.snapshot,
            requiresNativePlayback: true,
          },
        };
      }

      const nativeExternalAttachmentStates = await Promise.all(attachmentPlan.plan.attachments
        .filter((attachment) => !attachment.bypassed)
        .map(async (attachment) => {
          const processor = processors.find((candidate) => candidate.instanceId === attachment.instanceId)

          if (!processor?.manifest.supportsState) return undefined

          const state = processor
            ? await readLocalExternalProcessorState(compiledProjectId, processor)
            : undefined

          return state ? { instanceId: attachment.instanceId, ...state } : undefined
        }))

      const nativeExternalAttachmentStateRequirements = processors
        .filter((processor) => !processor.bypassed
          && processor.manifest.supportsState
          && (processor.state !== undefined || processor.launchReference?.state !== undefined))
        .map((processor) => processor.instanceId)

      return {
        supported: true as const,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: attachmentPlan.plan,
          nativeExternalAttachmentStates: nativeExternalAttachmentStates.filter((state): state is NonNullable<typeof state> => state !== undefined),
          nativeExternalAttachmentStateRequirements,
          requiresNativePlayback: true,
        },
      };
    } finally {
      instrumentReadiness?.release();
      context?.mark?.("compile-end");
    }
  }
}
