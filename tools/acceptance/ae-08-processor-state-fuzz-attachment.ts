import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import { nativeGraphNodeId } from "@daw-browser/audio-engine/native-host-wire"

export const attachmentInstanceId = "11111111-1111-4111-8111-111111111111"
// Native external latency is declared latency plus one worker transport block
// (native-offline-render-plan.ts nativeExternalLatencyFrames).
export const workerTransportFrames = 512
export default function attachmentPlan(latencyFrames: number): NativeExternalAttachmentPlan {
  return {
    version: 1,
    attachments: [{
      instanceId: attachmentInstanceId, graphNodeId: "track", nativeGraphNodeId: nativeGraphNodeId("track").toString(), stageIndex: 0,
      catalogIdentity: { format: "vst3", classId: "class", vendorId: "vendor", architecture: "arm64", scannerCatalogVersion: 2 },
      bundleFingerprint: "a".repeat(64), binaryFingerprint: "b".repeat(64), role: "effect",
      inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
      outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
      workerTransport: { slotCount: 2, maximumFrames: workerTransportFrames, maximumEventsPerBlock: 128, inputChannels: 2, outputChannels: 2 },
      declaredLatencyFrames: latencyFrames, declaredTailFrames: null, bypassed: false, stateRevision: 0,
      parameters: [], parameterOverrides: {},
    }],
  }
}
