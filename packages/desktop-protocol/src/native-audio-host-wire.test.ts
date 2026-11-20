import { expect, test } from "bun:test"
import { resolve } from "node:path"
import * as host from "./native-audio-host"

// The numbers below are the wire the shipped host speaks. Changing one is a protocol change, so it is a deliberate edit here.
test("the host protocol constants keep their wire values", () => {
  expect({
    magic: host.nativeAudioHostMagic,
    version: host.nativeAudioHostProtocolVersion,
    artifactId: host.nativeAudioHostArtifactId,
    capabilities: host.nativeAudioHostRequiredCapabilities,
    frameHeader: host.nativeAudioHostFrameHeaderBytes,
    graphFrameHeader: host.nativeAudioHostNativeGraphFrameHeaderBytes,
    payload: host.nativeAudioHostMaximumPayloadBytes,
    serializedPlan: host.nativeAudioHostMaximumSerializedPlanBytes,
    deviceId: host.nativeAudioHostMaximumDeviceIdBytes,
    assetChannels: host.nativeAudioHostMaximumAssetChannels,
    assetFrames: host.nativeAudioHostMaximumAssetFrames,
    installedAssets: host.nativeAudioHostMaximumInstalledAssets,
    assetInstallHeader: host.nativeAudioHostAssetInstallHeaderBytes,
    mappedPageHeader: host.nativeAudioHostMappedAssetPageHeaderBytes,
    mappedRanges: host.nativeAudioHostMaximumMappedAssetRanges,
    page: host.nativeAudioHostPageBytes,
    meterEntries: host.nativeAudioHostMaximumMeterEntries,
    spectrumBins: host.nativeAudioHostMaximumSpectrumBins,
    vstString: host.nativeAudioHostMaximumVstStringBytes,
    vstPath: host.nativeAudioHostMaximumVstPathBytes,
    fingerprint: host.nativeAudioHostVstAttachFingerprintBytes,
    scheduleChunks: host.nativeAudioHostMaximumScheduleChunks,
    scheduleRecords: host.nativeAudioHostMaximumScheduleRecords,
    automationSegments: host.nativeAudioHostMaximumScheduleAutomationSegments,
    processorEvents: host.nativeAudioHostMaximumProcessorEvents,
    instrumentEvents: host.nativeAudioHostMaximumInstrumentEvents,
    sourceEvents: host.nativeAudioHostMaximumSourceEvents,
    scheduleInstanceId: host.nativeAudioHostMaximumScheduleInstanceIdBytes,
    scheduleProgress: host.nativeAudioHostScheduleProgressBytes,
    patchStatus: host.nativeAudioHostProcessorPatchStatusBytes,
  }).toEqual({
    magic: 0x44415748,
    version: 30,
    artifactId: "daw-audio-host-macos/v10",
    capabilities: 0x3ff,
    frameHeader: 16,
    graphFrameHeader: 12,
    payload: 1_048_576,
    serializedPlan: 1_048_576,
    deviceId: 4_096,
    assetChannels: 64,
    assetFrames: 262_144,
    installedAssets: 64,
    assetInstallHeader: 24,
    mappedPageHeader: 16,
    mappedRanges: 256,
    page: 16_384,
    meterEntries: 64,
    spectrumBins: 1_024,
    vstString: 256,
    vstPath: 4_096,
    fingerprint: 32,
    scheduleChunks: 16,
    scheduleRecords: 2_048,
    automationSegments: 2_048,
    processorEvents: 256,
    instrumentEvents: 256,
    sourceEvents: 256,
    scheduleInstanceId: 256,
    scheduleProgress: 112,
    patchStatus: 20,
  })
})

test("the host status tables keep their wire codes", () => {
  expect(host.nativeAudioHostLifecycleStates).toEqual({ idle: 0, configured: 1, running: 2, faulted: 3 })
  expect(Object.values(host.nativeAudioHostReadinessReasons)).toEqual([0, 1, 2, 3])
  expect(Object.values(host.nativeAudioHostRejectedBlockReasons)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(Object.values(host.nativeAudioHostRevisionStatusCodes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  expect(Object.values(host.nativeAudioHostRevisionContinuities)).toEqual([0, 1, 2, 3])
  expect(Object.values(host.nativeAudioHostNotificationKinds)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(host.nativeAudioHostPatchOutcomes).toEqual({ applied: 1, refused: 2, claimed: 3 })
  expect(Object.values(host.nativeAudioHostPatchRefusals)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(host.nativeAudioHostSpoolStates).toEqual({ preparing: 0, ready: 1, complete: 2, failed: 3, cancelled: 4 })
  expect(Object.values(host.nativeAudioHostControlTypes)).toEqual(Array.from({ length: 63 }, (_, index) => index + 1))
})

test("a wire code resolves to its table name and unknown codes resolve to nothing", () => {
  expect(host.nativeAudioHostCodeName(host.nativeAudioHostRevisionStatusCodes, 13)).toBe("capture-target-locked")
  expect(host.nativeAudioHostCodeName(host.nativeAudioHostRevisionStatusCodes, 0)).toBeUndefined()
  expect(host.nativeAudioHostCodeName(host.nativeAudioHostLifecycleStates, 4)).toBeUndefined()
})

test("the generated C++ headers are current", () => {
  const output = Bun.spawnSync({
    cmd: ["bun", "packages/desktop-protocol/scripts/generate-native-contracts.ts", "--check"],
    cwd: resolve(import.meta.dir, "../../.."),
    stderr: "pipe",
  })

  expect(output.stderr.toString()).toBe("")
  expect(output.exitCode).toBe(0)
})
