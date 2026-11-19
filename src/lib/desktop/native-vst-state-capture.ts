type NativeVstStateCaptureInput = {
  capture: (instanceId: string) => Promise<void>
  report: (instanceId: string, error: Error) => void
}

// One capture runs per instance at a time; requests during each capture coalesce into a follow-up.
export const createNativeVstStateCapture = (input: NativeVstStateCaptureInput) => {
  const running = new Map<string, { again: boolean }>()
  return (instanceId: string) => {
    const active = running.get(instanceId)
    if (active) {
      active.again = true
      return
    }
    const entry = { again: false }
    running.set(instanceId, entry)
    void (async () => {
      do {
        entry.again = false
        try {
          await input.capture(instanceId)
        } catch (error) {
          input.report(instanceId, error instanceof Error ? error : new Error("The plug-in's state could not be read."))
        }
      } while (entry.again)
      running.delete(instanceId)
    })()
  }
}
