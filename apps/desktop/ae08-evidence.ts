import { appendFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { DesktopRequestV2 } from "@daw-browser/desktop-protocol"

// Private, opt-in acceptance evidence. Never serialize native payloads or state.
export const ae08Evidence = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
  const directory = process.env.DAW_AE08_EVIDENCE_DIR
  if (!directory) return
  appendFileSync(path.join(directory, "host.jsonl"), `${JSON.stringify({
    event, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...fields,
  })}\n`, { mode: 0o600 })
}

const commitKey = z.object({ idempotencyKey: z.string() })

// The moment a control commit reaches the app, before the renderer sees it. The acceptance runner counts edit-to-publish from this
// line, so the CLI process that sent the commit is not part of the measured time. The key names the commit.
export const ae08ControlCommitReceived = (frame: Pick<DesktopRequestV2, "operation" | "input">) => {
  if (frame.operation !== "control.commit") return
  const commit = commitKey.safeParse(frame.input)
  if (commit.success) ae08Evidence("control-commit-received", { idempotencyKey: commit.data.idempotencyKey })
}
