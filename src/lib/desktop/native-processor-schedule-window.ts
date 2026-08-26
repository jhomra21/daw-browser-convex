import { serializeNativeScheduleWindow, type NativeScheduleWindow } from "@daw-browser/audio-engine/native-host-wire"
import { nativeAudioHostMaximumScheduleRecords } from "@daw-browser/desktop-protocol/native-audio-host"

export const nativeProcessorAutomationExtensionMagic = 0x31524150
export const nativeProcessorAutomationRecordBytes = 40

export type NativeProcessorAutomationEvent =
  | { kind: "set"; processorInstanceId: number; parameterTarget: number; frame: number; value: number }
  | { kind: "linear"; processorInstanceId: number; parameterTarget: number; frame: number; endFrame: number; startValue: number; endValue: number }

export const serializeNativeScheduleWindowWithProcessorAutomation = (
  window: NativeScheduleWindow,
  events: readonly NativeProcessorAutomationEvent[],
) => {
  const existingCount = (window.instrumentEvents?.length ?? 0)
    + (window.sampleSourceEvents?.length ?? 0)
    + (window.vstAutomationSegments?.length ?? 0)
  if (existingCount + events.length > nativeAudioHostMaximumScheduleRecords) {
    throw new Error("Native schedule window exceeds its record capacity.")
  }
  for (const event of events) {
    if (!Number.isSafeInteger(event.processorInstanceId) || event.processorInstanceId <= 0
      || !Number.isSafeInteger(event.parameterTarget) || event.parameterTarget <= 0 || event.parameterTarget > 0xffff_ffff
      || !Number.isSafeInteger(event.frame) || event.frame < window.startFrame || event.frame >= window.endFrame) {
      throw new Error("Native processor automation event is invalid.")
    }
    if (event.kind === "linear") {
      if (!Number.isSafeInteger(event.endFrame) || event.endFrame <= event.frame || event.endFrame > window.endFrame
        || !Number.isFinite(event.startValue) || !Number.isFinite(event.endValue)) {
        throw new Error("Native processor automation ramp is invalid.")
      }
    } else if (!Number.isFinite(event.value)) {
      throw new Error("Native processor automation value is invalid.")
    }
  }

  const base = serializeNativeScheduleWindow(window)
  if (events.length === 0) return base
  const output = new Uint8Array(base.byteLength + 8 + events.length * nativeProcessorAutomationRecordBytes)
  output.set(base)
  const view = new DataView(output.buffer)
  let offset = base.byteLength
  view.setUint32(offset, nativeProcessorAutomationExtensionMagic, true)
  view.setUint32(offset + 4, events.length, true)
  offset += 8
  for (const event of events) {
    view.setBigUint64(offset, BigInt(event.processorInstanceId), true)
    view.setUint32(offset + 8, event.parameterTarget, true)
    view.setUint32(offset + 12, event.kind === "linear" ? 1 : 0, true)
    view.setBigUint64(offset + 16, BigInt(event.frame), true)
    if (event.kind === "linear") {
      view.setBigUint64(offset + 24, BigInt(event.endFrame), true)
      view.setFloat32(offset + 32, event.startValue, true)
      view.setFloat32(offset + 36, event.endValue, true)
    } else {
      view.setBigUint64(offset + 24, BigInt(event.frame), true)
      view.setFloat32(offset + 32, event.value, true)
      view.setFloat32(offset + 36, event.value, true)
    }
    offset += nativeProcessorAutomationRecordBytes
  }
  return output
}
