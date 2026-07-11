import { assert } from '@daw-browser/shared'

type CueAudioContext = Pick<BaseAudioContext, 'destination' | 'createGain'>

export const createCueBus = (ctx: CueAudioContext, destination: AudioNode): GainNode => {
  assert(destination !== ctx.destination, 'Cue destination must be distinct from the main audio destination.')
  const bus = ctx.createGain()
  bus.connect(destination)
  return bus
}
