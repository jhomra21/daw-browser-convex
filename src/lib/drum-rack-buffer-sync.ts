import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { DrumRackPadSample, DrumRackParams, TrackInstrumentParams } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import { createSampleBufferLoader, type SampleBufferLoaderOptions } from "~/lib/sample-buffer-loader";

type DrumRackBufferCacheEntry = {
  key: string;
  instanceId?: string;
  projectId: string;
  buffers: ReadonlyMap<string, AudioBuffer>;
};

export const drumRackSampleKey = (sample: DrumRackPadSample): string => [
  sample.assetKey,
  sample.url,
  sample.sourceKind,
  sample.source.durationSec,
  sample.source.sampleRate,
  sample.source.channelCount,
].join("\n");

const drumRackParamsBufferKey = (projectId: string, params: DrumRackParams): string => `${projectId}\u0000${params.pads
  .map((pad) => `${pad.id}:${pad.sample ? drumRackSampleKey(pad.sample) : ""}`)
  .join("\n")}`;

export function createDrumRackBufferSync(options: Pick<SampleBufferLoaderOptions, "projectId" | "readLocalAsset"> & {
  isCurrentProject?: () => boolean
} = {}) {
  const loader = createSampleBufferLoader({ ...options, cacheDecodedBuffers: false });
  const cache = new Map<Track["id"], DrumRackBufferCacheEntry>();
  const versions = new Map<Track["id"], number>();
  let disposed = false;

  const clearTrack = (trackId: Track["id"]) => {
    cache.delete(trackId);
    versions.set(trackId, (versions.get(trackId) ?? 0) + 1);
  };

  const syncTrack = (audioEngine: AudioEngine, trackId: Track["id"], params: DrumRackParams, instanceId?: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    const projectId = options.projectId?.() ?? "";
    const key = drumRackParamsBufferKey(projectId, params);
    const version = (versions.get(trackId) ?? 0) + 1;
    versions.set(trackId, version);
    const cached = cache.get(trackId);
    if (cached?.key === key && cached.instanceId === instanceId && cached.projectId === projectId) {
      if (options.isCurrentProject?.() === false) return Promise.resolve();
      audioEngine.setTrackDrumRack(trackId, params, cached.buffers);
      return Promise.resolve();
    }

    if (options.isCurrentProject?.() === false) return Promise.resolve();
    audioEngine.setTrackDrumRack(trackId, params);

    const jobs = params.pads.flatMap((pad) => pad.sample ? [{ padId: pad.id, sample: pad.sample }] : []);
    if (jobs.length === 0) {
      const buffers = new Map<string, AudioBuffer>();
      cache.set(trackId, { key, instanceId, projectId, buffers });
      if (options.isCurrentProject?.() === false) return Promise.resolve();
      audioEngine.setTrackDrumRack(trackId, params, buffers);
      return Promise.resolve();
    }

    return Promise.all(jobs.map(async (job) => {
      const buffer = await loader.load(
        job.sample.url,
        (data, targetSampleRate) => audioEngine.decodeAudioData(data, targetSampleRate),
        { targetSampleRate: job.sample.source.sampleRate },
      );
      return buffer ? { padId: job.padId, buffer } : undefined;
    })).then((loaded) => {
      if (disposed) return;
      if (versions.get(trackId) !== version) return;
      const buffers = new Map<string, AudioBuffer>();
      for (const entry of loaded) {
        if (entry) buffers.set(entry.padId, entry.buffer);
      }
      cache.set(trackId, { key, instanceId, projectId, buffers });
      if (options.isCurrentProject?.() === false) return;
      audioEngine.setTrackDrumRack(trackId, params, buffers);
    });
  };

  const snapshotBuffers = (
    trackId: Track["id"],
    instrument: Extract<TrackInstrumentParams, { kind: "drum-rack" }>,
  ) => {
    const entry = cache.get(trackId);
    const projectId = options.projectId?.() ?? "";
    if (!entry || entry.key !== drumRackParamsBufferKey(projectId, instrument.params)
      || entry.instanceId !== instrument.instanceId || entry.projectId !== projectId) return undefined;
    return new Map(entry.buffers);
  };

  const dispose = () => {
    disposed = true;
    cache.clear();
    versions.clear();
    loader.clear();
  };

  return {
    clearTrack,
    dispose,
    snapshotBuffers,
    syncTrack,
  };
}
