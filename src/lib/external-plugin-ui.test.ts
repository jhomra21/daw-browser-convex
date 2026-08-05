import { expect, test } from "bun:test";
import { externalProcessorSchema } from "@daw-browser/external-plugins";
import {
  externalProcessorStatusLabel,
  selectExternalProcessorsForTarget,
  vst3ScanHealthLabel,
} from "./external-plugin-ui";

const processor = (input: {
  instanceId: string;
  role: "effect" | "instrument";
  targetId: string;
  index: number;
}) => externalProcessorSchema.parse({
  instanceId: input.instanceId,
  targetId: input.targetId,
  index: input.index,
  manifest: {
    identity: {
      format: "vst3",
      classId: "class",
      vendor: "vendor",
      name: "name",
      version: "1",
      architecture: "arm64",
      binaryFingerprint: "a".repeat(64),
    },
    role: input.role,
    audioInputs: input.role === "instrument" ? [] : [{ name: "Input", channels: 2, enabled: true }],
    audioOutputs: [{ name: "Output", channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: true,
    supportsState: true,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: "ready", updatedAt: 1 },
  updatedAt: 1,
})

test("labels VST3 catalog health for the effects browser", () => {
  expect(vst3ScanHealthLabel("scanned")).toBe("Scanned");
  expect(vst3ScanHealthLabel("scan-failed")).toBe("Scan failed");
});

test("shows bypass and degraded status for inserted external effects", () => {
  expect(externalProcessorStatusLabel({
    bypassed: true,
    health: { state: "degraded", reason: "Native playback failed.", updatedAt: 1 },
  })).toBe("Bypassed · Degraded");
});

test("labels a preflighted native effect without claiming live processing", () => {
  expect(externalProcessorStatusLabel({
    bypassed: false,
    health: { state: "ready", reason: "Native VST3 preflight passed.", updatedAt: 1 },
  })).toBe("Enabled · Preflight passed");
});

test("selects effects and instruments for the selected target in chain order", () => {
  const instrument = processor({
    instanceId: "00000000-0000-4000-8000-000000000002",
    role: "instrument",
    targetId: "track-a",
    index: 2,
  })
  const effect = processor({
    instanceId: "00000000-0000-4000-8000-000000000001",
    role: "effect",
    targetId: "track-a",
    index: 1,
  })
  const otherTarget = processor({
    instanceId: "00000000-0000-4000-8000-000000000003",
    role: "effect",
    targetId: "track-b",
    index: 0,
  })

  expect(selectExternalProcessorsForTarget([instrument, otherTarget, effect], "track-a")).toEqual([effect, instrument])
})
