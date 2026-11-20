import { appendFileSync } from "node:fs"
import path from "node:path"
import type { ContentTracing } from "electron"
import { z } from "zod"
import type { DesktopRequestV2 } from "@daw-browser/desktop-protocol"

export type HostEvidence = (event: string, fields?: Record<string, string | number | boolean | null>) => void

type AppEvidence = HostEvidence & { rendererSend(): void; rendererSendCount(): number }

// Private, opt-in acceptance evidence. Never serialize native payloads or state. A write that fails is dropped, so evidence
// never throws into the control path it observes.
export const createAe08Evidence = (directory: string | undefined): AppEvidence | undefined => {
  if (!directory) return undefined
  let rendererSends = 0

  return Object.assign(
    (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
      try {
        appendFileSync(path.join(directory, "host.jsonl"), `${JSON.stringify({
          event, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...fields,
        })}\n`, { mode: 0o600 })
      } catch {
        return
      }
    },
    {
      rendererSend: () => { rendererSends += 1 },
      rendererSendCount: () => rendererSends,
    },
  )
}

// Opt-in Chromium trace of every process (DAW_AE08_TRACE=1 beside the evidence directory), written to trace.json at quit. Names the
// main-thread tasks that overlap a stalled window. Tracing slows the app, so latency gate runs must not carry it.
// The tracer is passed in, because the module is also loaded outside Electron, where a value import of it fails.
let tracing: ContentTracing | undefined

export const ae08StartTrace = async (contentTracing: ContentTracing) => {
  if (!process.env.DAW_AE08_EVIDENCE_DIR || process.env.DAW_AE08_TRACE !== "1") return
  tracing = contentTracing
  await contentTracing.startRecording({
    included_categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "v8.execute", "blink", "toplevel", "ipc",
      "disabled-by-default-v8.gc", "cc"],
    recording_mode: "record-continuously",
    trace_buffer_size_in_events: 50_000_000,
  })
}

// Runs before the renderer is destroyed, because a renderer that has exited cannot flush its buffered events.
export const ae08StopTrace = async () => {
  const directory = process.env.DAW_AE08_EVIDENCE_DIR
  const tracer = tracing

  if (!directory || !tracer) return
  tracing = undefined
  await tracer.stopRecording(path.join(directory, "trace.json"))
}

const commitKey = z.object({ idempotencyKey: z.string() })

// The moment a control commit reaches the app, before the renderer sees it. The acceptance runner counts edit-to-publish from this
// line, so the CLI process that sent the commit is not part of the measured time. The key names the commit.
export const ae08ControlCommitReceived = (
  evidence: HostEvidence | undefined,
  frame: Pick<DesktopRequestV2, "operation" | "input">,
) => {
  if (frame.operation !== "control.commit") return
  const commit = commitKey.safeParse(frame.input)

  if (!commit.success) return
  evidence?.("control-commit-received", { idempotencyKey: commit.data.idempotencyKey })
}
