import type { NativeHostRecordingStatus } from "@daw-browser/audio-engine/native-host-wire"
import { assessRecordedAudioContent } from "./recorded-audio-content"

type SavedClip = { id: string; trackId: string; duration: number; source?: { sourceKind: string; assetId?: string } }
export const observeSavedSpoolClip = <Asset extends { id: string; sourceKind: string }>(input: {
  beforeClips: readonly { id: string }[]; clips: readonly SavedClip[]; assets: readonly Asset[]; trackId: string;
  savedClip?: { clipId: string; sourceAssetKey: string };
}) => {
  const before = new Set(input.beforeClips.map((clip) => clip.id))
  const clips = input.clips.filter((clip) => !before.has(clip.id) && clip.trackId === input.trackId
    && clip.duration > 0 && clip.source?.sourceKind === "recording")
  const clip = clips[0]
  if (clips.length !== 1 || !clip) throw new Error("Exactly one new saved recording clip is required.")
  const asset = input.assets.find((asset) => asset.id === clip.source?.assetId)
  if (!asset || asset.sourceKind !== "recording"
    || (input.savedClip && (input.savedClip.clipId !== clip.id || input.savedClip.sourceAssetKey !== asset.id)))
    throw new Error("Saved recording clip/asset acknowledgment mismatch.")
  return { clip, asset }
}

export type SpoolProof = { frames: number; bytes: number; blocks: number; sampleRateHz: number; channelCount: number }
export type SpoolReleaseEvidence = {
  calls: number; succeeded: boolean; savedClipObserved: boolean; assetObserved: boolean;
  sourcePresentBefore: boolean; sourceAbsentAfter: boolean; receiptPresent: boolean;
  receiptBeforeSourceUnlinkObserved: boolean; proofVerified: boolean;
  acknowledgmentFinalized: boolean; acknowledgmentMatchesProof: boolean;
  receiptMatchesAcknowledgment: boolean; listMatchesPreRecordAfter: boolean;
}
const nativeStatusFailures = (status: Omit<NativeHostRecordingStatus, "generation" | "sessionId" | "timelineFrame" | "rms" | "peak">) => [
  status.fatal || status.droppedFrames !== 0 || status.droppedBlocks !== 0 ? "native-drop-or-fatal" : null,
  status.availableBlocks < 0 || status.availableBlocks > 32 || status.queuedBlocks < 0
    || status.queuedBlocks > 32 || status.availableBlocks + status.queuedBlocks > 32 ? "native-pool" : null,
  !status.spool || status.spool.error !== 0 || status.spool.systemError !== 0 ? "native-spool-error" : null,
].filter((issue) => issue !== null)
export const assessSpoolProductDialog = (text: string) => text.trim() ? ["product-failure-dialog"] : []
export const assessSpoolNativeIntegrity = (samples: readonly {
  status: string; artifactVerification?: { status: string };
  diagnostics?: { rejectedBlocks: number; callbacks: number;
    vstWorkerPerformance?: { faults: string; watchdogMisses: string; restarts: string } | null };
}[], incidents: number) => {
  const first = samples[0]?.diagnostics?.callbacks
  const last = samples.at(-1)?.diagnostics?.callbacks
  return [
    samples.length < 2 || samples.some((sample) => sample.status !== "available"
      || sample.artifactVerification?.status !== "verified" || sample.diagnostics?.rejectedBlocks !== 0) ? "native-artifact-integrity" : null,
    samples.some((sample) => sample.diagnostics?.vstWorkerPerformance?.faults !== "0"
      || sample.diagnostics?.vstWorkerPerformance?.watchdogMisses !== "0"
      || sample.diagnostics?.vstWorkerPerformance?.restarts !== "0") ? "vst-fault-watchdog-restart" : null,
    first === undefined || last === undefined || last <= first ? "native-callback-progress" : null,
    incidents !== 0 ? "native-worker-incident" : null,
  ].filter((issue) => issue !== null)
}
type Status = Parameters<typeof nativeStatusFailures>[0]
export const assessSpoolCapture = (transport: string | null, status: Status | null) => [
  transport !== "native-spool" ? "native-spool-transport" : null,
  !status || !status.active || status.capturedFrames <= 0 || status.spool?.state !== 1 ? "native-status" : null,
  ...(status ? nativeStatusFailures(status) : []),
].filter((issue) => issue !== null)
export const assessSpoolCompletion = (status: Status | null, proof: SpoolProof | null, release: SpoolReleaseEvidence) => {
  const spool = status?.spool
  return [
    !status || status.active || status.queuedBlocks !== 0
      || !spool?.published || spool.partialRetained || spool.state !== 2 ? "complete-status" : null,
    ...(status ? nativeStatusFailures(status) : []),
    !spool || status?.capturedFrames !== spool.writtenFrames ? "captured-written" : null,
    !proof ? "complete-proof" : null,
    proof && (!Number.isSafeInteger(proof.frames) || proof.frames <= 0 || proof.blocks < 1
      || proof.frames > proof.blocks * 2048 || proof.blocks > proof.frames
      || proof.bytes !== 4 * proof.blocks + 4 * proof.frames * proof.channelCount
      || proof.frames !== spool?.writtenFrames || proof.bytes !== spool?.writtenBytes
      || proof.blocks !== spool?.writtenBlocks || proof.sampleRateHz !== spool?.sampleRateHz
      || proof.channelCount !== spool?.channelCount || (proof.channelCount !== 1 && proof.channelCount !== 2)) ? "proof-totals" : null,
    release.calls !== 1 ? "release-count" : null,
    ...Object.entries(release).filter(([key, value]) => key !== "calls" && value !== true).map(([key]) => `release-${key}`),
  ].filter((issue) => issue !== null)
}
export const spoolObservationLimit = (bytes: number) => {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid observation size.")
  const mib = Math.ceil(bytes / (1024 * 1024))
  return { timeoutMs: Math.min(180000, 30000 + mib * 1000),
    reason: `30 s fixed filesystem/encode/commit observation plus 1 s per ${mib} MiB of proven native input, capped at 180 s; this is a runner observation limit, not native Finish cancellation.` }
}
export const assessNativeSpoolAsset = (
  asset: Parameters<typeof assessRecordedAudioContent>[0],
  content: Parameters<typeof assessRecordedAudioContent>[1], proof: SpoolProof,
) => [
  ...assessRecordedAudioContent(asset, content, proof.frames, proof.sampleRateHz),
  content.frames !== proof.frames ? "frames" : null,
  content.channels !== proof.channelCount ? "channels" : null,
].filter((issue) => issue !== null)
