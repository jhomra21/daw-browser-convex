import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { AudioEngine, type SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";
import { useEffectsPanelAudioSync } from "./useEffectsPanelAudioSync";

type SpectrumProvider = (
  targetId: string,
  listener: (frame: SpectrumFrame | null) => void,
) => () => void;

const settleReactiveUpdates = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("keeps the spectrum subscription across unrelated panel updates", async () => {
  const events: string[] = [];
  const providerA: SpectrumProvider = (targetId) => {
    events.push(`subscribe:a:${targetId}`);
    return () => events.push(`unsubscribe:a:${targetId}`);
  };
  const providerB: SpectrumProvider = (targetId) => {
    events.push(`subscribe:b:${targetId}`);
    return () => events.push(`unsubscribe:b:${targetId}`);
  };

  const root = createRoot((dispose) => {
    const [panel, setPanel] = createSignal({
      isOpen: true,
      targetId: "track",
      playheadSec: 0,
    });
    const [provider, setProvider] = createSignal<SpectrumProvider | undefined>(providerA);
    const samplerBufferSync = createSamplerBufferSync();
    const audioEngine = new AudioEngine();

    useEffectsPanelAudioSync({
      isOpen: () => panel().isOpen,
      projectId: () => undefined,
      currentTargetId: () => panel().targetId,
      tracks: () => [],
      sidechainRoutes: () => [],
      audioEngine: () => audioEngine,
      roomEffects: () => [],
      samplerBufferSync,
      spectrumProvider: provider,
    });

    return { dispose, samplerBufferSync, setPanel, setProvider };
  });

  await settleReactiveUpdates();
  expect(events).toEqual(["subscribe:a:track"]);

  root.setPanel((current) => ({ ...current, playheadSec: 1 }));
  await settleReactiveUpdates();
  expect(events).toEqual(["subscribe:a:track"]);

  root.setPanel((current) => ({ ...current, targetId: "master" }));
  await settleReactiveUpdates();
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
  ]);

  root.setProvider(() => providerB);
  await settleReactiveUpdates();
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
  ]);

  root.setPanel((current) => ({ ...current, isOpen: false }));
  await settleReactiveUpdates();
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
    "unsubscribe:b:master",
  ]);

  root.setPanel((current) => ({ ...current, isOpen: true }));
  await settleReactiveUpdates();
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
    "unsubscribe:b:master",
    "subscribe:b:master",
  ]);

  root.dispose();
  root.samplerBufferSync.dispose();
});
