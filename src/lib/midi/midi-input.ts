import { isJsonString, type JsonValue } from "@daw-browser/shared"

export type MidiInputEvent =
  | {
    sourceId: string
    timeStamp: number
    channel: number
    kind: "note-on" | "note-off"
    note: number
    velocity: number
  }
  | {
    sourceId: string
    timeStamp: number
    channel: number
    kind: "control-change"
    controller: number
    value: number
  }
  | {
    sourceId: string
    timeStamp: number
    channel: number
    kind: "pitch-bend"
    value: number
  }
  | {
    sourceId: string
    timeStamp: number
    channel: number
    kind: "channel-pressure"
    pressure: number
  }
  | {
    sourceId: string
    timeStamp: number
    channel: number
    kind: "poly-pressure"
    note: number
    pressure: number
  }

export type MidiSourceReset = {
  sourceId: string
  kind: "source-reset"
}

const MAX_SELECTED_MIDI_INPUTS = 16

export const normalizeMidiSelectedInputIds = (
  value: JsonValue | readonly string[] | undefined,
): string[] => {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isJsonString(item) || item.length === 0 || item.length > 256) continue
    ids.add(item)
    if (ids.size === MAX_SELECTED_MIDI_INPUTS) break
  }
  return [...ids]
}

const isMidiDataByte = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= 127

const isStatusByte = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 0x80 && value <= 0xef

const normalizeMidiValue = (value: number): number => value / 127

export const parseMidiInputMessage = (
  sourceId: string,
  data: ReadonlyArray<number>,
  timeStamp: number,
): MidiInputEvent | null => {
  const status = data[0]
  if (!isStatusByte(status) || !Number.isFinite(timeStamp)) return null

  const command = status & 0xf0
  const channel = (status & 0x0f) + 1
  const data1 = data[1]
  const data2 = data[2]

  if (command === 0xd0) {
    if (data.length !== 2 || !isMidiDataByte(data1)) return null
    return { sourceId, timeStamp, channel, kind: "channel-pressure", pressure: normalizeMidiValue(data1) }
  }

  if (
    data.length !== 3
    || !isMidiDataByte(data1)
    || !isMidiDataByte(data2)
  ) return null

  if (command === 0x80) {
    return { sourceId, timeStamp, channel, kind: "note-off", note: data1, velocity: normalizeMidiValue(data2) }
  }
  if (command === 0x90) {
    return data2 === 0
      ? { sourceId, timeStamp, channel, kind: "note-off", note: data1, velocity: 0 }
      : { sourceId, timeStamp, channel, kind: "note-on", note: data1, velocity: normalizeMidiValue(data2) }
  }
  if (command === 0xa0) {
    return { sourceId, timeStamp, channel, kind: "poly-pressure", note: data1, pressure: normalizeMidiValue(data2) }
  }
  if (command === 0xb0) {
    return { sourceId, timeStamp, channel, kind: "control-change", controller: data1, value: normalizeMidiValue(data2) }
  }
  if (command === 0xe0) {
    return {
      sourceId,
      timeStamp,
      channel,
      kind: "pitch-bend",
      value: ((data2 << 7) | data1) / 8192 - 1
    }
  }
  return null
}
