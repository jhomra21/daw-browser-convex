import { expect, test } from "bun:test";

import { controlCapabilitiesSchemaV1, controlCapabilitiesSchemaV2, controlLimitsV1, controlLimitsV2 } from "./versions";

const v1LimitFields = [
  "maxActions", "maxSerializedBodyBytes", "maxRecoveryEntities", "maxRecoveryMappings",
  "maxRecoveryMidiNotes", "maxRecoveryAutomationPoints", "maxRecoveryWarpMarkers", "maxRecoverySends",
  "maxAssetsPerSnapshot", "maxAssetFoldersPerSnapshot", "maxAssetUploadBytes", "maxAssetUploadRequestBytes",
  "maxMidiNotesPerCommit", "maxAutomationPointsPerCommit", "maxErrorDetails", "defaultHistoryPageSize",
  "maxHistoryPageSize", "defaultRecoveryPageSize", "maxRecoveryPageSize",
];

const v2OnlyLimitFields = [
  "maxMidiPerformanceEventsPerCommit", "maxMidiPerformanceEventsPerClip", "maxMidiEventsPerArray", "maxMidiMappingsPerClip",
];

test("capability limit fields keep their names and order across versions", () => {
  expect(Object.keys(controlCapabilitiesSchemaV1.shape.limits.shape)).toEqual(v1LimitFields);
  expect(Object.keys(controlCapabilitiesSchemaV2.shape.limits.shape)).toEqual([...v1LimitFields, ...v2OnlyLimitFields]);
  expect(Object.keys(controlLimitsV1)).toEqual(v1LimitFields);
  expect(Object.keys(controlLimitsV2)).toEqual([...v1LimitFields, ...v2OnlyLimitFields]);
});
