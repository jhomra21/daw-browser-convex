import { expect, test } from "bun:test"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import { automationTargetKey, externalAutomationParameterId, type AutomationEnvelope } from "@daw-browser/shared"
import { nativeVstAutomationSegmentsForEnvelopes } from "./native-vst-automation"

const instanceId = "11111111-1111-4111-8111-111111111111"
const parameterId = externalAutomationParameterId(instanceId, 7)
const attachments: NativeExternalAttachmentPlan = {
  version: 1,
  attachments: [{
    instanceId,
    graphNodeId: "track",
    nativeGraphNodeId: "1",
    stageIndex: 0,
    catalogIdentity: {
      format: "vst3",
      classId: "class",
      vendorId: "vendor",
      architecture: "arm64",
      scannerCatalogVersion: 2,
    },
    bundleFingerprint: "a".repeat(64),
    binaryFingerprint: "b".repeat(64),
    role: "effect",
    inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
    outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
    workerTransport: {
      slotCount: 2,
      maximumFrames: 512,
      maximumEventsPerBlock: 128,
      inputChannels: 2,
      outputChannels: 2,
    },
    declaredLatencyFrames: 0,
    declaredTailFrames: 0,
    bypassed: false,
    stateRevision: 0,
    parameters: [{
      id: 7,
      title: "Mix",
      unit: "%",
      minimum: 0,
      maximum: 1,
      defaultValue: 0.1,
      stepCount: 100,
      readOnly: false,
      hidden: false,
    }],
    parameterOverrides: {},
  }],
}

const envelope = (enabled = true): AutomationEnvelope => ({
  id: "automation",
  projectId: "project",
  target: { kind: "track", trackId: "track" },
  targetKey: automationTargetKey({ kind: "track", trackId: "track" }, parameterId),
  parameterId,
  enabled,
  points: [
    { id: "a", timeSec: 0.5, value: 0.2, interpolation: "linear" },
    { id: "b", timeSec: 2, value: 0.8, interpolation: "hold" },
  ],
  updatedAt: 1,
})

test("clips linear VST automation to an arbitrary render range with exact boundary values", () => {
  const segments = nativeVstAutomationSegmentsForEnvelopes({
    attachments,
    automationEnvelopes: [envelope()],
    sampleRateHz: 10,
    startFrame: 10,
    endFrame: 15,
  })
  expect(segments).toHaveLength(1)
  expect(segments[0]).toMatchObject({
    instanceId,
    parameterId: 7,
    startFrame: 10,
    endFrame: 15,
    interpolation: "linear",
  })
  expect(segments[0]!.startValue).toBeCloseTo(0.4, 6)
  expect(segments[0]!.endValue).toBeCloseTo(0.6, 6)
})

test("ignores disabled and mismatched VST automation envelopes", () => {
  const mismatch = {
    ...envelope(),
    id: "mismatch",
    target: { kind: "track" as const, trackId: "other" },
  }
  expect(nativeVstAutomationSegmentsForEnvelopes({
    attachments,
    automationEnvelopes: [envelope(false), mismatch],
    sampleRateHz: 10,
    startFrame: 0,
    endFrame: 10,
  })).toEqual([])
})
