export const nativeAudioHostMagic = 0x44415748
export const nativeAudioHostProtocolVersion = 12
export const nativeAudioHostFrameHeaderBytes = 16
export const nativeAudioHostMaximumPayloadBytes = 1_048_576
export const nativeAudioHostMaximumMeterEntries = 64
export const nativeAudioHostMaximumSpectrumBins = 1024
export const nativeAudioHostMaximumSpectrumPayloadBytes = 8_192

export const nativeAudioHostControlTypes = {
  hostHello: 1,
  hostCapabilities: 2,
  deviceConfigure: 3,
  graphSnapshot: 4,
  assetInstall: 5,
  assetRelease: 6,
  transport: 7,
  parameterEvents: 8,
  midiEvents: 9,
  vstAttach: 10,
  vstDetach: 11,
  diagnostics: 12,
  ack: 13,
  notification: 14,
  start: 15,
  stop: 16,
  teardown: 17,
  sourceEvents: 18,
  deviceList: 19,
  transactionBegin: 20,
  transactionCommit: 21,
  transactionRollback: 22,
  vstParameterEvents: 23,
  vstMidiEvents: 24,
  vstStateSet: 25,
  vstStateGet: 26,
  vstState: 27,
  recordingConfigure: 28,
  recordingStart: 29,
  recordingStop: 30,
  recordingCancel: 31,
  recordingBlock: 32,
  recordingStatus: 33,
  recordingDeviceQuery: 34,
  recordingDeviceList: 35,
  graphPrepare: 36,
  graphPublish: 37,
  graphRetire: 38,
  graphRollback: 39,
  graphRevisionStatus: 40,
  vstEditor: 41,
  vstEditorStatus: 42,
  diagnosticStart: 43,
  meterBatch: 44,
  scheduleWindow: 45,
  scheduleProgress: 46,
  vstScheduleAutomationEnable: 47,
  instrumentStates: 48,
  spectrumSelection: 49,
  spectrumFrame: 50,
} as const

export const nativeAudioHostMaximumDeviceIdBytes = 4_096
export const nativeAudioHostAssetInstallHeaderBytes = 24
export const nativeAudioHostMaximumAssetChannels = 64
export const nativeAudioHostMaximumAssetFrames = 262_144
export const nativeAudioHostMaximumVstStringBytes = 256
export const nativeAudioHostMaximumVstPathBytes = 4_096
export const nativeAudioHostVstAttachFingerprintBytes = 32
export const nativeAudioHostMaximumScheduleChunks = 16
export const nativeAudioHostMaximumScheduleRecords = 2_048
export const nativeAudioHostMaximumScheduleAutomationSegments = 2_048
export const nativeAudioHostMaximumScheduleInstanceIdBytes = 256
export const nativeAudioHostScheduleWindowHeaderBytes = 56
export const nativeAudioHostScheduleProgressBytes = 72
