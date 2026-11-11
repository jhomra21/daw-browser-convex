import { appendFileSync } from "node:fs"
import path from "node:path"

// Private, opt-in acceptance evidence. Never serialize native payloads or state.
export const ae08Evidence = (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
  const directory = process.env.DAW_AE08_EVIDENCE_DIR
  if (!directory) return
  appendFileSync(path.join(directory, "host.jsonl"), `${JSON.stringify({
    event, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...fields,
  })}\n`, { mode: 0o600 })
}
