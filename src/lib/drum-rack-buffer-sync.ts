import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { DrumRackPadSample, DrumRackParams } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import { createSampleBufferLoader } from "~/lib/sample-buffer-loader";

type DrumRackBufferCacheEntry = {
  key: string;
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

const drumRackParamsBufferKey = (params: DrumRackParams): string => params.pads
  .map((pad) => `${pad.id}:${pad.sample ? drumRackSampleKey(pad.sample) : ""}`)
  .join("\n");

export function createDrumRackBufferSync() {
  const loader = createSampleBufferLoader();
  const cache = new Map<Track["id"], DrumRackBufferCacheEntry>();
  const versions = new Map<Track["id"], number>();
  let disposed = false;

  const clearTrack = (trackId: Track["id"]) => {
    cache.delete(trackId);
    versions.set(trackId, (versions.get(trackId) ?? 0) + 1);
  };

  const syncTrack = (audioEngine: AudioEngine, trackId: Track["id"], params: DrumRackParams) => {
    if (disposed) return;
    const key = drumRackParamsBufferKey(params);
    const version = (versions.get(trackId) ?? 0) + 1;
    versions.set(trackId, version);
    const cached = cache.get(trackId);
    if (cached?.key === key) {
      audioEngine.setTrackDrumRack(trackId, params, cached.buffers);
      return;
    }

    audioEngine.setTrackDrumRack(trackId, params);

    const jobs = params.pads.flatMap((pad) => pad.sample ? [{ padId: pad.id, sample: pad.sample }] : []);
    if (jobs.length === 0) {
      const buffers = new Map<string, AudioBuffer>();
      cache.set(trackId, { key, buffers });
      audioEngine.setTrackDrumRack(trackId, params, buffers);
      return;
    }

    void Promise.all(jobs.map(async (job) => {
      const buffer = await loader.load(job.sample.url, (data) => audioEngine.decodeAudioData(data));
      return buffer ? { padId: job.padId, buffer } : undefined;
    })).then((loaded) => {
      if (disposed) return;
      if (versions.get(trackId) !== version) return;
      const buffers = new Map<string, AudioBuffer>();
      for (const entry of loaded) {
        if (entry) buffers.set(entry.padId, entry.buffer);
      }
      cache.set(trackId, { key, buffers });
      audioEngine.setTrackDrumRack(trackId, params, buffers);
    });
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
    syncTrack,
  };
}
