import type {
  NativeHostDeviceConfiguration,
  NativeHostPcmAsset,
  NativeHostRecordingBlock,
  NativeHostRecordingConfiguration,
  NativeHostRecordingStatus,
  NativeHostTransport,
  NativeInputDevice,
  NativeOutputDevice,
} from "@daw-browser/audio-engine/native-host-wire"

type NativeSessionReply = { ok: true } | { ok: false; error: string }

type NativeSessionBridge = {
  configure(input: NativeHostDeviceConfiguration): Promise<NativeSessionReply>
  beginTransaction(): Promise<NativeSessionReply>
  commitTransaction(): Promise<NativeSessionReply>
  rollbackTransaction(): Promise<NativeSessionReply>
  detachVst(instanceId: string): Promise<NativeSessionReply>
  installAsset(input: NativeHostPcmAsset): Promise<NativeSessionReply>
  releaseAsset(sessionAssetId: number): Promise<NativeSessionReply>
  publishGraph(bytes: Uint8Array): Promise<NativeSessionReply>
  queueParameterEvents(bytes: Uint8Array): Promise<NativeSessionReply>
  queueInstrumentEvents(bytes: Uint8Array): Promise<NativeSessionReply>
  queueSourceEvents(bytes: Uint8Array): Promise<NativeSessionReply>
  setTransport(input: NativeHostTransport): Promise<NativeSessionReply>
  configureRecording(input: NativeHostRecordingConfiguration): Promise<NativeSessionReply>
  startRecording(): Promise<NativeSessionReply>
  stopRecording(stopFrame?: number): Promise<NativeSessionReply>
  cancelRecording(): Promise<NativeSessionReply>
  start(): Promise<NativeSessionReply>
  stop(): Promise<NativeSessionReply>
  teardown(): Promise<NativeSessionReply>
  onLoss(listener: () => void): () => void
  onRecordingBlock(listener: (block: NativeHostRecordingBlock) => void): () => void
  onRecordingStatus(listener: (status: NativeHostRecordingStatus) => void): () => void
}

type NativeOutputDeviceReply = { ok: true; device: NativeOutputDevice | null } | { ok: false; error: string }
type NativeInputDeviceReply = { ok: true; device: NativeInputDevice | null } | { ok: false; error: string }
type NativeReleaseArtifactVerification =
  | { status: "disabled" | "development" | "verified" }
  | { status: "failed"; reason: string }
type NativeAudioHostDiagnosticsReply = (
  | { ok: true }
  | { ok: false; error: string }
) & { artifactVerification: NativeReleaseArtifactVerification }

type DesktopBridge = {
  audioHost?: {
    diagnostics(): Promise<NativeAudioHostDiagnosticsReply>
    resolveOutputDevice(preferredDeviceId?: string): Promise<NativeOutputDeviceReply>
    resolveInputDevice(preferredDeviceId?: string): Promise<NativeInputDeviceReply>
    session: NativeSessionBridge
  }
}

declare global {
  // Declaration merging requires an interface for the DOM Window surface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Window {
    dawDesktop?: DesktopBridge
  }
}
