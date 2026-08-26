import type { AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine"
import type { ArpeggiatorParams, AudioEffectKind, TrackInstrumentParams } from "@daw-browser/shared"

type ExportAudioEffectRow = AudioEffectRuntimeInstance extends infer Instance
  ? Instance extends { kind: AudioEffectKind; params: unknown }
    ? {
        targetId: string
        effect: Instance["kind"]
        params: Instance["params"]
        instanceId?: string
        index?: number
      }
    : never
  : never
type ExportInstrumentEffectRow = {
  targetId: string
  effect: "instrument"
  params: TrackInstrumentParams
  instanceId?: undefined
  index?: undefined
}
type ExportArpEffectRow = {
  targetId: string
  effect: "arp"
  params: ArpeggiatorParams
  instanceId?: undefined
  index?: undefined
}
type ExportSynthEffectRow = {
  targetId: string
  effect: "synth"
  params: unknown
  instanceId?: undefined
  index?: undefined
}
export type ExportEffectRow =
  | ExportAudioEffectRow
  | ExportInstrumentEffectRow
  | ExportArpEffectRow
  | ExportSynthEffectRow

export type ExportEffectsProjection = {
  replaceAudioEffectTargets: Array<{
    targetId: string
    rows: ExportEffectRow[]
  }>
  upsertDeviceRows: ExportEffectRow[]
}

export const withInstrumentOverride = (
  projection: ExportEffectsProjection,
  targetId: string,
  instrument: TrackInstrumentParams,
): ExportEffectsProjection => ({
  replaceAudioEffectTargets: projection.replaceAudioEffectTargets,
  upsertDeviceRows: [
    ...projection.upsertDeviceRows,
    { targetId, effect: "instrument", params: instrument },
  ],
})
