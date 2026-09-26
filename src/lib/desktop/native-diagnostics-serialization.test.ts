import { expect, test } from "bun:test"
import { serializeNativeDiagnostics } from "./native-diagnostics-serialization"
import type { NativeHostDiagnostics } from "@daw-browser/audio-engine/native-host-wire"

test("serializes worker-authored watched Mix sequence to desktop JSON", () => {
  const serialized = serializeNativeDiagnostics({
    watchedMixHost: null,
    workerAutomation: null,
    watchedMixProcessed: { instanceId: "trusted", acceptedPoints: 1, lastParameterId: 48,
      transportEpoch: 9, sequence: 9007199254740993n },
    renderEpoch: 1n, lastRejectedCallback: 0n, lastRejectedRenderEpoch: 0n,
  } satisfies Pick<NativeHostDiagnostics, "workerAutomation" | "watchedMixProcessed" | "watchedMixHost" | "renderEpoch" | "lastRejectedCallback" | "lastRejectedRenderEpoch">)
  expect(serialized.watchedMixProcessed?.sequence).toBe("9007199254740993")
  expect(JSON.parse(JSON.stringify(serialized))).toEqual({
    workerAutomation: null,
    watchedMixHost: null,
    watchedMixProcessed: { instanceId: "trusted", acceptedPoints: 1, lastParameterId: 48,
      transportEpoch: 9, sequence: "9007199254740993" },
    renderEpoch: "1", lastRejectedCallback: "0", lastRejectedRenderEpoch: "0",
  })
})
