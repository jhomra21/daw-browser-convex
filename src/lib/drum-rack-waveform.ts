import { getAudioBufferSessionIdentity } from "@daw-browser/audio-engine/media-pages"

export const SAMPLE_WAVEFORM_BINS = 360

export const sampleWaveformFramesPerInterval = (frameCount: number) => (
  Math.max(1, Math.ceil(frameCount / SAMPLE_WAVEFORM_BINS))
)

export const getDrumRackWaveformBufferIdentity = (buffer: AudioBuffer | undefined) => (
  buffer ? getAudioBufferSessionIdentity(buffer) : "missing"
)
