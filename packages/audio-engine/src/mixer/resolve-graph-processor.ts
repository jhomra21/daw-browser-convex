import type { AudioCoreGraphSnapshot } from '../../../audio-core-contract/src/index'

export type ResolvedGraphProcessor = {
  node: AudioCoreGraphSnapshot['nodes'][number]
  processor: AudioCoreGraphSnapshot['nodes'][number]['processorOrder'][number]
  parameterTargets: ReadonlyMap<string, number>
}

export const resolveGraphProcessor = (
  graph: AudioCoreGraphSnapshot,
  instanceId: string,
  nodeId?: string,
): ResolvedGraphProcessor | undefined => {
  for (const node of graph.nodes) {
    if (nodeId !== undefined && node.id !== nodeId) continue
    const processor = node.processorOrder.find((candidate) => candidate.id === instanceId)
    if (processor) {
      return {
        node,
        processor,
        parameterTargets: new Map(processor.parameterTargets.map((target) => [target.id, target.target])),
      }
    }
  }
  return undefined
}
