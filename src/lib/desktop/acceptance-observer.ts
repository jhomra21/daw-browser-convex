import type { ae08RendererMarks } from "@daw-browser/desktop-protocol/acceptance-marks"
import type { DesktopBridge } from "~/types/desktop-bridge"

type AcceptanceMark = (typeof ae08RendererMarks.options)[number]

export type PlaybackAcceptanceObserver = {
  /** False when another process owns the native session, so this renderer never acquires or retires it. */
  ownsNativeSession: boolean
  /** Marks `name` with the key `key` returns; `key` runs only while the bridge records marks. */
  mark: (name: AcceptanceMark, key: () => string | undefined) => void
  /** The moment the UI commits an edit made in the app window. Target ids are not bounded, so the mark carries an FNV-1a hash of the one the edit names. */
  ui: (name: AcceptanceMark, target: () => string) => void
  /** Marks one adoption's path. Its intent key is a whole schedule fingerprint, so the marks carry an FNV-1a hash of it. */
  adoption: (intentKey: string | undefined) => ((name: string) => void) | undefined
}

// Observation must never throw into, or gate, the product path that reports it.
const contained = (observe: () => void) => {
  try { observe() } catch { /* evidence is best-effort */ }
}

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)

  return (hash >>> 0).toString(16)
}

/** The observer shape the native playback controller takes: who owns the session, plus the adoption and mark hooks. */
export const nativeControllerObserver = (acceptance: PlaybackAcceptanceObserver | undefined) => acceptance && {
  adoption: acceptance.adoption,
  mark: acceptance.mark,
  externalSessionOwner: !acceptance.ownsNativeSession,
}

// The bridge offers `acceptance` only when the app runs with DAW_AE08_EXTERNAL_NATIVE_SESSION or DAW_AE08_EVIDENCE_DIR, and
// `acceptance.mark` only with the latter. Without an observer a call site pays one optional chain and no key runs.
export const desktopAcceptanceObserver = (bridge: Pick<DesktopBridge, "acceptance"> | undefined): PlaybackAcceptanceObserver | undefined => {
  const acceptance = bridge?.acceptance

  if (!acceptance) return undefined
  const { mark } = acceptance

  return {
    ownsNativeSession: !acceptance.externalNativeSession,
    mark: (name, key) => {
      if (!mark) return
      contained(() => {
        const value = key()

        if (value !== undefined) mark(name, value)
      })
    },
    ui: (name, target) => {
      if (mark) contained(() => mark(name, fnv1a(target())))
    },
    adoption: (intentKey) => {
      if (!mark || intentKey === undefined) return undefined
      const key = fnv1a(intentKey)

      return (name) => contained(() => mark(name, key))
    },
  }
}
