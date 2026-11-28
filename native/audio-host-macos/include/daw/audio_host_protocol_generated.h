#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace daw::audio_host_macos {

constexpr std::uint32_t kFrameMagic = 0x44415748U;
constexpr std::uint32_t kControlProtocolVersion = 31;
constexpr std::string_view kArtifactId = "daw-audio-host-macos/v10";
constexpr std::uint32_t kHostCapabilities = 0x000003ffU;
constexpr std::size_t kControlFrameHeaderBytes = 16;
constexpr std::size_t kNativeGraphFrameHeaderBytes = 12;
constexpr std::size_t kMaximumControlPayloadBytes = 1048576;
constexpr std::size_t kMaximumSerializedPlanBytes = 1048576;
constexpr std::size_t kMaximumDeviceIdBytes = 4096;
constexpr std::uint32_t kMaximumAssetChannels = 64;
constexpr std::uint32_t kMaximumAssetFrames = 262144;
constexpr std::size_t kMaximumInstalledAssets = 64;
constexpr std::size_t kAssetInstallHeaderBytes = 24;
constexpr std::size_t kMappedAssetPageHeaderBytes = 16;
constexpr std::size_t kMaximumMappedAssetWrittenRanges = 256;
constexpr std::size_t kHostPageBytes = 16384;
constexpr std::size_t kMaximumMeterEntries = 64;
constexpr std::size_t kMaximumSpectrumBins = 1024;
constexpr std::size_t kMaximumVstStringBytes = 256;
constexpr std::size_t kMaximumVstPathBytes = 4096;
constexpr std::size_t kVstAttachFingerprintBytes = 32;
constexpr std::size_t kMaximumScheduleChunks = 16;
constexpr std::size_t kMaximumScheduleRecords = 2048;
constexpr std::size_t kMaximumScheduleAutomationSegments = 2048;
constexpr std::size_t kMaximumProcessorEvents = 256;
constexpr std::size_t kMaximumInstrumentEvents = 256;
constexpr std::size_t kMaximumSourceEvents = 256;
constexpr std::size_t kMaximumScheduleInstanceIdBytes = 256;
constexpr std::size_t kScheduleProgressBytes = 112;
constexpr std::size_t kProcessorPatchStatusBytes = 20;

constexpr std::string_view kAssetRefusalInvalidAsset = "invalid-asset";
constexpr std::string_view kAssetRefusalInvalidAssetPage = "invalid-asset-page";
constexpr std::string_view kAssetRefusalPublicationPending = "asset-publication-pending";
constexpr std::string_view kAssetRefusalIdentityConflict = "asset-identity-conflict";
constexpr std::string_view kAssetRefusalPageIdentityConflict = "asset-page-identity-conflict";
constexpr std::string_view kAssetRefusalCapacityExceeded = "asset-capacity-exceeded";
constexpr std::string_view kAssetRefusalPageCapacityExceeded = "asset-page-capacity-exceeded";

enum class ControlType : std::uint32_t {
  kHostHello = 1,
  kHostCapabilities = 2,
  kDeviceConfigure = 3,
  kGraphSnapshot = 4,
  kAssetInstall = 5,
  kAssetRelease = 6,
  kTransport = 7,
  kParameterEvents = 8,
  kMidiEvents = 9,
  kVstAttach = 10,
  kVstDetach = 11,
  kDiagnostics = 12,
  kAck = 13,
  kNotification = 14,
  kStart = 15,
  kStop = 16,
  kTeardown = 17,
  kSourceEvents = 18,
  kDeviceList = 19,
  kTransactionBegin = 20,
  kTransactionCommit = 21,
  kTransactionRollback = 22,
  kVstParameterEvents = 23,
  kVstMidiEvents = 24,
  kVstStateSet = 25,
  kVstStateGet = 26,
  kVstState = 27,
  kRecordingConfigure = 28,
  kRecordingStart = 29,
  kRecordingStop = 30,
  kRecordingCancel = 31,
  kRecordingBlock = 32,
  kRecordingStatus = 33,
  kRecordingDeviceQuery = 34,
  kRecordingDeviceList = 35,
  kGraphPrepare = 36,
  kGraphPublish = 37,
  kGraphRetire = 38,
  kGraphRollback = 39,
  kGraphRevisionStatus = 40,
  kVstEditor = 41,
  kVstEditorStatus = 42,
  kDiagnosticStart = 43,
  kMeterBatch = 44,
  kScheduleWindow = 45,
  kScheduleProgress = 46,
  kVstScheduleAutomationEnable = 47,
  kInstrumentStates = 48,
  kSpectrumSelection = 49,
  kSpectrumFrame = 50,
  kProcessorStatePatch = 51,
  kOfflineConfigure = 52,
  kOfflineStart = 53,
  kOfflinePcmChunk = 54,
  kOfflineComplete = 55,
  kOfflineError = 56,
  kMappedAssetCreate = 57,
  kMappedAssetWritePage = 58,
  kMappedAssetPrepareRange = 59,
  kMappedAssetRelease = 60,
  kProcessorStatePatchStatus = 61,
  kDeviceInventoryQuery = 62,
  kDeviceInventory = 63,
  kCpuLoadQuery = 64,
  kCpuLoad = 65,
};

// The status word of a ControlType::kAck; the ACK text is for people and is never classified.
enum class ControlAckStatus : std::uint32_t {
  kRefused = 0,
  kAccepted = 1,
  kUnavailable = 2,
};

enum class LifecycleState : std::uint32_t {
  kIdle = 0,
  kConfigured = 1,
  kRunning = 2,
  kFaulted = 3,
};

enum class DeviceReadinessReason : std::uint32_t {
  kReady = 0,
  kDeviceNotConfigured = 1,
  kGraphNotPrepared = 2,
  kTransportNotPrepared = 3,
};

enum class RejectedBlockReason : std::uint32_t {
  kNone = 0,
  kNotRunningOrCoreUnavailable = 1,
  kInsufficientChannels = 2,
  kNullChannel = 3,
  kTransport = 4,
  kScratchCapacity = 5,
  kProcessorEventCapacity = 6,
  kInstrumentEventCapacity = 7,
  kSourceSchedule = 8,
  kCoreProcess = 9,
};

enum class GraphRevisionStatusCode : std::uint32_t {
  kPrepared = 1,
  kPublished = 2,
  kRetired = 3,
  kRolledBack = 4,
  kStaleRevision = 5,
  kInvalidRevision = 6,
  kPrepareFailed = 7,
  kPublishFailed = 8,
  kRetirementNotSafe = 9,
  kRetirementCapacityExceeded = 10,
  kPublishPending = 11,
  kRebaseRequired = 12,
  kCaptureTargetLocked = 13,
};

enum class GraphRevisionContinuity : std::uint32_t {
  kNotEvaluated = 0,
  kAccepted = 1,
  kFallback = 2,
  kRejected = 3,
};

enum class WorkerNotificationKind : std::uint32_t {
  kLatency = 1,
  kBuses = 2,
  kRestart = 3,
  kFault = 4,
  kMiss = 5,
  kEditorInteraction = 6,
  kParameterEdit = 7,
  kTail = 8,
  kEditorState = 9,
};

enum class ProcessorPatchOutcome : std::uint32_t {
  kApplied = 1,
  kRefused = 2,
  kClaimed = 3,
};

enum class ProcessorPatchRefusal : std::uint32_t {
  kNone = 0,
  kUnavailable = 1,
  kPreparing = 2,
  kClaimPending = 3,
  kInvalid = 4,
  kStaleRevision = 5,
  kStageFailed = 6,
  kNotClaimed = 7,
  kApplyFailed = 8,
};

enum class NativeVstEditorCommand : std::uint32_t {
  kOpen = 1,
  kClose = 2,
  kFocus = 3,
  kResize = 4,
  kStatus = 5,
};

}
