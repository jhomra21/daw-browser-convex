import { CompressorProcessorError, type CompressorNodeChain, type CompressorProcessorLifecyclePhase } from '../effects/chain'
import { readCompressorMeterFrame } from '../effects/compressor-worklet'
import { compressorWorklet } from '../worklet-manifest'

export type OfflineProcessorTarget = { kind: 'track'; trackId: string } | { kind: 'master' }

type OfflineCompressorChain = Pick<CompressorNodeChain, 'state' | 'fault'>

type RetainedOfflineCompressor = {
  target: OfflineProcessorTarget
  instanceId: string
  chain: OfflineCompressorChain
  protocolFault: Error | null
}

class OfflineProcessorError extends Error {
  readonly processor = compressorWorklet.processorName
  readonly target: OfflineProcessorTarget
  readonly instanceId: string
  readonly phase: CompressorProcessorLifecyclePhase

  constructor(
    details: { target: OfflineProcessorTarget; instanceId: string; phase: CompressorProcessorLifecyclePhase },
    message: string,
    cause?: unknown,
  ) {
    const targetLabel = details.target.kind === 'master' ? 'master' : `track "${details.target.trackId}"`
    super(`${message} [processor=${compressorWorklet.processorName}, target=${targetLabel}, instance=${details.instanceId}, phase=${details.phase}]`, { cause })
    this.name = 'OfflineProcessorError'
    this.target = details.target
    this.instanceId = details.instanceId
    this.phase = details.phase
  }
}

export type OfflineCompressorLifecycle<Chain extends OfflineCompressorChain> = {
  create: (
    target: OfflineProcessorTarget,
    instanceId: string,
    createChain: () => Promise<Chain>,
  ) => Promise<Chain>
  assertHealthy: () => void
  dispose: () => void
}

export function createOfflineCompressorLifecycle<Chain extends OfflineCompressorChain>(
  teardown: (chain: Chain) => void,
  setMessageHandler: (chain: Chain, handler: ((data: unknown) => void) | null) => void,
): OfflineCompressorLifecycle<Chain> {
  const retained: Array<RetainedOfflineCompressor & { chain: Chain }> = []

  return {
    async create(target, instanceId, createChain) {
      let chain: Chain
      try {
        chain = await createChain()
      } catch (error) {
        const phase = error instanceof CompressorProcessorError ? error.phase : 'construction'
        throw new OfflineProcessorError(
          { target, instanceId, phase },
          'Failed to create offline compressor.',
          error,
        )
      }
      const processor: RetainedOfflineCompressor & { chain: Chain } = { target, instanceId, chain, protocolFault: null }
      setMessageHandler(chain, (data) => {
        if (readCompressorMeterFrame(data)) return
        processor.protocolFault ??= new OfflineProcessorError(
          { target, instanceId, phase: 'protocol' },
          'Offline compressor received a malformed processor message.',
        )
      })
      retained.push(processor)
      return chain
    },
    assertHealthy: () => {
      for (const processor of retained) {
        if (processor.protocolFault) throw processor.protocolFault
        if (processor.chain.state !== 'faulted') continue
        throw new OfflineProcessorError(
          { target: processor.target, instanceId: processor.instanceId, phase: 'runtime' },
          'Offline compressor processor failed during rendering.',
          processor.chain.fault,
        )
      }
    },
    dispose: () => {
      for (const processor of retained) {
        setMessageHandler(processor.chain, null)
        teardown(processor.chain)
      }
      retained.length = 0
    },
  }
}
