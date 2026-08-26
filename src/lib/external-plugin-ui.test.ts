import { expect, test } from "bun:test";
import { externalProcessorSchema } from "@daw-browser/external-plugins";
import {
  canUseVst3CatalogAction,
  classifyNativeVst3PlaybackFault,
  externalProcessorStatusLabel,
  hasVst3TrustAcknowledgement,
  saveVst3TrustAcknowledgement,
  selectExternalProcessorsForTarget,
  vst3ScanHealthLabel,
  vst3TrustAcknowledgementStorageKey,
  vst3TrustDisclosure,
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

test("requires and persists explicit VST3 trust acknowledgement", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };

  expect(hasVst3TrustAcknowledgement(storage)).toBeFalse();
  saveVst3TrustAcknowledgement(storage);
  expect(values.get(vst3TrustAcknowledgementStorageKey)).toBe("true");
  expect(hasVst3TrustAcknowledgement(storage)).toBeTrue();
  expect(vst3TrustDisclosure.body).toContain("not a security sandbox");
});

test("gates scanner-capable catalog actions but keeps reading and removal available", () => {
  expect(canUseVst3CatalogAction("read", false)).toBeTrue();
  expect(canUseVst3CatalogAction("remove-directory", false)).toBeTrue();
  expect(canUseVst3CatalogAction("add-directory", false)).toBeFalse();
  expect(canUseVst3CatalogAction("scan", false)).toBeFalse();
  expect(canUseVst3CatalogAction("scan", true)).toBeTrue();
});

test("classifies only the exact stale native VST3 playback fault as recoverable", () => {
  expect(classifyNativeVst3PlaybackFault(
    "A native VST3 attachment is stale or no longer trusted.",
  )).toBe("launch-authorization-required");
  expect(classifyNativeVst3PlaybackFault(
    'Native VST3 attachment "instance" is stale or untrusted.',
  )).toBeUndefined();
  expect(classifyNativeVst3PlaybackFault("The native VST3 worker could not start.")).toBeUndefined();
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
