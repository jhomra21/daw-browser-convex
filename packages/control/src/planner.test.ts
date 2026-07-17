import { expect, test } from "bun:test";

import { planControlRequestV1 } from "./planner";

const snapshot = () => ({
  version: "v1",
  project: {
    id: "project-1",
    name: "Project",
    revision: 0,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 8 },
    masterVolume: 0.8,
    updatedAt: 0,
  },
  tracks: [{
    id: "track-1",
    name: "Instrument",
    index: 0,
    kind: "instrument",
    channelRole: "track",
    volume: 0.8,
    muted: false,
    soloed: false,
    sends: [],
  }],
  clips: [{
    id: "clip-1",
    trackId: "track-1",
    name: "Clip",
    startSec: 0,
    duration: 4,
    gain: 1,
    leftPadSec: 0,
    bufferOffsetSec: 0,
    midiOffsetBeats: 0,
    fades: {
      fadeInSec: 1,
      fadeOutSec: 1,
      fadeInCurve: 0,
      fadeOutCurve: 0,
    },
  }],
  processors: [{
    id: "effect-1",
    target: { trackId: "track-1" },
    instanceId: "audio-effect:one",
    index: 0,
    processor: { kind: "eq", params: {} },
  }],
  automation: [],
  sidechains: [],
});

const persisted = (id: string) => ({ source: "persisted", id });

test("plans client refs as non-persisted placeholders", () => {
  const plan = planControlRequestV1(snapshot(), {
    projectId: "project-1",
    actions: [{ kind: "track.create", clientRef: "new-track", trackKind: "audio" }],
  });

  expect(plan.resolvedRefs).toEqual([{
    entity: "track",
    clientRef: "new-track",
    id: "control:track:new-track",
    persisted: false,
  }]);
});

test("normalizes fades when shrinking a clip and preserves omitted offsets", () => {
  const plan = planControlRequestV1(snapshot(), {
    projectId: "project-1",
    actions: [{
      kind: "clip.timing.set",
      clip: persisted("clip-1"),
      duration: 1,
      fadeInSec: 1,
      fadeOutSec: 1,
    }],
  });

  expect(plan.snapshot.clips[0]?.duration).toBe(1);
  expect(plan.snapshot.clips[0]?.leftPadSec).toBe(0);
  expect(plan.snapshot.clips[0]?.fades?.fadeInSec).toBeLessThanOrEqual(1);
  expect(plan.snapshot.clips[0]?.fades?.fadeOutSec).toBeLessThanOrEqual(1);
});

test("rejects reorder that omits a target audio effect", () => {
  const base = snapshot();
  base.processors.push(
    {
      id: "effect-2",
      target: { trackId: "track-1" },
      instanceId: "audio-effect:two",
      index: 1,
      processor: { kind: "reverb", params: {} },
    },
  );

  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "effect.reorder",
      target: { kind: "track", track: persisted("track-1") },
      order: [{ effect: persisted("effect-1"), kind: "eq" }],
    }],
  })).toThrow();
});

test("enforces automation target and effect ownership compatibility before execution", () => {
  const base = snapshot();
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "automation.set",
      target: { kind: "master" },
      parameterId: "instrument:track-1:instrument:sampler:one:amp.gainDb",
      enabled: true,
      points: [],
    }],
  })).toThrow();
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "automation.set",
      target: { kind: "track", track: persisted("track-1") },
      effect: persisted("effect-1"),
      parameterId: "delay.feedback",
      enabled: true,
      points: [],
    }],
  })).toThrow();
  expect(planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "automation.set",
      target: { kind: "track", track: persisted("track-1") },
      parameterId: "volume",
      enabled: true,
      points: [],
    }],
  }).applied).toBe(true);
});

test("requires an exact eligible sidechain target effect", () => {
  const base = snapshot();
  base.processors.push({
    id: "effect-2",
    target: { trackId: "other-track" },
    instanceId: "audio-effect:one",
    index: 1,
    processor: { kind: "compressor", params: {} },
  });
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "sidechain.remove",
      target: persisted("track-1"),
      effect: persisted("effect-2"),
    }],
  })).toThrow();
});

test("compacts effect indices after an exact removal", () => {
  const base = snapshot();
  base.processors.push({
    id: "effect-2",
    target: { trackId: "track-1" },
    instanceId: "audio-effect:two",
    index: 1,
    processor: { kind: "reverb", params: {} },
  });
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "effect.remove",
      target: { kind: "track", track: persisted("track-1") },
      effectKind: "eq",
      effect: persisted("effect-1"),
    }],
  });
  expect(plan.snapshot.processors).toEqual([{
    id: "effect-2",
    target: { trackId: "track-1" },
    instanceId: "audio-effect:two",
    index: 0,
    processor: { kind: "reverb", params: {} },
  }]);
});
