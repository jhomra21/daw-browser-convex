export type LoopTransport = {
  loopEnabled: boolean
  loopStartSec: number
  loopEndSec: number
}

export type LoopFrames = {
  startFrame: number
  endFrame: number
  lengthFrames: number
}

export const loopFramesForTransport = (
  transport: LoopTransport,
  sampleRateHz: number,
): LoopFrames | undefined => {
  if (!transport.loopEnabled) return undefined
  const startFrame = Math.round(transport.loopStartSec * sampleRateHz)
  const endFrame = Math.round(transport.loopEndSec * sampleRateHz)
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
    || startFrame < 0 || endFrame <= startFrame) return undefined
  return { startFrame, endFrame, lengthFrames: endFrame - startFrame }
}

export const arrangementFrameForLoop = (
  frame: number,
  loop: LoopFrames | undefined,
) => {
  if (!loop || frame < loop.endFrame) return frame
  return loop.startFrame + ((frame - loop.startFrame) % loop.lengthFrames + loop.lengthFrames) % loop.lengthFrames
}

export type LoopScheduleSlice = {
  nativeStartFrame: number
  nativeEndFrame: number
  arrangementStartFrame: number
  arrangementEndFrame: number
  iteration: number
}

export const splitLoopScheduleRange = (
  startFrame: number,
  endFrame: number,
  loop: LoopFrames | undefined,
): readonly LoopScheduleSlice[] => {
  if (!loop) return [{
    nativeStartFrame: startFrame,
    nativeEndFrame: endFrame,
    arrangementStartFrame: startFrame,
    arrangementEndFrame: endFrame,
    iteration: 0,
  }]
  const slices: LoopScheduleSlice[] = []
  let cursor = startFrame
  while (cursor < endFrame) {
    const beforeLoop = cursor < loop.startFrame
    const arrangementStartFrame = beforeLoop ? cursor : arrangementFrameForLoop(cursor, loop)
    const boundary = beforeLoop
      ? loop.startFrame
      : cursor + loop.endFrame - arrangementStartFrame
    const nativeEndFrame = Math.min(endFrame, boundary)
    slices.push({
      nativeStartFrame: cursor,
      nativeEndFrame,
      arrangementStartFrame,
      arrangementEndFrame: arrangementStartFrame + nativeEndFrame - cursor,
      iteration: beforeLoop ? 0 : Math.floor((cursor - loop.startFrame) / loop.lengthFrames) + 1,
    })
    cursor = nativeEndFrame
  }
  return slices
}
