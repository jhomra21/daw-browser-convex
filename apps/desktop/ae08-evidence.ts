import { appendFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { Debugger, WebContents } from "electron"
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
