const flag = (name: string) => () => process.env[name] === "1"
const text = (name: string) => () => process.env[name]

// Every DAW_* variable the desktop app reads from its own process environment, with its parse rule.
// Reads are lazy so a value set after import is still seen.
export const desktopEnv = {
  benchmarkHeartbeat: flag("DAW_BENCHMARK_HEARTBEAT"),
  benchmarkQuietCapture: flag("DAW_BENCHMARK_QUIET_CAPTURE"),
  benchmarkSabRecording: flag("DAW_BENCHMARK_SAB_RECORDING"),
  benchmarkStartupTrace: text("DAW_BENCHMARK_STARTUP_TRACE"),
  benchmarkStartupTraceEnabled: flag("DAW_BENCHMARK_STARTUP_TRACE"),
  benchmarkZoomProfile: flag("DAW_BENCHMARK_ZOOM_PROFILE"),
  ae08ExternalNativeSession: flag("DAW_AE08_EXTERNAL_NATIVE_SESSION"),
  ae08EvidenceDirectory: text("DAW_AE08_EVIDENCE_DIR"),
  ae08Trace: flag("DAW_AE08_TRACE"),
  diagnosticsV2Trace: flag("DAW_DIAGNOSTICS_V2_TRACE"),
  recordingStartDiagnostic: flag("DAW_RECORDING_START_DIAGNOSTIC"),
  recordingStartEvidence: flag("DAW_RECORDING_START_EVIDENCE"),
  recordingSpoolOrderEvidence: text("DAW_RECORDING_SPOOL_ORDER_EVIDENCE"),
  vst3ScannerPath: text("DAW_VST3_SCANNER_PATH"),
  vst3WorkerPath: text("DAW_VST3_WORKER_PATH"),
  audioHostPath: text("DAW_AUDIO_HOST_PATH"),
  nativeArtifactManifestPath: text("DAW_NATIVE_ARTIFACT_MANIFEST_PATH"),
  forgeNode: text("DAW_FORGE_NODE"),
}
