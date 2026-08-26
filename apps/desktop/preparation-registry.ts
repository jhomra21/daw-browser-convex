export const createPreparationRegistry = () => {
  const controllers = new Set<AbortController>()
  return {
    add(controller: AbortController) {
      controllers.add(controller)
    },
    delete(controller: AbortController) {
      controllers.delete(controller)
    },
    abortAll() {
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
    size: () => controllers.size,
  }
}
