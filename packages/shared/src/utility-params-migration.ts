import { UTILITY_GAIN_DB_MIN } from './effects-params'
import { isJsonBoolean, isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2.
// - The one Polarity switch inverted both channels; it becomes Phase L and Phase R, both on or both off. Swap becomes Channel Mode Swap.
// - Pan and Balance were two left/right attenuators; the device now has one Balance, as Live's: centre 0 dB, the far side fades by 1 - |balance|,
//   nothing gets louder. The old Balance is already that law, so on its own it keeps its meaning. The old Pan scaled left by sqrt(2) cos((pan + 1) pi / 4)
//   and right by sqrt(2) sin((pan + 1) pi / 4), so the louder channel could sit up to +3.01 dB above unity, which no balance can do. The migrated Balance
//   keeps the quieter channel at exactly its old gain (pan and balance combined), and the louder channel stays at 0 dB: it loses up to 3.01 dB, at pan
//   +-1. When both old gains were under unity (a Pan against an opposite Balance) a Balance alone would leave the louder channel louder than it was,
//   so the louder gain moves into Gain and both channels keep their old level exactly. Both gains 0 migrates as Mute.
// - DC Block keeps its stored value, and a row that stored none keeps the version 1 default, on (its corner moved from 10 Hz to 4 Hz); the new
//   controls start where they do nothing.
const SQRT_TWO = Math.SQRT2

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** The left and right gains of the version 1 Pan followed by the version 1 Balance. */
export const utilityV1ChannelGains = (pan: number, balance: number) => {
  const angle = (clamp(pan, -1, 1) + 1) * Math.PI / 4
  const limited = clamp(balance, -1, 1)

  return {
    left: SQRT_TWO * Math.cos(angle) * (limited > 0 ? 1 - limited : 1),
    right: SQRT_TWO * Math.sin(angle) * (limited < 0 ? 1 + limited : 1),
  }
}

const SILENT = 1e-12

export const migrateUtilityParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params
  const { polarity, pan, swap, ...kept } = old
  const gains = utilityV1ChannelGains(finite(pan, 0), finite(old.balance, 0))
  const loud = Math.max(gains.left, gains.right)
  const far = Math.min(gains.left, gains.right)
  const silent = loud <= SILENT
  const makeup = silent || loud >= 1 ? 1 : loud
  const fade = silent || loud - far < SILENT ? 0 : 1 - far / makeup
  const gainDb = finite(old.gainDb, 0) + 20 * Math.log10(makeup)
  const inverted = polarity === 'invert'

  const state: JsonValue = {
    ...kept,
    gainDb: Math.max(UTILITY_GAIN_DB_MIN, gainDb),
    phaseLeft: inverted,
    phaseRight: inverted,
    dcBlock: isJsonBoolean(old.dcBlock) ? old.dcBlock : true,
    channelMode: isJsonBoolean(swap) && swap ? 'swap' : 'both',
    balance: fade === 0 ? 0 : gains.left < gains.right ? fade : -fade,
    mute: silent,
    widthMode: 'stereo',
    midSide: 0,
    bassMono: false,
    bassMonoHz: 120,
    bassMonoAudition: false,
  }

  return wrapped ? { ...params, state } : state
}
