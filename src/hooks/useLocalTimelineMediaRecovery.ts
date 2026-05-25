import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { AudioEngine } from "~/lib/audio-engine";
import { getAudioSourceMetadata } from "~/lib/audio-source";
import { createLocalAsset } from "~/lib/local-assets";
import { isLocalId } from "~/lib/local-ids";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import type { Clip, Track } from "~/types/timeline";

type ProjectionActions = {
  insertLocalClip: (trackId: Track["id"], clip: Clip) => void;
  removeLocalClips: (clipIds: Iterable<string>) => void;
};

type SelectionActions = {
  selectedClip: Accessor<{ clipId: string } | null>;
  setSelectedClip: (clip: null) => void;
  setSelectedClipIds: (updater: (current: Set<string>) => Set<string>) => void;
  selectTrackTarget: (
    trackId: Track["id"],
    options: { clearClipSelection: boolean; clearPrimaryClip: boolean },
  ) => void;
};

type Input = {
  projectId: Accessor<string>;
  userId: Accessor<string | undefined>;
  renderTracks: Accessor<Track[]>;
  audioEngine: AudioEngine;
  audioBufferCache: Map<string, AudioBuffer>;
  removeClip: (input: { trackId: Track["id"]; clipId: string }) => Promise<boolean>;
  projection: ProjectionActions;
  selection: SelectionActions;
};

const pickReplacementAudioFile = async (): Promise<File | null> => {
  const openFilePicker = window.showOpenFilePicker;
  if (openFilePicker) {
    try {
      const [handle] = await openFilePicker({
        multiple: false,
        types: [{ description: "Audio", accept: { "audio/*": [] } }],
      });
      return await handle.getFile();
    } catch {
      return null;
    }
  }

  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
};

export const useMissingMediaRecovery = (input: Input) => {
  const [localTimelineSnapshot, setLocalTimelineSnapshot] = createSignal<
    Awaited<ReturnType<ReturnType<typeof createLocalTimelineRepository>["loadSnapshot"]>> | null
  >(null);

  createEffect(() => {
    const rid = input.projectId();
    if (!isLocalId("project", rid)) {
      setLocalTimelineSnapshot(null);
      return;
    }
    let cancelled = false;
    void createLocalTimelineRepository(rid).loadSnapshot().then((snapshot) => {
      if (!cancelled && input.projectId() === rid) setLocalTimelineSnapshot(snapshot);
    }).catch(() => {
      if (!cancelled && input.projectId() === rid) setLocalTimelineSnapshot(null);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  const removeMissingMediaClip = async (trackId: Track["id"], clipId: string) => {
    if (!await input.removeClip({ trackId, clipId })) return;
    input.projection.removeLocalClips([clipId]);
    if (input.selection.selectedClip()?.clipId === clipId) input.selection.setSelectedClip(null);
    input.selection.setSelectedClipIds((current) => {
      const next = new Set(current);
      next.delete(clipId);
      return next;
    });
    input.selection.selectTrackTarget(trackId, {
      clearClipSelection: false,
      clearPrimaryClip: false,
    });
  };

  const replaceMissingMediaClip = async (trackId: Track["id"], clipId: string) => {
    const rid = input.projectId();
    if (!rid || !isLocalId("project", rid)) return;
    const track = input.renderTracks().find((entry) => entry.id === trackId);
    const clip = track?.clips.find((entry) => entry.id === clipId);
    if (!clip) return;
    const file = await pickReplacementAudioFile();
    if (!file) return;
    const decoded = await input.audioEngine.decodeAudioData(await file.arrayBuffer());
    const source = getAudioSourceMetadata(decoded);
    const asset = await createLocalAsset({
      projectId: rid,
      file,
      metadata: {
        durationSec: source.durationSec,
        sampleRate: source.sampleRate,
        originalFileName: file.name,
        originalLastModified: file.lastModified,
      },
    });
    const sourceKind: Clip["sourceKind"] = "upload";
    const updated = {
      ...clip,
      name: file.name || clip.name,
      buffer: decoded,
      mediaStatus: undefined,
      duration: decoded.duration,
      sourceAssetKey: asset.id,
      sourceKind,
      sourceDurationSec: source.durationSec,
      sourceSampleRate: source.sampleRate,
      sourceChannelCount: source.channelCount,
      sampleUrl: undefined,
    };
    await createLocalTimelineRepository(rid).updateClip({
      clipId,
      name: updated.name,
      duration: updated.duration,
      sourceAssetId: asset.id,
      sourceAssetKey: asset.id,
      sourceKind,
      sourceDurationSec: source.durationSec,
      sourceSampleRate: source.sampleRate,
      sourceChannelCount: source.channelCount,
      sampleUrl: null,
    });
    input.audioBufferCache.set(clipId, decoded);
    input.projection.removeLocalClips([clipId]);
    input.projection.insertLocalClip(trackId, updated);
  };

  return {
    localTimelineSnapshot,
    removeMissingMediaClip,
    replaceMissingMediaClip,
  };
};
