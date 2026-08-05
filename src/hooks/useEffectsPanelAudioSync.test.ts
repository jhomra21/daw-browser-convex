import { expect, test } from "bun:test";
import type { SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { createSpectrumSubscriptionOwner } from "./useEffectsPanelAudioSync";

type SpectrumProvider = (
  targetId: string,
  listener: (frame: SpectrumFrame | null) => void,
) => () => void;

test("keeps the spectrum subscription across unrelated panel updates", () => {
  const events: string[] = [];
  const listeners = new Map<string, (frame: SpectrumFrame | null) => void>();
  const providerA: SpectrumProvider = (targetId, listener) => {
    events.push(`subscribe:a:${targetId}`);
    listeners.set(`a:${targetId}`, listener);
    return () => {
      events.push(`unsubscribe:a:${targetId}`);
      listeners.delete(`a:${targetId}`);
    };
  };
  const providerB: SpectrumProvider = (targetId, listener) => {
    events.push(`subscribe:b:${targetId}`);
    listeners.set(`b:${targetId}`, listener);
    return () => {
      events.push(`unsubscribe:b:${targetId}`);
      listeners.delete(`b:${targetId}`);
    };
  };
  const frames: Array<SpectrumFrame | null> = [];
  const frame: SpectrumFrame = { data: new Float32Array([1]), sampleRate: 44100 };
  const owner = createSpectrumSubscriptionOwner((frame) => frames.push(frame));
  owner.update(true, providerA, "track");
  expect(events).toEqual(["subscribe:a:track"]);

  owner.update(true, providerA, "track");
  expect(events).toEqual(["subscribe:a:track"]);

  const staleTrackListener = listeners.get("a:track");
  owner.update(true, providerA, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
  ]);
  staleTrackListener?.(frame);
  expect(frames).toEqual([]);

  owner.update(true, providerB, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
  ]);

  owner.update(false, providerB, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
    "unsubscribe:b:master",
  ]);

  owner.update(true, providerB, "master");
  expect(events).toEqual([
    "subscribe:a:track",
    "unsubscribe:a:track",
    "subscribe:a:master",
    "unsubscribe:a:master",
    "subscribe:b:master",
    "unsubscribe:b:master",
    "subscribe:b:master",
  ]);

  const currentListener = listeners.get("b:master");
  owner.dispose();
  owner.dispose();
  expect(events.at(-1)).toBe("unsubscribe:b:master");
  currentListener?.(frame);
  expect(frames).toEqual([null]);
});
