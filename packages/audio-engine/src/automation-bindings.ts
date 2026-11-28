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
  const param = saturator.workletNode.parameters.get(parameterId)

  if (param) return [{ param, valueToAudioValue: (value) => value }]

  return []
}

export const resolveDelayAutomationBindings = (
  chain: ChainState<DelayNodeChain> | DelayNodeChain | null | undefined,
  parameterId: string,
): AutomationAudioBinding[] => {
  const delay = chain && 'chain' in chain ? chain.chain() : chain

  if (!delay) return []
  const param = delay.workletNode.parameters.get(parameterId)

  if (param) return [{ param, valueToAudioValue: (value) => value }]

  return []
}

export const resolveReverbAutomationBindings = (
  chain: ChainState<ReverbNodeChain> | ReverbNodeChain | null | undefined,
  parameterId: string,
): AutomationAudioBinding[] => {
  const reverb = chain && 'chain' in chain ? chain.chain() : chain

  if (!reverb) return []
  const param = reverb.workletNode.parameters.get(parameterId)

  if (param) return [{ param, valueToAudioValue: (value) => value }]

  return []
}
