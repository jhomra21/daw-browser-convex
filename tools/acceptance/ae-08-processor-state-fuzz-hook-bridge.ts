import type { DesktopAudioLifecycle } from "../../src/lib/desktop-audio-lifecycle"
import type createFuzzHost from "./ae-08-processor-state-fuzz-host"
import type { Action } from "./ae-08-processor-state-fuzz-host"
import type { createVirtualTime } from "./ae-08-processor-state-fuzz-virtual-time"

type Host = ReturnType<typeof createFuzzHost>

// The desktop audioHost bridge the mounted hook talks to: planted bridge faults,
// the lifecycle handshake, and the virtual supervisor deadline for the host's
// pending control command.
export default function createHookBridge({ h, time, mutation, compilations }: {
  h: Host; time: ReturnType<typeof createVirtualTime>; mutation?: string; compilations: Parameters<Host["act"]>[1]
}) {
  let rejectNative = false
  // Planted bridge faults, armed by scenario actions and inert without the plant.
  let dropDispatch = false
  let dropTransport = false
  let lifecycleListener: ((value: DesktopAudioLifecycle) => void) | undefined
  let lifecycleReady = false
  let resolveLifecycle: ((value: { state: "ready"; powerGeneration: number }) => void) | undefined
  let supervisor: { command: number; timer: number; kind: string } | undefined
  const audioHost = {
    ...h.bridge,
    session: { ...h.bridge.session,
      queueParameterEvents: (bytes: Uint8Array) => rejectNative
        ? h.simple("mutation-native-rejection").then(() => ({ ok: false, error: "mutation native failed" }))
        : dropDispatch ? h.simple("mutation-dropped-dispatch") : h.bridge.session.queueParameterEvents(bytes),
      queueProcessorStatePatch: (bytes: Uint8Array) => dropDispatch
        ? h.simple("mutation-dropped-dispatch") : h.bridge.session.queueProcessorStatePatch(bytes),
      setTransport: (value: Parameters<typeof h.bridge.session.setTransport>[0]) => dropTransport
        ? h.simple("mutation-dropped-transport") : h.bridge.session.setTransport(value) },
    getLifecycle: () => new Promise<{ state: "ready"; powerGeneration: number }>((resolve) => { resolveLifecycle = resolve }),
    onLifecycle: (listener: typeof lifecycleListener) => { lifecycleListener = listener; return () => { lifecycleListener = undefined } },
  }
  return {
    audioHost,
    rejectNative: () => { rejectNative = true },
    arm: (action: Action) => {
      if (mutation === "drop-dispatch" && action.mode !== "transport") dropDispatch = action.value !== 0
      if (mutation === "drop-transport" && action.mode === "transport") dropTransport = action.value !== 0
    },
    lifecycle: {
      isReady: () => lifecycleReady,
      ready: () => {
        lifecycleReady = true
        resolveLifecycle?.({ state: "ready", powerGeneration: 0 })
        lifecycleListener?.({ state: "ready", powerGeneration: 0 })
      },
      suspend: () => lifecycleListener?.({ state: "suspended", powerGeneration: 1 }),
    },
    synchronizeSupervisor: () => {
      const pending = h.pendingControl
      if (supervisor?.command === pending?.id) return
      if (supervisor) time.cancelExternal(supervisor.timer)
      supervisor = undefined
      if (!pending) return
      const kind = ["prepare", "publish", "inspect", "rollback", "retire"].includes(pending.name) ? "revision-deadline" : "control-watchdog"
      const command = pending.id
      const timer = time.scheduleDeadline(`audio-host supervisor ${kind} (${pending.name})`, () => {
        h.act({ kind, id: command }, compilations, h.lose, () => {})
      })
      supervisor = { command, kind, timer }
    },
  }
}
