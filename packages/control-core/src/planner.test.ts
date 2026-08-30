import { expect, test } from "bun:test";

import {
  canonicalizePlannerSnapshotV1,
  controlApprovalRequirementV1,
  planControlRequestV1,
} from "./planner";
import {
  controlLimitsV1,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  type ControlActionV1,
  type ProjectSnapshotV1,
  type ProjectSnapshotV2,
  type RecoveryPayload,
} from "@daw-browser/control";

const snapshot = (): any => ({
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
    collapsed: false,
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
  assets: [],
  assetFolders: [],
});

type PersistedRef = { source: "persisted"; id: string };
type PlannerRequestFixture = { projectId: string; actions: ControlActionV1[] };

const persisted = (id: string): PersistedRef => ({ source: "persisted", id });
const ownership = { projectId: "project-1", localActorSubject: "local-user" };
const recovery = (payload: RecoveryPayload) => ({ payload });
const mappings = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `mapping-${index}`,
  source: { kind: "cc" as const, controller: index },
  target: { parameterId: "volume" },
  outputMin: 0,
  outputMax: 1,
}));

test("limits MIDI mappings per clip rather than across actions", () => {
  const base = snapshot()
  base.clips[0].midi = { wave: "sine", notes: [], cc: [], pitchBends: [], channelPressure: [], polyPressure: [], mappings: [] }
  expect(planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      { kind: "clip.midi.set", clip: persisted("clip-1"), wave: "sine", notes: [], mappings: mappings(40) },
      { kind: "clip.midi.set", clip: persisted("clip-1"), wave: "sine", notes: [], mappings: mappings(40) },
    ],
  }).applied).toBe(true)
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "clip.midi.set", clip: persisted("clip-1"), wave: "sine", notes: [], mappings: mappings(65) }],
  })).toThrow(expect.objectContaining({ code: "limit-exceeded", actionIndex: 0 }))
})

test("validates every MIDI mapping against the destination track when moving a clip", () => {
  const base = snapshot()
  base.tracks.push({
    ...base.tracks[0],
    id: "track-2",
    name: "Destination",
    index: 1,
  })
  base.clips[0].midi = {
    wave: "sine",
    notes: [],
    cc: [],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [{
      id: "volume",
      source: { kind: "cc", controller: 1 },
      target: { parameterId: "volume" },
      outputMin: 0,
      outputMax: 1,
    }],
  }
  expect(planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "clip.move", clip: persisted("clip-1"), track: persisted("track-2"), startSec: 1 }],
  }).snapshot.clips[0]?.trackId).toBe("track-2")

  base.clips[0].midi.mappings = [{
    id: "source-effect",
    source: { kind: "cc", controller: 1 },
    target: { parameterId: "gain", effectInstanceId: "audio-effect:one" },
    outputMin: 0,
    outputMax: 1,
  }]
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "clip.move", clip: persisted("clip-1"), track: persisted("track-2"), startSec: 1 }],
  })).toThrow(expect.objectContaining({ code: "validation", actionIndex: 0 }))
})

test("plans an atomic selected-track range split with automation boundaries", () => {
  const base = snapshot()
  base.version = "v2"
  base.clips[0].duration = 8
  base.automation = [{
    target: { trackId: "track-1" },
    parameterId: "volume",
    enabled: true,
    points: [
      { id: "a", timeSec: 1, value: 0, interpolation: "linear" },
      { id: "b", timeSec: 3, value: 1, interpolation: "linear" },
      { id: "c", timeSec: 7, value: 0, interpolation: "linear" },
    ],
  }]
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "timeline.range.delete",
      tracks: [persisted("track-1")],
      startSec: 2,
      endSec: 6,
    }],
  })
  const action = plan.actions[0]
  expect(action?.changed).toBe(true)
  expect(action?.timelineRangeDelete?.clipUpdates[0]?.after.duration).toBe(2)
  expect(action?.timelineRangeDelete?.clipCreates[0]?.after.startSec).toBe(6)
  expect(action?.timelineRangeDelete?.automationUpdates[0]?.after.points.map((point) => point.timeSec)).toEqual([1, 2, 6, 7])
  expect(plan.snapshot.clips).toHaveLength(2)
})

test("preserves the planned snapshot version and V2 MIDI envelope", () => {
  const v1 = projectSnapshotSchemaV1.parse({
    ...snapshot(),
    version: "v1",
    processors: [],
  })
  const v1Plan = planControlRequestV1(v1, {
    projectId: "project-1",
    actions: [{ kind: "project.rename", name: "V1 project" }],
  })
  const preservedV1: ProjectSnapshotV1 = v1Plan.snapshot
  expect(preservedV1.version).toBe("v1")

  const v2 = projectSnapshotSchemaV2.parse({
    ...snapshot(),
    version: "v2",
    processors: [],
    clips: [{
      ...snapshot().clips[0],
      midi: {
        wave: "sine",
        inputChannel: 2,
        notes: [{ id: "note-1", beat: 0, length: 1, pitch: 60, channel: 2 }],
        cc: [],
        pitchBends: [],
        channelPressure: [],
        polyPressure: [],
        mappings: [],
      },
    }],
  })
  const v2Plan = planControlRequestV1(v2, {
    projectId: "project-1",
    actions: [{ kind: "project.rename", name: "V2 project" }],
  })
  const preservedV2: ProjectSnapshotV2 = v2Plan.snapshot
  expect(preservedV2.version).toBe("v2")
  expect(preservedV2.clips[0]?.midi?.notes[0]?.channel).toBe(2)
})

test("keeps expanded MIDI unchanged for a matching legacy action", () => {
  const base = snapshot()
  base.clips[0].midi = {
    wave: "sine",
    gain: 0.5,
    inputChannel: 2,
    notes: [{ id: "note-1", beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 2 }],
    cc: [{ id: "cc-1", beat: 0, controller: 1, value: 0.5, channel: 2 }],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [{ id: "mapping-1", source: { kind: "cc", controller: 1, channel: 2 }, target: { parameterId: "gain" }, outputMin: 0, outputMax: 1 }],
  }
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "clip.midi.set",
      clip: persisted("clip-1"),
      wave: "sine",
      gain: 0.5,
      notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5 }],
    }],
  })
  expect(plan.applied).toBe(false)
  expect(plan.snapshot.clips[0]?.midi).toEqual(base.clips[0].midi)
})

test("preserves expanded MIDI when an action note supplies an ID or channel", () => {
  const base = snapshot()
  base.clips[0].midi = {
    wave: "sine",
    inputChannel: 2,
    notes: [{ id: "note-1", beat: 0, length: 1, pitch: 60, channel: 2 }],
    cc: [{ id: "cc-1", beat: 0, controller: 1, value: 0.5, channel: 2 }],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [],
  }
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "clip.midi.set",
      clip: persisted("clip-1"),
      wave: "sine",
      notes: [{ id: "replacement-note", beat: 1, length: 1, pitch: 61, channel: 3 }],
    }],
  })
  expect(plan.snapshot.clips[0]?.midi).toEqual(expect.objectContaining({
    wave: "sine",
    inputChannel: 2,
    notes: [{ id: "replacement-note", beat: 1, length: 1, pitch: 61, channel: 3 }],
    cc: [{ id: "cc-1", beat: 0, controller: 1, value: 0.5, channel: 2 }],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [],
  }))
})

test("reports MIDI resolver failures as bounded action-scoped planner errors", () => {
  const base = snapshot()
  base.clips[0].midi = {
    wave: "sine",
    notes: [{ id: "note-1", beat: 0, length: 1, pitch: 60 }],
    cc: [],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [],
  }
  const request: PlannerRequestFixture = {
    projectId: "project-1",
    actions: [
      { kind: "project.rename", name: "Earlier action" },
      {
        kind: "clip.midi.set",
        clip: persisted("clip-1"),
        wave: "unsupported-wave",
        notes: [{ beat: 0, length: 1, pitch: 60 }],
      },
    ],
  }
  expect(() => planControlRequestV1(base, request)).toThrow(expect.objectContaining({
    code: "validation",
    actionIndex: 1,
  }))
  expect(() => planControlRequestV1(base, {
    ...request,
    actions: [
      request.actions[0],
      {
        kind: "clip.midi.set",
        clip: persisted("clip-1"),
        wave: "sine",
        notes: Array.from({ length: 501 }, (_, index) => ({
          beat: index,
          length: 1,
          pitch: 60,
        })),
      },
    ],
  })).toThrow(expect.objectContaining({
    code: "limit-exceeded",
    actionIndex: 1,
  }))
})

test("traces canonically ordered snapshots for every action and the final plan", () => {
  const base = snapshot()
  base.tracks.push({
    id: "track-2", name: "Audio", index: 1, kind: "audio", channelRole: "track",
    volume: 0.8, muted: false, soloed: false, sends: [],
  })
  base.processors.push({
    id: "effect-2", target: { trackId: "track-1" }, instanceId: "audio-effect:two", index: 1,
    processor: { kind: "reverb", params: {} },
  })
  const traces: any[] = []
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      {
        kind: "track.reorder",
        tracks: [
          { track: persisted("track-2"), index: 0, group: null },
          { track: persisted("track-1"), index: 1, group: null },
        ],
      },
      {
        kind: "effect.reorder",
        target: { kind: "track", track: persisted("track-1") },
        order: [
          { effect: persisted("effect-2"), kind: "reverb" },
          { effect: persisted("effect-1"), kind: "eq" },
        ],
      },
    ],
  }, new Map(), { trace: { onActionPlanned: (entry) => traces.push(entry) } })

  expect(traces).toHaveLength(plan.actions.length)
  for (const entry of traces) {
    expect(entry.afterSnapshot).toEqual(canonicalizePlannerSnapshotV1(entry.afterSnapshot))
  }
  expect(traces.at(-1)?.afterSnapshot).toEqual(plan.snapshot)
})

test("derives destructive impact from the planned base-to-final diff", () => {
  const base = snapshot();
  base.tracks.push({
    id: "track-2", name: "Source", index: 1, kind: "audio", channelRole: "track",
    volume: 0.8, muted: false, soloed: false, sends: [],
  });
  base.automation.push({
    target: { trackId: "track-1" }, effectInstanceId: "audio-effect:one", parameterId: "frequency",
    enabled: true, points: [],
  });
  base.sidechains.push({ sourceTrackId: "track-2", targetTrackId: "track-1", effectInstanceId: "audio-effect:one" });
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "effect.remove",
      target: { kind: "track", track: persisted("track-1") },
      effect: persisted("effect-1"),
      effectKind: "eq",
    }],
  });
  expect(controlApprovalRequirementV1(plan, "a".repeat(64))).toMatchObject({
    required: true,
    actionIndexes: [0],
    actionKinds: ["effect.remove"],
    impact: { processors: 1, automation: 1, sidechains: 1 },
  });
});

test("does not require approval for create-then-delete net no-ops", () => {
  const plan = planControlRequestV1(snapshot(), {
    projectId: "project-1",
    actions: [
      { kind: "track.create", clientRef: "temporary", trackKind: "audio" },
      { kind: "track.delete", track: { source: "client", clientRef: "temporary" } },
    ],
  });
  expect(controlApprovalRequirementV1(plan, "a".repeat(64)).required).toBe(false);
});

test("requires approval to delete an asset restored earlier in the request", () => {
  const plan = planControlRequestV1(snapshot(), {
    projectId: "project-1",
    actions: [
      { kind: "recovery.restore", recovery: { id: "asset-recovery" } },
      { kind: "asset.delete", asset: persisted("restored-asset") },
    ],
  }, new Map([["asset-recovery", recovery({
      version: 2,
      kind: "asset.delete",
      data: {
        assetId: "restored-asset",
        asset: {
          projectId: "project-1",
          assetKey: "restored-asset",
          name: "Restored",
          sourceKind: "upload",
          mimeType: "audio/wav",
          sizeBytes: 1,
          contentSha256: "a".repeat(64),
          storagePath: "restored.wav",
          createdAt: 0,
          updatedAt: 0,
        },
      },
  })]]));
  expect(controlApprovalRequirementV1(plan, "a".repeat(64))).toMatchObject({
    required: true,
    actionIndexes: [1],
    actionKinds: ["asset.delete"],
  });
});

test("rejects track deletion exceeding dedicated recovery limits before approval", () => {
  const base = snapshot();
  base.tracks = Array.from({ length: controlLimitsV1.maxRecoveryEntities + 1 }, (_, index) => ({
    id: `track-${index}`,
    name: `Track ${index}`,
    index,
    kind: "audio",
    channelRole: index === 0 ? "group" : "track",
    volume: 0.8,
    muted: false,
    soloed: false,
    sends: [],
    groupId: index === 0 ? undefined : "track-0",
  }));
  base.clips = [];
  base.processors = [];
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "track.delete", track: persisted("track-0") }],
  })).toThrow();
});

test("plans track deletion for a legacy MIDI clip beyond new write event limits", () => {
  const base = snapshot();
  base.clips[0].midi = {
    wave: "sine",
    notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
    cc: [{ beat: 0, controller: 1, value: 0 }],
  };
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "track.delete", track: persisted("track-1") }],
  })).not.toThrow();
});

test("requires approval when a client-ref deletion cascades persisted descendants", () => {
  const base = snapshot();
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      { kind: "track.create", clientRef: "group", channelRole: "group" },
      { kind: "track.group.set", track: persisted("track-1"), group: { source: "client", clientRef: "group" } },
      { kind: "track.delete", track: { source: "client", clientRef: "group" } },
    ],
  });
  expect(controlApprovalRequirementV1(plan, "a".repeat(64))).toMatchObject({
    required: true,
    actionIndexes: [2],
    actionKinds: ["track.delete"],
    impact: { tracks: 1, clips: 1, processors: 1 },
  });
});

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

test("rejects incomplete authoritative audio assets and projects complete sources", () => {
  const incomplete = {
    ...snapshot(),
    tracks: [{ ...snapshot().tracks[0], kind: "audio" }],
    assets: [{
    id: "asset-1", name: "Audio", sourceKind: "upload", mimeType: "audio/wav",
    sizeBytes: 1, contentSha256: "a".repeat(64), createdAt: 0, updatedAt: 0,
    }],
  };
  expect(() => planControlRequestV1(incomplete, {
    projectId: "project-1",
    actions: [{ kind: "clip.audio.create", track: persisted("track-1"), asset: persisted("asset-1") }],
  })).toThrow()

  const complete = {
    ...incomplete,
    assets: [{ ...incomplete.assets[0], durationSec: 2, sampleRate: 48_000, channelCount: 2 }],
  };
  const plan = planControlRequestV1(complete, {
    projectId: "project-1",
    actions: [
      { kind: "clip.audio.create", clientRef: "audio", track: persisted("track-1"), asset: persisted("asset-1") },
      { kind: "clip.color.set", clip: { source: "client", clientRef: "audio" }, color: "#22c55e" },
    ],
  });
  expect(plan.snapshot.clips.find((clip: ProjectSnapshotV2["clips"][number]) => clip.id === "control:clip:audio")?.source).toEqual({
    assetId: "asset-1", sourceKind: "upload", durationSec: 2, sampleRate: 48_000, channelCount: 2,
  });
});

test("validates recovered audio clip sources against the projected asset set", () => {
  const audioAsset = {
    id: "asset-1", name: "Audio", sourceKind: "upload", mimeType: "audio/wav",
    sizeBytes: 1, contentSha256: "a".repeat(64), durationSec: 2, sampleRate: 48_000, channelCount: 2,
    createdAt: 0, updatedAt: 0,
  } satisfies ProjectSnapshotV2["assets"][number];
  const audioClip = {
    projectId: "project-1", trackId: "track-1", name: "Audio", startSec: 0, duration: 1,
    sourceAssetKey: "asset-1", sourceKind: "upload", sourceDurationSec: 2,
    sourceSampleRate: 48_000, sourceChannelCount: 2,
  } satisfies Extract<RecoveryPayload, { kind: "clip.delete" }>["data"]["clip"];
  const clipRecovery = recovery({
    version: 2,
    kind: "clip.delete",
    data: { clipId: "clip-1", clip: audioClip, ownership },
  });
  const base = snapshot();
  base.tracks[0].kind = "audio";
  base.clips = [];
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "recovery.restore", recovery: { id: "clip" } }],
  }, new Map([["clip", clipRecovery]]))).toThrow('Asset "asset-1" was not found.')

  const assetRecovery = recovery({ version: 2, kind: "asset.delete", data: {
    assetId: "asset-1",
    asset: {
    projectId: "project-1", assetKey: "asset-1", name: audioAsset.name, sourceKind: audioAsset.sourceKind,
    mimeType: audioAsset.mimeType, sizeBytes: audioAsset.sizeBytes, contentSha256: audioAsset.contentSha256,
    storagePath: "asset-1.wav",
    duration: audioAsset.durationSec, sampleRate: audioAsset.sampleRate, channelCount: audioAsset.channelCount,
    createdAt: audioAsset.createdAt, updatedAt: audioAsset.updatedAt,
  } } });
  const recoveries = new Map<string, { payload: RecoveryPayload }>()
  recoveries.set("asset", assetRecovery)
  recoveries.set("clip", clipRecovery)
  const restored = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      { kind: "recovery.restore", recovery: { id: "asset" } },
      { kind: "recovery.restore", recovery: { id: "clip" } },
    ],
  }, recoveries);
  expect(restored.snapshot.clips[0]?.source).toEqual({
    assetId: "asset-1", sourceKind: "upload", durationSec: 2, sampleRate: 48_000, channelCount: 2,
  });

  const trackRecovery = recovery({
    version: 2,
    kind: "track.delete",
    data: {
      rootTrackId: "track-1",
      tracks: [{ id: "track-1", track: {
        projectId: "project-1", name: "Audio", index: 0, kind: "audio",
        mixer: { volume: 1, channelRole: "track", sends: [] },
      }, ownership }],
      clips: [{ id: "clip-1", clip: audioClip, ownership }],
      effects: [], automation: [], sidechains: [], survivors: [],
    },
  });
  const trackBase = { ...base, tracks: [] };
  expect(() => planControlRequestV1(trackBase, {
    projectId: "project-1",
    actions: [{ kind: "recovery.restore", recovery: { id: "track" } }],
  }, new Map([["track", trackRecovery]]))).toThrow('Asset "asset-1" was not found.')
});

test("restores a historical 501-note MIDI recovery without V2 write validation", () => {
  const base = snapshot()
  base.clips = []
  const historicalRecovery = recovery({
      version: 2,
      kind: "clip.delete",
      data: {
        clipId: "clip-1",
        ownership,
        clip: {
          projectId: "project-1",
          trackId: "track-1",
          startSec: 0,
          duration: 501,
          midi: {
            wave: "sine",
            notes: Array.from({ length: 501 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
          },
        },
      },
  })
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "recovery.restore", recovery: { id: "recovery-1" } }],
  }, new Map([["recovery-1", historicalRecovery]]))
  expect(plan.snapshot.clips[0]?.midi?.notes).toHaveLength(501)
})

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
  expect(plan.snapshot.processors).toEqual([expect.objectContaining({
    id: "effect-2",
    target: { trackId: "track-1" },
    instanceId: "audio-effect:two",
    index: 0,
    processor: expect.objectContaining({ kind: "reverb" }),
  })]);
  expect(Object.keys(plan.snapshot.processors[0]?.processor.params ?? {})).toEqual([]);
});

test("uses compacted indices when a removal precedes a reorder", () => {
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
    actions: [
      {
        kind: "effect.remove",
        target: { kind: "track", track: persisted("track-1") },
        effectKind: "eq",
        effect: persisted("effect-1"),
      },
      {
        kind: "effect.reorder",
        target: { kind: "track", track: persisted("track-1") },
        order: [{ effect: persisted("effect-2"), kind: "reverb" }],
      },
    ],
  });
  expect(plan.actions.map((entry) => entry.changed)).toEqual([true, false]);
  expect(plan.snapshot.processors[0]?.index).toBe(0);
});

test("consolidates duplicate instrument and arpeggiator projections on set", () => {
  const base = snapshot();
  base.processors = [
    {
      id: "instrument-canonical",
      target: { trackId: "track-1" },
      instanceId: "instrument-1",
      index: 2,
      processor: {
        kind: "instrument",
        params: {
          kind: "synth",
          instanceId: "instrument-1",
          params: {},
        },
      },
    },
    {
      id: "instrument-legacy",
      target: { trackId: "track-1" },
      instanceId: "instrument-1",
      index: 3,
      processor: {
        kind: "instrument",
        params: {
          kind: "synth",
          instanceId: "instrument-1",
          params: {},
        },
      },
    },
    {
      id: "arp-1",
      target: { trackId: "track-1" },
      index: 4,
      processor: { kind: "arpeggiator", params: { enabled: true, pattern: "up", rate: "1/8", octaves: 1, gate: 0.8, hold: false } },
    },
    {
      id: "arp-2",
      target: { trackId: "track-1" },
      index: 5,
      processor: { kind: "arpeggiator", params: { enabled: true, pattern: "up", rate: "1/8", octaves: 1, gate: 0.8, hold: false } },
    },
    {
      id: "effect-1",
      target: { trackId: "track-1" },
      instanceId: "audio-effect:one",
      index: 0,
      processor: { kind: "eq", params: {} },
    },
    {
      id: "effect-2",
      target: { trackId: "track-1" },
      instanceId: "audio-effect:two",
      index: 1,
      processor: { kind: "reverb", params: {} },
    },
  ];
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      { kind: "instrument.set", target: { kind: "track", track: persisted("track-1") }, instrumentKind: "synth" },
      { kind: "arpeggiator.set", target: { kind: "track", track: persisted("track-1") }, params: { enabled: true, pattern: "up", rate: "1/8", octaves: 1, gate: 0.8, hold: false } },
      {
        kind: "effect.reorder",
        target: { kind: "track", track: persisted("track-1") },
        order: [
          { effect: persisted("effect-1"), kind: "eq" },
          { effect: persisted("effect-2"), kind: "reverb" },
        ],
      },
    ],
  });
  expect(plan.actions.map((entry) => entry.changed)).toEqual([true, true, false]);
  expect(plan.snapshot.processors.map((entry: ProjectSnapshotV2["processors"][number]) => ({ id: entry.id, index: entry.index }))).toEqual([
    { id: "effect-1", index: 0 },
    { id: "effect-2", index: 1 },
    { id: "instrument-canonical", index: 2 },
    { id: "arp-1", index: 3 },
  ]);
});

test("treats absent optional clip fields as clearable and MIDI notes as unordered", () => {
  const base = snapshot();
  base.clips[0] = {
    ...base.clips[0],
    midi: { wave: "sine", gain: 1, notes: [
      { beat: 1, length: 1, pitch: 64 },
      { beat: 0, length: 1, pitch: 60 },
    ] },
  };
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "clip.midi.set",
      clip: persisted("clip-1"),
      wave: "sine",
      gain: 1,
      notes: [
        { beat: 0, length: 1, pitch: 60 },
        { beat: 1, length: 1, pitch: 64 },
      ],
    }],
  });
  expect(plan.applied).toBe(false);
});

test("plans optional audio source, fades, and warp from absent values without throwing", () => {
  const base = snapshot();
  base.tracks[0].kind = "audio";
  base.clips[0].midi = undefined;
  base.clips[0].fades = undefined;
  base.clips[0].audioWarp = undefined;
  base.assets = [{
    id: "asset-1", name: "Audio", sourceKind: "upload", mimeType: "audio/wav",
    sizeBytes: 1, contentSha256: "a".repeat(64), durationSec: 2, sampleRate: 48_000, channelCount: 2,
    createdAt: 0, updatedAt: 0,
  }];
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      { kind: "clip.source.set", clip: persisted("clip-1"), asset: persisted("asset-1") },
      { kind: "clip.fades.set", clip: persisted("clip-1"), fades: { fadeInSec: 0.25, fadeOutSec: 0.25, fadeInCurve: 0, fadeOutCurve: 0 } },
      { kind: "clip.audioWarp.set", clip: persisted("clip-1"), audioWarp: { enabled: false, mode: "repitch" } },
    ],
  });
  expect(plan.applied).toBe(true);
});

test("treats equivalent disabled audio warp endpoints as a no-op", () => {
  const base = snapshot();
  base.tracks[0].kind = "audio";
  base.clips[0].midi = undefined;
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "clip.audioWarp.set",
      clip: persisted("clip-1"),
      audioWarp: { enabled: false, mode: "repitch" },
    }],
  });
  expect(plan.applied).toBe(false);
  expect(plan.actions[0]?.changed).toBe(false);
});

test("normalizes track creation colors and projects an explicit instrument", () => {
  const plan = planControlRequestV1(snapshot(), {
    projectId: "project-1",
    actions: [{
      kind: "track.create",
      clientRef: "new-instrument",
      trackKind: "instrument",
      color: "#AbC",
    }],
  });
  const track = plan.snapshot.tracks.find((entry: ProjectSnapshotV2["tracks"][number]) => entry.id === "control:track:new-instrument");
  expect(track?.color).toBe("#aabbcc");
  expect(track?.collapsed).toBe(false);
  expect(plan.snapshot.processors.some((entry: ProjectSnapshotV2["processors"][number]) => (
    "trackId" in entry.target
    && entry.target.trackId === track?.id
    && entry.processor.kind === "instrument"
  ))).toBe(true);
});

test("rejects external routing before planning an ungroup", () => {
  const base = snapshot();
  base.tracks = [
    { ...base.tracks[0], id: "group", kind: "audio", channelRole: "group", index: 0 },
    { ...base.tracks[0], id: "child", index: 1, groupId: "group" },
    { ...base.tracks[0], id: "external", index: 2, outputTargetId: "group" },
  ];
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "track.ungroup", group: persisted("group") }],
  })).toThrow();
});

test("compacts remaining device indices before a later reorder", () => {
  const base = snapshot();
  base.processors = [
    {
      id: "instrument-1",
      target: { trackId: "track-1" },
      index: 0,
      processor: { kind: "instrument", params: { kind: "synth", instanceId: "instrument:one", params: {} } },
    },
    {
      id: "arp-1",
      target: { trackId: "track-1" },
      index: 1,
      processor: { kind: "arpeggiator", params: {} },
    },
    {
      id: "effect-1",
      target: { trackId: "track-1" },
      instanceId: "audio-effect:one",
      index: 2,
      processor: { kind: "eq", params: {} },
    },
  ];
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [
      { kind: "instrument.remove", target: { kind: "track", track: persisted("track-1") } },
      { kind: "effect.reorder", target: { kind: "track", track: persisted("track-1") }, order: [{ effect: persisted("effect-1"), kind: "eq" }] },
    ],
  });
  expect(plan.snapshot.processors.find((entry: ProjectSnapshotV2["processors"][number]) => entry.id === "effect-1")?.index).toBe(0);
});

const externalSnapshotProcessor = {
  id: "external-plugin:instance-1",
  target: { trackId: "track-1" },
  instanceId: "instance-1",
  index: 1,
  processor: {
    kind: "external-vst3",
    params: {
      identity: { name: "Fixture", vendor: "Vendor", classId: "class-1", role: "effect" },
      bypassed: false,
      parameterOverrides: { "1": 0.25, "2": 0.5 },
      parameters: [{ id: 1, readOnly: false }, { id: 2, readOnly: true }],
    },
  },
};

test("matches external automation to the projected VST3 processor identity", () => {
  const base = snapshot();
  base.processors.push(externalSnapshotProcessor);
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "automation.set",
      target: { kind: "track", track: persisted("track-1") },
      effect: persisted("external-plugin:instance-1"),
      parameterId: "vst3:instance-1:1",
      enabled: true,
      points: [],
    }],
  });
  expect(plan.applied).toBe(true);
  expect(plan.snapshot.automation).toContainEqual({
    target: { trackId: "track-1" },
    effectInstanceId: "instance-1",
    parameterId: "vst3:instance-1:1",
    enabled: true,
    points: [],
  });
  expect(() => planControlRequestV1(snapshot(), {
    projectId: "project-1",
    actions: [{
      kind: "automation.set",
      target: { kind: "track", track: persisted("track-1") },
      effect: persisted("effect-1"),
      parameterId: "vst3:instance-1:1",
      enabled: true,
      points: [],
    }],
  })).toThrow(expect.objectContaining({ code: "validation", actionIndex: 0 }));
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "automation.set",
      target: { kind: "track", track: persisted("track-1") },
      effect: persisted("external-plugin:instance-1"),
      parameterId: "vst3:other-instance:1",
      enabled: true,
      points: [],
    }],
  })).toThrow(expect.objectContaining({ code: "validation", actionIndex: 0 }));
});

test("rejects direct track deletion when the track has an external VST processor", () => {
  const base = snapshot();
  base.processors.push(externalSnapshotProcessor);
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "track.delete", track: persisted("track-1") }],
  })).toThrow("External VST processors are not currently recoverable through canonical control.");
});

test("rejects recursive group deletion when a descendant has an external VST processor", () => {
  const base = snapshot();
  base.tracks = [
    { ...base.tracks[0], id: "group", channelRole: "group", index: 0 },
    { ...base.tracks[0], id: "child", groupId: "group", index: 1 },
  ];
  base.processors = [{
    ...externalSnapshotProcessor,
    id: "external-plugin:child",
    target: { trackId: "child" },
    instanceId: "child",
  }];
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "track.delete", track: persisted("group") }],
  })).toThrow("External VST processors are not currently recoverable through canonical control.");
});

test("rejects ungrouping when the group has an external VST processor", () => {
  const base = snapshot();
  base.tracks = [
    { ...base.tracks[0], id: "group", channelRole: "group", index: 0 },
    { ...base.tracks[0], id: "child", groupId: "group", index: 1 },
  ];
  base.processors = [{
    ...externalSnapshotProcessor,
    id: "external-plugin:group",
    target: { trackId: "group" },
    instanceId: "group",
  }];
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ kind: "track.ungroup", group: persisted("group") }],
  })).toThrow("External VST processors are not currently recoverable through canonical control.");
});

test("merges external VST3 parameter overrides and preserves untouched values", () => {
  const base = snapshot();
  base.processors.push(externalSnapshotProcessor);
  const plan = planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{
      kind: "external-plugin.parameters.set",
      target: { kind: "track", track: persisted("track-1") },
      processor: persisted("external-plugin:instance-1"),
      changes: [{ parameterId: 1, normalizedValue: 0.75 }],
    }],
  });
  expect(plan.actions[0]?.changed).toBe(true);
  expect(plan.snapshot.processors.find((entry: ProjectSnapshotV2["processors"][number]) => entry.id === "external-plugin:instance-1")?.processor).toMatchObject({
    kind: "external-vst3",
    params: { parameterOverrides: { "1": 0.75, "2": 0.5 } },
  });
});

test("validates external VST3 target, kind, and writable parameter requirements", () => {
  const externalAction = {
    kind: "external-plugin.parameters.set" as const,
    target: { kind: "track" as const, track: persisted("track-1") },
    processor: persisted("external-plugin:instance-1"),
    changes: [{ parameterId: 1, normalizedValue: 0.75 }],
  };
  const base = snapshot();
  base.processors.push(externalSnapshotProcessor);
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ ...externalAction, changes: [{ parameterId: 99, normalizedValue: 0.5 }] }],
  })).toThrow(expect.objectContaining({ code: "not-found", actionIndex: 0 }));
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ ...externalAction, changes: [{ parameterId: 2, normalizedValue: 0.5 }] }],
  })).toThrow(expect.objectContaining({ code: "validation", actionIndex: 0 }));
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ ...externalAction, target: { kind: "master" as const } }],
  })).toThrow(expect.objectContaining({ code: "validation", actionIndex: 0 }));
  expect(() => planControlRequestV1(base, {
    projectId: "project-1",
    actions: [{ ...externalAction, processor: persisted("effect-1") }],
  })).toThrow(expect.objectContaining({ code: "validation", actionIndex: 0 }));
});
