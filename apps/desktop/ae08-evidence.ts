import { appendFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { ContentTracing, Debugger, WebContents } from "electron"
import { z } from "zod"
import type { DesktopRequestV2 } from "@daw-browser/desktop-protocol"
import { ae08RendererMarks } from "@daw-browser/desktop-protocol/ipc-channels"

// Private, opt-in acceptance evidence. Never serialize native payloads or state.
export const ae08Evidence = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
  const directory = process.env.DAW_AE08_EVIDENCE_DIR
  if (!directory) return
  appendFileSync(path.join(directory, "host.jsonl"), `${JSON.stringify({
    event, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...fields,
  })}\n`, { mode: 0o600 })
}

// Opt-in renderer CPU profile, one file per control commit: it runs from a commit's arrival to the next commit's arrival.
// Needs DAW_AE08_RENDERER_PROFILE as well, because sampling slows the renderer and latency gate runs must not carry it.
// The commit queue is module state, only touched when the profile is on.
let rendererProfile: { session: Debugger; open: string | undefined; queue: Promise<void> } | undefined

export const ae08AttachRendererProfile = (contents: WebContents) => {
  if (!process.env.DAW_AE08_EVIDENCE_DIR || !process.env.DAW_AE08_RENDERER_PROFILE) return
  contents.debugger.attach("1.3")
  const session = contents.debugger
  rendererProfile = {
    session, open: undefined,
    queue: session.sendCommand("Profiler.enable")
      .then(() => session.sendCommand("Profiler.setSamplingInterval", { interval: 200 })),
  }
}

const ae08ProfileCommit = (key: string) => {
  const directory = process.env.DAW_AE08_EVIDENCE_DIR
  const state = rendererProfile
  if (!directory || !state) return
  state.queue = state.queue.then(async () => {
    if (state.open) {
      const { profile } = await state.session.sendCommand("Profiler.stop")
      await writeFile(path.join(directory, `renderer-profile-${state.open}.json`),
        JSON.stringify({ key: state.open, endWallMs: Date.now(), profile }))
    }
    state.open = key
    await state.session.sendCommand("Profiler.start")
  }).catch((error) => console.error("[ae08] renderer profile failed", error))
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
export const ae08ControlCommitReceived = (frame: Pick<DesktopRequestV2, "operation" | "input">) => {
  if (frame.operation !== "control.commit") return
  const commit = commitKey.safeParse(frame.input)
  if (!commit.success) return
  ae08Evidence("control-commit-received", { idempotencyKey: commit.data.idempotencyKey })
  ae08ProfileCommit(commit.data.idempotencyKey)
}

// A renderer mark of the edit-to-publish path: its name and the commit's idempotency key or an adoption's hash.
export const ae08RendererMarkSchema = z.tuple([ae08RendererMarks, z.string().max(64)])
