export type RendererLifecycleInvalidation = {
  previousGeneration: number
  generation: number
}

export type RendererLifecycleOwner = {
  generation(): number
  invalidate(): RendererLifecycleInvalidation | undefined
  markDocumentLoaded(): void
}

export const createRendererLifecycleOwner = (initialGeneration = 0): RendererLifecycleOwner => {
  let currentGeneration = initialGeneration
  let invalidated = false

  return {
    generation: () => currentGeneration,
    invalidate() {
      if (invalidated) return undefined
      const previousGeneration = currentGeneration
      currentGeneration += 1
      invalidated = true
      return { previousGeneration, generation: currentGeneration }
    },
    markDocumentLoaded() {
      invalidated = false
    },
  }
}
