import { expect, test } from "bun:test"
import { nativeSessionOperations } from "./native-session-operations"

test("each envelope operation keeps its wire channel", () => {
  expect(Object.fromEntries(Object.entries(nativeSessionOperations).map(([name, operation]) => [name, operation.channel]))).toEqual({
    installAsset: "daw:audio-host:session:install-asset",
    releaseAsset: "daw:audio-host:session:release-asset",
    createMappedAsset: "daw:audio-host:session:create-mapped-asset",
    writeMappedAssetPage: "daw:audio-host:session:write-mapped-asset-page",
    prepareMappedAssetRange: "daw:audio-host:session:prepare-mapped-asset-range",
    releaseMappedAsset: "daw:audio-host:session:release-mapped-asset",
    detachVst: "daw:audio-host:session:detach-vst",
    publishGraph: "daw:audio-host:session:publish-graph",
    configureInstrumentStates: "daw:audio-host:session:configure-instrument-states",
    queueParameterEvents: "daw:audio-host:session:queue-parameter-events",
    queueProcessorStatePatch: "daw:audio-host:session:queue-processor-state-patch",
    queueVstParameterEvents: "daw:audio-host:session:queue-vst-parameter-events",
    queueInstrumentEvents: "daw:audio-host:session:queue-instrument-events",
    queueScheduleWindow: "daw:audio-host:session:queue-schedule-window",
    reenableVstScheduleAutomation: "daw:audio-host:session:reenable-vst-schedule-automation",
    queueSourceEvents: "daw:audio-host:session:queue-source-events",
  })
})

test("operation requests accept the envelope the preload sends and refuse a missing token key", () => {
  const bytes = new Uint8Array([1])
  expect(nativeSessionOperations.publishGraph.request.safeParse({ value: bytes, transactionToken: undefined }).success).toBe(true)
  expect(nativeSessionOperations.publishGraph.request.safeParse({ value: bytes }).success).toBe(false)
  expect(nativeSessionOperations.releaseAsset.request.safeParse({ value: 0, transactionToken: undefined }).success).toBe(false)
})
