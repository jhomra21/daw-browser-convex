type CloseFlow = {
  prepare: () => Promise<boolean>
  confirmDiscard: () => Promise<boolean>
  destroy: () => void
  finishQuit: () => Promise<void>
}

export const createCloseHandler = (flow: CloseFlow) => {
  let inProgress = false
  return async () => {
    if (inProgress) return
    inProgress = true
    try {
      if (await flow.prepare()) {
        flow.destroy()
        await flow.finishQuit()
        return
      }
      if (await flow.confirmDiscard()) {
        flow.destroy()
        await flow.finishQuit()
      }
    } finally {
      inProgress = false
    }
  }
}
