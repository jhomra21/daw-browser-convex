export type SampledInstrumentBuffer = {
  buffer: AudioBuffer
  sourceStartFrame: number
  sourceIdentity?: string
}

export type SampledInstrumentSource = {
  durationSec: number
  sampleRate: number
  channelCount: number
}

export type SampledInstrumentSample = {
  assetKey: string
  url: string
  sourceKind: 'upload' | 'url' | 'recording'
  source: SampledInstrumentSource
}

export type SampledInstrumentRegion = {
  sourceStartFrame: number
  sourceEndFrame: number
}

const validSafeInteger = (value: number) => Number.isSafeInteger(value)

export const sourceFrameCount = (source: SampledInstrumentSource) => {
  if (!Number.isFinite(source.durationSec) || source.durationSec < 0
    || !validSafeInteger(source.sampleRate) || source.sampleRate <= 0
    || !validSafeInteger(source.channelCount) || source.channelCount <= 0) {
    throw new Error('Sampled instrument source metadata is invalid.')
  }
  const frames = Math.round(source.durationSec * source.sampleRate)
  if (!validSafeInteger(frames) || frames < 0) throw new Error('Sampled instrument source duration is outside the safe frame range.')
  return frames
}

export const sampledInstrumentRegion = (
  source: SampledInstrumentSource,
  startSec: number,
  endSec = source.durationSec,
): SampledInstrumentRegion => {
  const totalFrames = sourceFrameCount(source)
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new Error('Sampled instrument region bounds are invalid.')
  }
  const startFrame = Math.round(startSec * source.sampleRate)
  const sourceEndFrame = Math.round(endSec * source.sampleRate)
  if (!validSafeInteger(startFrame) || !validSafeInteger(sourceEndFrame)
    || startFrame < 0 || sourceEndFrame > totalFrames || sourceEndFrame <= startFrame) {
    throw new Error('Sampled instrument region bounds exceed the source.')
  }
  return { sourceStartFrame: startFrame, sourceEndFrame }
}

export const sampledInstrumentRegionFrameCount = (region: SampledInstrumentRegion) => {
  const frameCount = region.sourceEndFrame - region.sourceStartFrame
  if (!validSafeInteger(region.sourceStartFrame) || !validSafeInteger(region.sourceEndFrame)
    || region.sourceStartFrame < 0 || frameCount <= 0 || !validSafeInteger(frameCount)) {
    throw new Error('Sampled instrument region frame bounds are invalid.')
  }
  return frameCount
}

export const sampledInstrumentRegionBytes = (
  region: SampledInstrumentRegion,
  channelCount: number,
) => {
  if (!validSafeInteger(channelCount) || channelCount <= 0) throw new Error('Sampled instrument channel count is invalid.')
  const bytes = sampledInstrumentRegionFrameCount(region) * channelCount * Float32Array.BYTES_PER_ELEMENT
  if (!validSafeInteger(bytes)) throw new Error('Sampled instrument region byte count is outside the safe integer range.')
  return bytes
}

export const sampledInstrumentRetainedBytes = (
  decodedBytes: number,
  mirrors: number,
) => {
  if (!validSafeInteger(decodedBytes) || decodedBytes < 0
    || !validSafeInteger(mirrors) || mirrors < 1) {
    throw new Error('Sampled instrument retained byte count is invalid.')
  }
  const bytes = decodedBytes * mirrors
  if (!validSafeInteger(bytes)) throw new Error('Sampled instrument retained byte count is outside the safe integer range.')
  return bytes
}

const encodedIdentityField = (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${bytes.byteLength}:${encoded}`
}

export const sampledInstrumentRegionIdentity = (
  sample: SampledInstrumentSample,
  region: SampledInstrumentRegion,
) => {
  if (!sample.assetKey || !sample.url || !sample.sourceKind) {
    throw new Error('Sampled instrument sample identity is incomplete.')
  }
  const frameCount = sourceFrameCount(sample.source)
  sampledInstrumentRegionFrameCount(region)
  return [
    'sampled-region:v2',
    sample.assetKey,
    sample.url,
    sample.sourceKind,
    sample.source.durationSec.toString(),
    sample.source.sampleRate.toString(),
    sample.source.channelCount.toString(),
    frameCount.toString(),
    region.sourceStartFrame.toString(),
    region.sourceEndFrame.toString(),
  ].map(encodedIdentityField).join(':')
}

export const sampledInstrumentBufferIdentity = (
  sample: SampledInstrumentSample,
  region: SampledInstrumentRegion,
) => sampledInstrumentRegionIdentity(sample, region)

export const localizeSampledInstrumentFrame = (
  sourceFrame: number,
  region: SampledInstrumentRegion,
) => {
  sampledInstrumentRegionFrameCount(region)
  if (!validSafeInteger(sourceFrame)
    || sourceFrame < region.sourceStartFrame
    || sourceFrame > region.sourceEndFrame) {
    throw new Error('Sampled instrument frame is outside the region.')
  }
  return sourceFrame - region.sourceStartFrame
}

export const sourceEndFrameForSampledInstrumentBuffer = (
  sampled: SampledInstrumentBuffer,
) => sampled.sourceStartFrame + sampled.buffer.length

export const sampledInstrumentRegionForBuffer = (
  sampled: SampledInstrumentBuffer,
): SampledInstrumentRegion => ({
  sourceStartFrame: sampled.sourceStartFrame,
  sourceEndFrame: sourceEndFrameForSampledInstrumentBuffer(sampled),
})

export const localizeSampledInstrumentSample = <
  Sample extends SampledInstrumentSample,
>(
  sample: Sample,
  sampled: SampledInstrumentBuffer,
): Sample => ({
  ...sample,
  assetKey: sampledInstrumentRegionIdentity(sample, sampledInstrumentRegionForBuffer(sampled)),
  source: { ...sample.source, durationSec: sampled.buffer.duration },
})

export const localizeSampledInstrumentSeconds = (
  seconds: number,
  sourceStartFrame: number,
  sampleRate: number,
) => seconds - sourceStartFrame / sampleRate

export const validateSampledInstrumentBuffer = (
  sampled: SampledInstrumentBuffer,
  source: SampledInstrumentSource,
  region: SampledInstrumentRegion,
  expectedIdentity?: string,
) => {
  const expectedFrames = sampledInstrumentRegionFrameCount(region)
  if (sampled.sourceStartFrame !== region.sourceStartFrame
    || sampled.buffer.length !== expectedFrames
    || sampled.buffer.sampleRate !== source.sampleRate
    || sampled.buffer.numberOfChannels !== source.channelCount) {
    throw new Error('Sampled instrument buffer metadata does not match its region.')
  }
  if (expectedIdentity !== undefined
    && sampled.sourceIdentity !== undefined
    && sampled.sourceIdentity !== expectedIdentity) {
    throw new Error('Sampled instrument buffer identity does not match its source.')
  }
  return sampled
}
