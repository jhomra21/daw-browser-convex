export const LIVE_GAIN_RAMP_SEC = 0.01

type RampAudioParam = {
  value: number
  cancelScheduledValues: (time: number) => void
  setValueAtTime: (value: number, time: number) => void
  linearRampToValueAtTime: (value: number, endTime: number) => void
}

export function scheduleAudioParamRamp(
  parameter: RampAudioParam,
  value: number,
  currentTime: number,
  durationSec = LIVE_GAIN_RAMP_SEC,
) {
  parameter.cancelScheduledValues(currentTime)
  parameter.setValueAtTime(parameter.value, currentTime)
  parameter.linearRampToValueAtTime(value, currentTime + durationSec)
}

const lastWrittenValues = new WeakMap<RampAudioParam, number>()

export function setAudioParamValue(parameter: RampAudioParam, value: number) {
  parameter.value = value
  lastWrittenValues.set(parameter, value)
}

export function forgetAudioParamValue(parameter: RampAudioParam) {
  lastWrittenValues.delete(parameter)
}

export function rampAudioParam(
  parameter: RampAudioParam,
  value: number,
  currentTime: number,
  durationSec = LIVE_GAIN_RAMP_SEC,
) {
  if (lastWrittenValues.get(parameter) === value) return
  scheduleAudioParamRamp(parameter, value, currentTime, durationSec)
  if (!('AudioParam' in globalThis) || !(parameter instanceof globalThis.AudioParam)) {
    parameter.value = value
  }
  lastWrittenValues.set(parameter, value)
}
