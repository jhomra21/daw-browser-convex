// Instrument specs for the harness: default params from packages/shared, compiled to the wire state by the same portable-session compilers
// the product uses, with the PCM assets the state refers to.
import { synthParameterRegistry } from '../../packages/audio-core-contract/src'
import { compilePortableDrumRackConfiguration, compilePortableGranularConfiguration, compilePortableSamplerConfiguration, compilePortableSynthConfiguration } from '../../packages/audio-engine/src/portable-session-compiler'
import type { PortableAssetRegistryInput } from '../../packages/audio-engine/src/portable-session-compiler'
import { assignSampleToDrumRackPad, createDefaultDrumRackParams } from '../../packages/shared/src/drum-rack-params'
import type { DrumRackPadSample } from '../../packages/shared/src/drum-rack-params'
import { createDefaultGranularParams } from '../../packages/shared/src/granular-params'
import type { GranularParams } from '../../packages/shared/src/granular-params'
import { createDefaultSamplerParams } from '../../packages/shared/src/sampler-params'
import type { SamplerParams, SamplerZone } from '../../packages/shared/src/sampler-params'
import { createDefaultSynthParams, mergeSynthParams } from '../../packages/shared/src/synth-params'
import type { SynthParamsUpdate } from '../../packages/shared/src/synth-params'
import type { Instrument } from './render-instrument'

const nodeId = 'track'
const instanceId = 'harness'

/** A decoded sample the instrument plays, keyed as the project keys its assets. */
export type SampleAsset = { assetKey: string; sampleRate: number; planes: readonly Float32Array[] }

export const sampleAsset = (assetKey: string, sampleRate: number, plane: Float32Array): SampleAsset => ({ assetKey, sampleRate, planes: [plane] })

const portableId = (asset: SampleAsset) => `pcm:${asset.assetKey}`

const sampleRef = (asset: SampleAsset): DrumRackPadSample => ({
  assetKey: asset.assetKey, url: '', sourceKind: 'upload',
  source: { durationSec: asset.planes[0].length / asset.sampleRate, sampleRate: asset.sampleRate, channelCount: asset.planes.length },
})

// The compilers only check a handle's shape; the host assigns the real one when the asset is registered under its portable id.
const registry = (assets: readonly SampleAsset[]): PortableAssetRegistryInput => ({
  projectGeneration: 1,
  assets: assets.map((asset) => ({
    projectAssetId: asset.assetKey, portableAssetId: portableId(asset), projectGeneration: 1, handle: { slot: 0, generation: 1 },
    decoded: { sampleRateHz: asset.sampleRate, channelCount: asset.planes.length, frameCount: asset.planes[0].length },
  })),
})

const registered = (assets: readonly SampleAsset[]) =>
  assets.map((asset) => ({ assetId: portableId(asset), sampleRateHz: asset.sampleRate, planes: asset.planes }))

/** A whole-sample zone over every key and velocity, rooted at C4, one-shot unless the patch says otherwise. */
export const zone = (asset: SampleAsset, patch: Partial<SamplerZone> = {}): SamplerZone => ({
  id: 'zone', sample: sampleRef(asset), keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote: 60, tuneCents: 0, gain: 1, pan: 0,
  roundRobinGroup: 0, roundRobinIndex: 0, playbackMode: 'one-shot', startSec: 0, crossfadeSec: 0, chokeGroup: 0, ...patch,
})

/** The wire id of a synth parameter, for live parameter events. */
export const synthTarget = (id: string) => {
  const entry = synthParameterRegistry.find((candidate) => candidate.id === id)

  if (entry === undefined) throw new Error(`no synth parameter ${id}`)

  return entry.target
}

export const instruments = {
  synth: (update: SynthParamsUpdate = {}): Instrument => ({
    state: compilePortableSynthConfiguration(nodeId, instanceId, mergeSynthParams(createDefaultSynthParams(), update)).state, assets: [],
  }),
  sampler: (asset: SampleAsset, zones: readonly SamplerZone[], patch: Partial<SamplerParams> = {}): Instrument => ({
    state: compilePortableSamplerConfiguration(nodeId, instanceId, { ...createDefaultSamplerParams(), ...patch, zones }, registry([asset])).state,
    assets: registered([asset]),
  }),
  /** All 16 pads (notes 36 to 51) play `asset`. */
  drumRack: (asset: SampleAsset): Instrument => {
    const defaults = createDefaultDrumRackParams()
    const params = defaults.pads.reduce((current, { id }) => assignSampleToDrumRackPad(current, id, sampleRef(asset)), defaults)

    return { state: compilePortableDrumRackConfiguration(nodeId, instanceId, params, registry([asset])).state, assets: registered([asset]) }
  },
  granular: (asset: SampleAsset, patch: Partial<GranularParams> = {}): Instrument => ({
    state: compilePortableGranularConfiguration(nodeId, instanceId, { ...createDefaultGranularParams(), ...patch, zone: zone(asset) }, registry([asset])).state,
    assets: registered([asset]),
  }),
}
