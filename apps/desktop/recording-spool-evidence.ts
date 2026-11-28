import type { RecordingSpoolReleaseEvent } from "./recording-spool"

export const createRecordingSpoolOrderEvidence = (flag: string | undefined, writeLine: (line: string) => void) => {
  if (flag !== "1") return undefined
  let events = 0
  let ready = false
  const write = (line: string) => {
    try { writeLine(line) } catch { /* Diagnostic output cannot veto I/O or startup. */ }
  }
  return {
    ready() {
      if (ready) return
      ready = true
      write('[recording-spool-order] {"version":1,"kind":"observer-ready"}\n')
    },
    observeRelease(event: RecordingSpoolReleaseEvent) {
      if (!ready || events === 16) return
      events++
      write(`[recording-spool-order] ${JSON.stringify(event)}\n`)
    },
  }
}
