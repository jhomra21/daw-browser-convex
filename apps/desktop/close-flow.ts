type CloseFlow = {
  waitForRecording?: () => Promise<boolean>
  onError?: (error: Error) => void | Promise<void>
  prepareQuit?: () => Promise<void>
  prepare: () => Promise<boolean>
  confirmDiscard: () => Promise<boolean>
  beginQuit: () => void
  destroy: () => void
  finishQuit: () => Promise<void>
}

export const createCloseHandler = (flow: CloseFlow) => {
  let inProgress = false
  return async () => {
    if (inProgress) return
    inProgress = true
    try {
      if (flow.waitForRecording && !await flow.waitForRecording()) return
      if (!await flow.prepare() && !await flow.confirmDiscard()) return
      if (flow.waitForRecording && !await flow.waitForRecording()) return
      await flow.prepareQuit?.()
      flow.beginQuit()
      flow.destroy()
      await flow.finishQuit()
    } catch (error) {
      if (!flow.onError) throw error
      await flow.onError(error instanceof Error ? error : new Error("Close preparation failed."))
    } finally {
      inProgress = false
    }
  }
}
