import { normalizeEqParams, type EqParamsLite } from '@daw-browser/shared'
import { disconnectAudioNodes } from './chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './dsp'

export type EqChainState = {
  nodes: () => BiquadFilterNode[]
  nodesByBand: () => ReadonlyMap<string, BiquadFilterNode>
  // The write that moves the nodes to `params`, for the caller to run when its update commits, never before: a candidate
  // that is discarded must leave the nodes holding what they held. Null when the band layout changed and the nodes must be rebuilt.
  writesAfterCommit: (params: EqParamsLite) => (() => void) | null
  close: () => void
}

export function createEqChainState(ctx: BaseAudioContext, params: EqParamsLite, channelCount: number): EqChainState {
  const normalized = normalizeEqParams(params)
  const nodes = createEqNodes(ctx, normalized, channelCount)
  const topology = getEqTopologySignature(normalized)
  const nodesByBand = new Map<string, BiquadFilterNode>(normalized.bands.filter((band) => band.enabled).flatMap((band, index) => {
    const node = nodes[index]
    return node ? [[band.id, node]] : []
  }))
  return {
    nodes: () => nodes,
    nodesByBand: () => nodesByBand,
    writesAfterCommit: (next) => {
      const nextParams = normalizeEqParams(next)
      return getEqTopologySignature(nextParams) === topology ? () => applyEqNodeParams(nodes, nextParams) : null
    },
    close: () => disconnectAudioNodes(nodes),
  }
}
