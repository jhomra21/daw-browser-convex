import { expect, test } from 'bun:test'
import { migrateAudioEffectParams } from './audio-effect-param-versions'
import { getAutomationParameterDescriptor } from './automation-parameters'
import { normalizeUtilityParamsEnvelope } from './effects-params'
import { migrateUtilityParamsV1, utilityV1ChannelGains } from './utility-params-migration'

const v1 = (state: Record<string, number | string | boolean> = {}) => ({
  version: 1,
  state: { enabled: true, gainDb: 0, polarity: 'normal', inputMode: 'stereo', pan: 0, balance: 0, width: 1, matrix: 'stereo', swap: false, dcBlock: true, ...state },
})

const migrated = (state?: Record<string, number | string | boolean>) => normalizeUtilityParamsEnvelope(migrateUtilityParamsV1(v1(state))).state

// Left and right gains of a version 2 state, from its Balance and Gain only.
const gainsOf = (state: ReturnType<typeof migrated>) => {
  const gain = 10 ** (state.gainDb / 20)

  return { left: (state.balance > 0 ? 1 - state.balance : 1) * gain, right: (state.balance < 0 ? 1 + state.balance : 1) * gain }
}

test('polarity and swap become Phase L/R and Channel Mode, and the stored DC Block carries over', () => {
  expect(migrated({ polarity: 'invert', swap: true, dcBlock: true })).toMatchObject({ phaseLeft: true, phaseRight: true, channelMode: 'swap', dcBlock: true })
  expect(migrated()).toMatchObject({ phaseLeft: false, phaseRight: false, channelMode: 'both', dcBlock: true, mute: false })
})

test('the new controls start where they do nothing', () => {
  expect(migrated()).toMatchObject({ widthMode: 'stereo', midSide: 0, bassMono: false, bassMonoHz: 120, bassMonoAudition: false })
})

test('every other knob keeps its value', () => {
  expect(migrated({ gainDb: -12, width: 1.5, inputMode: 'mono-sum', matrix: 'mid-side-encode' })).toMatchObject({ gainDb: -12, width: 1.5, inputMode: 'mono-sum', matrix: 'mid-side-encode', balance: 0 })
})

test('a Balance with no Pan keeps its value exactly', () => {
  for (const balance of [-1, -0.5, -0.1, 0, 0.3, 1]) expect(migrated({ balance }).balance).toBeCloseTo(balance, 12)
})

test('Pan hard left and right become Balance -1 and 1, and centre stays 0', () => {
  expect(migrated({ pan: -1 }).balance).toBeCloseTo(-1, 12)
  expect(migrated({ pan: 1 }).balance).toBeCloseTo(1, 12)
  expect(migrated({ pan: 0 }).balance).toBe(0)
})

test('Pan 0.5 leaves the far channel at its old gain and the near one at unity', () => {
  const state = migrated({ pan: 0.5 })
  const old = utilityV1ChannelGains(0.5, 0)

  expect(state.balance).toBeGreaterThan(0)
  expect(gainsOf(state).left).toBeCloseTo(old.left, 12)
  expect(gainsOf(state).right).toBeCloseTo(1, 12)
  expect(old.right).toBeCloseTo(1.3066, 4)
})

test('across every Pan and Balance, nothing gets louder and the worst level change is 3.01 dB on the louder channel', () => {
  let worst = 0
  let worstFar = 0

  for (let pan = -1; pan <= 1.0000001; pan += 0.05) {
    for (let balance = -1; balance <= 1.0000001; balance += 0.05) {
      const old = utilityV1ChannelGains(pan, balance)
      const next = gainsOf(migrated({ pan, balance }))
      const louder = Math.max(old.left, old.right)

      if (louder <= 1e-12) continue
      expect(Math.max(next.left, next.right)).toBeLessThanOrEqual(1 + 1e-9)
      const farOld = Math.min(old.left, old.right)
      const farNew = old.left < old.right ? next.left : next.right

      if (farOld > 1e-9) worstFar = Math.max(worstFar, Math.abs(20 * Math.log10(farNew / farOld)))
      worst = Math.max(worst, Math.abs(20 * Math.log10(Math.max(next.left, next.right) / louder)))
    }
  }

  expect(worst).toBeCloseTo(20 * Math.log10(Math.SQRT2), 2)
  expect(worstFar).toBeLessThan(1e-9)
})

test('a Pan against an opposite Balance keeps both levels through Gain', () => {
  const state = migrated({ pan: 0.2, balance: -0.5 })
  const old = utilityV1ChannelGains(0.2, -0.5)

  expect(Math.max(old.left, old.right)).toBeLessThan(1)
  expect(gainsOf(state).left).toBeCloseTo(old.left, 12)
  expect(gainsOf(state).right).toBeCloseTo(old.right, 12)
})

test('a Pan hard left against Balance hard right was silent and becomes Mute', () => {
  expect(migrated({ pan: -1, balance: 1 })).toMatchObject({ mute: true, balance: 0 })
})

// A lane on the retired id has nowhere to go: local load drops lanes whose id has no descriptor (local-automation.ts) and the server refuses to write them.
test('the retired Pan lane id has no descriptor, while Balance, Mid/Side and Bass Mono Hz do', () => {
  expect(getAutomationParameterDescriptor('utility.pan')).toBeUndefined()
  for (const id of ['utility.gainDb', 'utility.balance', 'utility.width', 'utility.midSide', 'utility.bassMonoHz']) expect(getAutomationParameterDescriptor(id)?.owner).toBe('utility')
})

test('unwrapped params and the version table migrate too', () => {
  expect(normalizeUtilityParamsEnvelope({ version: 1, state: migrateUtilityParamsV1(v1({ pan: 1 }).state) }).state.balance).toBeCloseTo(1, 12)
  expect(normalizeUtilityParamsEnvelope(migrateAudioEffectParams('utility', v1({ pan: -1 }), 1)).state.balance).toBeCloseTo(-1, 12)
  expect(normalizeUtilityParamsEnvelope(migrateAudioEffectParams('utility', { version: 1, state: migrated() }, 2)).state.balance).toBe(0)
})
