import type { ExternalProcessor } from "@daw-browser/external-plugins"

export type NativeLiveProcessorSeed = {
  projectId: string
  processor: ExternalProcessor
}

export const resolveNativeLivePlaybackProcessors = async (input: {
  projectId: string
  persisted: readonly ExternalProcessor[]
  seed?: NativeLiveProcessorSeed
  readPersisted: (projectId: string, instanceId: string) => Promise<ExternalProcessor | undefined>
}): Promise<ExternalProcessor[]> => {
  const processorsById = new Map<string, ExternalProcessor>()
  for (const processor of input.persisted) processorsById.set(processor.instanceId, processor)
  const seed = input.seed
  if (seed?.projectId !== input.projectId) return [...processorsById.values()]

  const persistedProcessor = await input.readPersisted(input.projectId, seed.processor.instanceId)
  if (persistedProcessor && !persistedProcessor.bypassed && persistedProcessor.health.state !== "degraded") {
    processorsById.set(persistedProcessor.instanceId, persistedProcessor)
  } else if (persistedProcessor) {
    processorsById.delete(seed.processor.instanceId)
  } else {
    // The insertion has committed before the seed is created, but a direct
    // IndexedDB read can briefly lag that commit. The seed is the exact
    // processor returned by the successful insertion and is valid only for
    // this bound rebuild. Rollback rebuilds omit it.
    processorsById.set(seed.processor.instanceId, seed.processor)
  }
  return [...processorsById.values()]
}
