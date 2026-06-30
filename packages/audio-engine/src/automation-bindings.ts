import { parseEqBandParameterId } from '@daw-browser/shared'
import type { AutomationAudioBinding } from './automation'
import type { DelayNodeChain, ReverbNodeChain, SaturatorNodeChain } from './effects/chain'

type ChainState<T> = {
  chain: () => T | null
}

export const resolveEqAutomationBindings = (
  nodesByBand: ReadonlyMap<string, BiquadFilterNode>,
  parameterId: string,
): AutomationAudioBinding[] => {
  const eq = parseEqBandParameterId(parameterId)
  if (!eq) return []
  const node = nodesByBand.get(eq.bandId)
  if (!node) return []
  if (eq.property === 'frequencyHz') return [{ param: node.frequency, valueToAudioValue: (value) => value }]
  if (eq.property === 'gainDb') return [{ param: node.gain, valueToAudioValue: (value) => value }]
  return [{ param: node.Q, valueToAudioValue: (value) => value }]
}

export const resolveSaturatorAutomationBindings = (
  chain: ChainState<SaturatorNodeChain> | SaturatorNodeChain | null | undefined,
  parameterId: string,
): AutomationAudioBinding[] => {
  const saturator = chain && 'chain' in chain ? chain.chain() : chain
  if (!saturator) return []
  if (parameterId === 'saturator.driveDb') return [{ param: saturator.driveGain.gain, valueToAudioValue: (value) => 10 ** (value / 20) }]
  if (parameterId === 'saturator.outputDb') return [{ param: saturator.outputGain.gain, valueToAudioValue: (value) => 10 ** (value / 20) }]
  if (parameterId === 'saturator.dryWet') return [
    { param: saturator.dryGain.gain, valueToAudioValue: (value) => 1 - value },
    { param: saturator.wetGain.gain, valueToAudioValue: (value) => value },
  ]
  if (parameterId === 'saturator.colorFrequencyHz') return [{ param: saturator.colorFilter.frequency, valueToAudioValue: (value) => value }]
  return []
}

export const resolveDelayAutomationBindings = (
  chain: ChainState<DelayNodeChain> | DelayNodeChain | null | undefined,
  parameterId: string,
): AutomationAudioBinding[] => {
  const delay = chain && 'chain' in chain ? chain.chain() : chain
  if (!delay) return []
  if (parameterId === 'delay.timeMs') return [
    { param: delay.delayLeft.delayTime, valueToAudioValue: (value) => value / 1000 },
    { param: delay.delayRight.delayTime, valueToAudioValue: (value) => value / 1000 },
  ]
  if (parameterId === 'delay.feedback') return [
    { param: delay.feedbackLeft.gain, valueToAudioValue: (value) => value },
    { param: delay.feedbackRight.gain, valueToAudioValue: (value) => value },
  ]
  if (parameterId === 'delay.dryWet') return [
    { param: delay.dryGain.gain, valueToAudioValue: (value) => 1 - value },
    { param: delay.wetGain.gain, valueToAudioValue: (value) => value },
  ]
  if (parameterId === 'delay.lowCutHz') return [
    { param: delay.lowCutLeft.frequency, valueToAudioValue: (value) => value },
    { param: delay.lowCutRight.frequency, valueToAudioValue: (value) => value },
  ]
  if (parameterId === 'delay.highCutHz') return [
    { param: delay.highCutLeft.frequency, valueToAudioValue: (value) => value },
    { param: delay.highCutRight.frequency, valueToAudioValue: (value) => value },
  ]
  return []
}

export const resolveReverbAutomationBindings = (
  chain: ChainState<ReverbNodeChain> | ReverbNodeChain | null | undefined,
  parameterId: string,
): AutomationAudioBinding[] => {
  const reverb = chain && 'chain' in chain ? chain.chain() : chain
  if (!reverb) return []
  if (parameterId === 'reverb.wet') return [
    { param: reverb.dryGain.gain, valueToAudioValue: (value) => 1 - value },
    { param: reverb.wetGain.gain, valueToAudioValue: (value) => value },
  ]
  if (parameterId === 'reverb.preDelayMs') return [{ param: reverb.preDelay.delayTime, valueToAudioValue: (value) => value / 1000 }]
  if (parameterId === 'reverb.lowCutHz') return [{ param: reverb.lowCut.frequency, valueToAudioValue: (value) => value }]
  if (parameterId === 'reverb.highCutHz') return [{ param: reverb.highCut.frequency, valueToAudioValue: (value) => value }]
  if (parameterId === 'reverb.stereoWidth') return [
    { param: reverb.leftToLeft.gain, valueToAudioValue: (value) => (1 + value) / 2 },
    { param: reverb.rightToLeft.gain, valueToAudioValue: (value) => (1 - value) / 2 },
    { param: reverb.leftToRight.gain, valueToAudioValue: (value) => (1 - value) / 2 },
    { param: reverb.rightToRight.gain, valueToAudioValue: (value) => (1 + value) / 2 },
  ]
  return []
}
