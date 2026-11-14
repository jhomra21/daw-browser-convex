import type { ae08RendererMarks } from "@daw-browser/desktop-protocol/ipc-channels"

export type Ae08RendererMark = (typeof ae08RendererMarks.options)[number]

// Opt-in acceptance evidence: the bridge offers `ae08Mark` only when the app runs with DAW_AE08_EVIDENCE_DIR, so with it off a
// call is one property read and `key` never runs.
export const ae08Mark = (name: Ae08RendererMark, key: () => string | undefined) => {
  const mark = globalThis.window?.dawDesktop?.ae08Mark
  if (!mark) return
  const value = key()
  if (value !== undefined) mark(name, value)
}

// Marks one adoption's path. Its intent key is a whole schedule fingerprint, so the marks carry an FNV-1a hash of it. Undefined
// while the channel is off.
export const ae08AdoptionMarker = (intentKey: string | undefined) => {
  const mark = globalThis.window?.dawDesktop?.ae08Mark
  if (!mark || intentKey === undefined) return undefined
  let hash = 0x811c9dc5
  for (let index = 0; index < intentKey.length; index++) hash = Math.imul(hash ^ intentKey.charCodeAt(index), 0x01000193)
  const key = (hash >>> 0).toString(16)
  return (name: Ae08RendererMark) => mark(name, key)
}
