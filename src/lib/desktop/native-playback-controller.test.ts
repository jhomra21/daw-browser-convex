import { describe, expect, spyOn, test } from "bun:test"
import "fake-indexeddb/auto"
import { z } from "zod"
import { convexTest } from "convex-test"
import schema from "../../../convex/schema"
import { createRenderEffect, createRoot, createSignal, untrack } from "solid-js"

import { createNativePlaybackController, nativePlaybackFaultText, type NativePlaybackFault } from "./native-playback-controller"
import { classifyNativeVst3PlaybackFault, nativeVst3LaunchAuthorizationRequiredMessage } from "~/lib/external-plugin-ui"
import { createNativeProcessorStateOwner } from "./native-processor-state-owner"
import { clearInstanceLimits, instanceLimit, vstInstanceFailed } from "./vst-instance-failures"
import type { DesktopVstInstanceEvent } from "@daw-browser/desktop-protocol"
import { compileDesiredNativeProcessorState, compileLivePlaybackSnapshot, type LivePlaybackCompileContext, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot"
import { audioCoreContractVersion, encodeUtilityProcessorState, type AudioAssetRef } from "@daw-browser/audio-core-contract"
import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry"
import { createPersistedEffectState } from "~/components/timeline/create-persisted-effect-state"
import { ParameterGestureHolder } from "~/components/timeline/parameter-gesture-owner"
import { createEffectsPanelAudioDevice } from "~/components/timeline/create-effects-panel-audio-effects-state"
import { createEffectsPanelInstrumentDevice } from "~/components/timeline/create-effects-panel-state"
import { createLocalEffectsViewOwner, type LocalEffectsView } from "~/components/timeline/create-local-effects-view"
import { useEffectsPanelAudioSync } from "~/hooks/useEffectsPanelAudioSync"
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync"
import { captureNativeBuiltInParameterValues, captureNativeBuiltInStateCommit, nativeBuiltInPatchTiming, type NativeBuiltInParameterPayload } from "./native-built-in-parameter-mapper"
import { SampledInstrumentSyncSupersededError } from "~/lib/sampled-instrument-sync-error"
import type { RuntimeTrack } from "~/lib/timeline-runtime-types"
import { createAudioPcmSourceDescriptor } from "@daw-browser/audio-engine/media-pages"
import { createAudioStretchCache } from "@daw-browser/audio-engine/audio-stretch-cache"
import { createPreparedStretchArtifactRepository } from "@daw-browser/audio-engine/prepared-stretch-store"
import { compileLiveNativeProjection } from "@daw-browser/audio-engine/live-native-projection"
import { getEffectTiming } from "@daw-browser/audio-engine/effects/timing"
import { automationTargetKey, createDefaultDelayParams, normalizeDelayParams, createDefaultDrumRackParams, createDefaultGranularParams, createDefaultSamplerParams, createDefaultReverbParams, createDefaultSpectralParams, createDefaultSynthParams, createDefaultUtilityParams, mergeSynthParams, AUDIO_EFFECT_CONTRACTS, externalAutomationParameterId, type AudioPcmSourceDescriptor, type TrackInstrumentParams, type SamplerZone, type SynthParamsUpdate } from "@daw-browser/shared"
import { nativeGraphNodeId, serializeNativeGraph, serializeNativeInstrumentStates, serializeNativeProcessorEvents, type NativeHostMappedAsset, type NativeHostMappedAssetPage, type NativeHostMeterBatch, type NativeHostPcmAsset, type NativeHostRecordingStatus, type NativeHostSpectrumFrame, type NativeHostTransport, type NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import { listLocalEffects, setLocalEffect, setLocalEffectInstance } from "~/lib/local-effects"
import { AudioEngine, type AudioEffectRuntimeInstance, type SpectrumFrame } from "@daw-browser/audio-engine/audio-engine"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import { externalProcessorSchema, type ExternalProcessor } from "@daw-browser/external-plugins"
import type { NativeRecordingTake, NativeRecordingFailure, NativeDeliveryReply, NativeProcessorPatchReply } from "~/types/desktop-bridge"
import type { EffectParamsCommitPayload } from "~/lib/undo/types"
import { sampledInstrumentRegionIdentity } from "@daw-browser/audio-engine/sampled-instrument-region"
import { createSampledInstrumentRegionBudget } from "~/lib/sampled-instrument-region-budget"
import { createSamplerBufferSync } from "~/lib/sampler-buffer-sync"
import { compilePortableSynthState } from "@daw-browser/audio-engine/mixer/graph-contract"
import { nativeInstrumentContentKey, type LiveProcessorControlRequest, type LiveProcessorEditIdentity, type ProcessorDeliveryOutcome, type ProcessorDelivery } from "~/lib/live-processor-control"
import type { ParameterSaveResult } from "~/components/timeline/parameter-gesture-owner"
import type { NativeRevisionSession, NativeRevisionReply, NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"
import { publishDurableEffectsOperation, flushSharedOutbox, readSharedOutboxOperation } from "~/lib/shared-outbox"
import createControllerFixture from "../../../tools/acceptance/ae-08-processor-state-fuzz-fixture"
import { decodeGraph, fields } from "../../../tools/acceptance/ae-08-processor-state-fuzz-oracle"
import createFuzzHost from "../../../tools/acceptance/ae-08-processor-state-fuzz-host"

// B6a3 failure inventory, before product edits: cancellation is not application;
// proof wins only for its own bank; preconditions send nothing; typed failures
// retain their caller routing; invalid/unsent parameters never acquire proof.
describe("B6a3 terminal-routing truth table", () => {
  test("unchanged is a no-op, while changed membership before prepare is unprepared", async () => {
    const fixture = createBridge()
    let keep = new Set<string>()
    const controller = createObservedController({ bridge: fixture.bridge,
      getKeepLatencyNodeIds: () => keep, compileSnapshot: async () => compileLivePlaybackSnapshot(input()) })
    try {
      expect("queueBuiltInParameterEvents" in controller).toBe(false)
      expect(await controller.updateKeepLatency()).toEqual({ handled: true })
      keep = new Set(["track"])
      expect(await controller.updateKeepLatency()).toEqual({ handled: false, reason: "unprepared" })
      expect(fixture.calls).toEqual([])
    } finally { await controller.dispose() }
  })

  for (const kind of ["refused", "unconfirmed", "unavailable"] satisfies readonly Extract<NativeDeliveryReply, { ok: false }>["kind"][]) {
    test(`typed ${kind} prepare retains its caller-visible failure`, async () => {
      const f = await step7LatencyFixture()
      f.fixture.bridge.session.revisions.prepare = async () => ({ ok: false, kind, error: "same diagnostic" })
      try {
        expect(await f.update(["track"])).toEqual({
          handled: false, reason: kind === "refused" ? "bridge-error" : kind, error: "same diagnostic",
        })
        expect(f.controller.isPrepared()).toBe(true)
        expect(f.fixture.calls).not.toContain("revision-publish")
      } finally { await f.close() }
    })
  }

  test("latency-unsupported preserves its actionable diagnostic without publication", async () => {
    const f = await step7LatencyFixture()
    const prepare = f.fixture.bridge.session.revisions.prepare
    f.fixture.bridge.session.revisions.prepare = async request => {
      const reply = await prepare(request)
      return reply.ok ? { ...reply, revision: { ...reply.revision,
        status: "prepare-failed", continuity: "rejected", preparedRevision: 0, diagnosticCode: 3 } } : reply
    }
    try {
      expect(await f.update(["track"])).toEqual({ handled: false, reason: "latency-unsupported",
        error: "Keep Latency can't be used here: this bus mixes monitored and other tracks, then splits to outputs with different latency. Route them through separate buses." })
      expect(f.fixture.calls).not.toContain("revision-publish")
    } finally { await f.close() }
  })

  test("stale and invalid attachment preconditions send nothing", async () => {
    const f = await step7LatencyFixture(true)
    const attachment = nativeAttachmentPlan.attachments[0]
    if (!attachment) throw new Error("Missing attachment")
    const instanceId = attachment.instanceId
    const generation = f.controller.attachmentGeneration(instanceId)
    if (generation === undefined) throw new Error("Missing attachment generation")
    try {
      const before = [...f.fixture.calls]
      expect(await f.controller.publishAttachmentLatency({ instanceId, generation: generation + 1, latencyFrames: 1024 }))
        .toEqual({ handled: false, reason: "stale" })
      for (const latencyFrames of [-1, 0.5, 65_537, Number.NaN, Number.POSITIVE_INFINITY])
        expect(await f.controller.publishAttachmentLatency({ instanceId, generation, latencyFrames }))
          .toEqual({ handled: false, reason: "invalid-latency" })
      expect(f.fixture.calls).toEqual(before)
    } finally { await f.close() }
  })

  for (const proofWins of [false, true]) {
    test(`cancellation with published proof=${proofWins} keeps its actual caller disposition`, async () => {
      const f = await step7LatencyFixture()
      await f.controller.start(input().transport)
      let published = false
      f.fixture.bridge.session.revisions.publish = async () => f.fixture.revisionReply("publish-pending")
      f.fixture.bridge.session.revisions.inspect = async () => f.fixture.revisionReply(published ? "published" : "publish-pending")
      const rollback = f.fixture.bridge.session.revisions.rollback
      f.fixture.bridge.session.revisions.rollback = async request => {
        const reply = await rollback(request)
        // Cancellation retains revision 1; its transport ACK must name that bank.
        f.fixture.setRuntimeRevision(1)
        return reply
      }
      try {
        const update = step7Watch(f.update(["track"]))
        await step7Turns()
        expect(update.answers).toBe(0)
        published = proofWins
        await f.controller.pause(0)
        await step7Turns()
        expect(update.value).toEqual(proofWins ? { handled: true } : { handled: false, reason: "unconfirmed" })
        expect(update.answers).toBe(1)
        expect(f.fixture.calls.filter(call => call === "revision-rollback")).toHaveLength(proofWins ? 0 : 1)
      } finally { await f.close() }
    })
  }

  test("unsent invalid parameters are refused without native dispatch or false application", async () => {
    const fixture = createBridge()
    const controller = createObservedController({ bridge: fixture.bridge,
      compileSnapshot: async () => compileLivePlaybackSnapshot(utilityPlaybackInput()) })
    try {
      const edit = fixtureParameterEdit({ instanceId: "utility:1", values: [{ parameterId: "utility.pan", value: 0.25 }] })
      expect(await controller.deliverProcessor(edit).settled).toEqual({ state: "unavailable" })
      expect(await controller.ensureLivePreview(0)).toBe("started")
      const before = fixture.builtInParameterPayloads.length
      expect(await controller.deliverProcessor(fixtureParameterEdit({ instanceId: "utility:1",
        values: [{ parameterId: "utility.unknown", value: 0.25 }] })).settled)
        .toEqual({ state: "refused", reason: "unsupported" })
      expect(fixture.builtInParameterPayloads).toHaveLength(before)
      expect(fixture.statePatchPayloads).toHaveLength(0)
    } finally { await controller.dispose() }
  })

  test("published proof followed by host loss during retirement reports unprepared", async () => {
    const f = await step7LatencyFixture()
    let retirements = 0
    f.fixture.bridge.session.revisions.retire = async () => {
      retirements++
      f.fixture.emitLoss("B6a3 loss after published proof")
      return { ok: false, kind: "unavailable", error: "host lost during retirement" }
    }
    try {
      const result = await f.update(["track"])
      console.log("B6A3-PROOF-LOSS", JSON.stringify({ result, retirements, prepared: f.controller.isPrepared() }))
      expect(result).toEqual({ handled: false, reason: "unprepared" })
      expect(retirements).toBe(1)
      expect(f.controller.isPrepared()).toBe(false)
      expect(f.fixture.listenerCounts()).toEqual({ progress: 0, loss: 0 })
    } finally { await f.close() }
  })
})

type TestController = ReturnType<typeof createNativePlaybackController>
type TestCompilation = Awaited<ReturnType<Parameters<typeof createNativePlaybackController>[0]["compileSnapshot"]>>
type CompileCheckpoint = {
  entered: PromiseWithResolvers<TestCompilation>
  released: PromiseWithResolvers<void>
}
type CompileObservation = { next?: CompileCheckpoint }
const compileCheckpoints = new WeakMap<TestController, CompileObservation>()
// Observe and stop the actual compile callback. The controller still owns every
// candidate, and only public intents, drops and domain ends control its lifetime.
const createObservedController = (input: Parameters<typeof createNativePlaybackController>[0]): TestController => {
  const observation: CompileObservation = {}
  const controller = createNativePlaybackController({ ...input, compileSnapshot: async (...args) => {
    const checkpoint = observation.next
    observation.next = undefined
    const compilation = await input.compileSnapshot(...args)
    if (checkpoint) {
      checkpoint.entered.resolve(compilation)
      await checkpoint.released.promise
    }
    return compilation
  } })
  compileCheckpoints.set(controller, observation)
  return controller
}
const holdCompile = (controller: TestController) => {
  const observation = compileCheckpoints.get(controller)
  if (!observation || observation.next) throw new Error("Compile checkpoint is not available")
  const checkpoint: CompileCheckpoint = { entered: Promise.withResolvers<TestCompilation>(), released: Promise.withResolvers<void>() }
  observation.next = checkpoint
  return { entered: checkpoint.entered.promise, release: () => checkpoint.released.resolve() }
}
const migrationIntent = (key: string) => ({ key, schedule: key, context: {},
  loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
const capturedGraph = (snapshot: Extract<TestCompilation, { supported: true }>["snapshot"]) => {
  const projected = compileLiveNativeProjection({ tracks: snapshot.tracks, bpm: snapshot.bpm,
    sampleRateHz: 48000, revision: snapshot.revision, epoch: 1, firstSequence: 1, fx: snapshot.mixer.fx,
    instrumentRegionMode: "metadata" })
  if (!projected.supported) throw new Error(projected.reasons.join("; "))
  return projected.graph
}

type Step6Action = Parameters<ReturnType<typeof createControllerFixture>["act"]>[0]

// Public adoption only. The existing deterministic host owns callback claim, ACK,
// deadlines, asset readers and reclamation; promise checkpoints do not render.
const step6Scheduler = (fixture: ReturnType<typeof createControllerFixture>, stretch = false, observe = false) => {
  const act = async (action: Step6Action) => { fixture.act(action); await fixture.checkpoint(); if (observe) fixture.observe() }
  let turn = 0
  const next = () => {
    const enabled = fixture.enabled()
    const frameAction = turn++ % 2 === 0 ? "render-block" : "deliver-progress"
    return enabled.find(action => !["render-block", "render-open", "render-close", "deliver-progress",
      "revision-deadline", "control-watchdog"].includes(action.kind))
      ?? (fixture.needsReclaim() ? { kind: "reclaim" }
        : enabled.find(action => action.kind === frameAction) ?? enabled.find(action => action.kind === "render-block"))
  }
  const advance = async (count = 300) => {
    for (let index = 0; index < count; index++) {
      if (stretch) await fixture.storage()
      if (fixture.pending().length === 0 && !fixture.enabled().some(action => action.id !== undefined)
        && !fixture.nativeWork()) break
      const action = next()
      if (!action) break
      await act(action)
    }
  }
  const execute = async (name: string) => {
    const before = fixture.state().counts[name] ?? 0
    for (let index = 0; index < 1000; index++) {
      const action = fixture.enabled().find(action => action.kind === "control-wake" && fixture.commandName(action.id) === name)
      if (action) {
        await act(action)
        // A Publish that did not request publication is native's seam rebind: run through it to the armed one.
        if (name === "publish" && !fixture.state().publicationRequested) continue
        return
      }
      const actionBefore = next()
      if (!actionBefore) break
      await act(actionBefore)
    }
    expect(fixture.state().counts[name] ?? 0, `Native ${name} must reach the free execution lane`).toBeGreaterThan(before)
    throw new Error(`STEP6 fixture did not reach ${name}`)
  }
  const deliver = async (name: string) => {
    const action = fixture.enabled().find(action => action.kind === "deliver-reply" && fixture.replyName(action.id) === name)
    if (!action) throw new Error(`STEP6 fixture has no ${name} reply`)
    await act(action)
  }
  const controls = async (count = 100) => {
    for (let index = 0; index < count; index++) {
      const action = fixture.enabled().find(action => action.kind === "control-wake" || action.kind === "deliver-reply")
      if (!action) break
      await act(action)
    }
  }
  const deadline = async () => {
    const action = fixture.enabled().find(action => action.kind === "revision-deadline")
    if (!action) throw new Error("STEP6 fixture has no revision deadline")
    await act(action)
  }
  const claim = async () => {
    for (let index = 0; index < 1000 && !fixture.state().publicationClaimed; index++) {
      const action = next()
      if (!action) break
      await act(action)
    }
    expect(fixture.state().publicationClaimed).toBe(true)
  }
  return { fixture, act, advance, controls, execute, deliver, deadline, claim, next }
}
const step6Publication = async (releaseCompile = true, instrument: boolean | "key-only" = false, stretch = false, registry = false) => {
  const fixture = createControllerFixture(() => {}, undefined, false, false, false, registry, instrument, false, false, stretch)
  const scheduler = step6Scheduler(fixture, stretch)
  const { act, advance, next } = scheduler
  await act({ kind: "start" }); await advance()
  expect(fixture.state().activeRevision).toBe(1)
  await act({ kind: "sample", value: 1 })
  await act({ kind: "mark-compiles" })
  await act({ kind: "submit-schedule", mode: "A" })
  for (let index = 0; index < 100 && !fixture.enabled().some(action => action.kind === "resolve-compile"); index++) {
    const action = next()
    if (!action) break
    await act(action)
  }
  const compile = fixture.enabled().find(action => action.kind === "resolve-compile")
  if (!compile) throw new Error("STEP6 adoption did not open its compile")
  if (releaseCompile) await act(compile)
  return { ...scheduler, compile,
    outcome: () => fixture.state().waiters.find(waiter => waiter.name === "schedule-adoption:A"),
    close: async () => { await act({ kind: "loss" }); await act({ kind: "dispose" }); await advance() } }
}

// STEP7 failure inventory: STEP7-PLAN §7, frozen before product work. These
// bounded loops execute named host events; they never poll time or render in
// the control-only observation. A failed expectation is an ordinary red test.
const step7BigInt = z.bigint()
const step7Evidence = <Value,>(witness: string, value: Value) =>
  console.log("STEP7-EVIDENCE", JSON.stringify({ witness, value }, (_, item) => {
    const parsed = step7BigInt.safeParse(item)
    return parsed.success ? parsed.data.toString() : item
  }))
const step7Host = async (attachment = false, instrument = false,
  beforeStart?: (fixture: ReturnType<typeof createControllerFixture>) => void) => {
  const events: unknown[] = []
  const fixture = createControllerFixture(event => events.push(event), undefined, false, false, attachment, false, instrument)
  beforeStart?.(fixture)
  const scheduler = step6Scheduler(fixture, false, true)
  const { act, advance } = scheduler
  await act({ kind: "start" }); await advance()
  expect(fixture.state().activeRevision).toBe(1)
  const controlTrace: { action: Step6Action; name?: string; frame: bigint }[] = []
  const controls = async (bound = 64) => {
    for (let index = 0; index < bound; index++) {
      const action = fixture.enabled().find(entry => entry.kind === "control-wake" || entry.kind === "deliver-reply")
      if (!action) break
      controlTrace.push({ action, name: action.kind === "control-wake" ? fixture.commandName(action.id) : fixture.replyName(action.id),
        frame: fixture.state().frame })
      await act(action)
    }
  }
  const until = async (predicate: () => boolean, bound = 300) => {
    for (let index = 0; index < bound && !predicate(); index++) {
      const action = scheduler.next()
      if (!action) break
      await act(action)
    }
    expect(predicate(), "Explicit host schedule must reach its premise").toBe(true)
  }
  const close = async () => { await act({ kind: "loss" }); await act({ kind: "dispose" }); await advance() }
  return { ...scheduler, controls, until, close, events, controlTrace }
}

describe("DV01 STEP7 retirement recovery", () => {
  test("W47 schedule Prepare waits for real latency completion without spending retries", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "sample", value: 1 }); await f.act({ kind: "block-asset", value: 1 })
      await f.act({ kind: "submit-schedule", mode: "A" }); await f.advance()
      await f.act({ kind: "latency", value: 4096, sequence: 20 }); await f.advance()
      expect(f.fixture.state().latencyReadyEpoch).toBeDefined()
      await f.act({ kind: "block-asset", value: 0 }); await f.act({ kind: "grant-capacity" })
      await f.act({ kind: "deliver-progress" }); await f.execute("prepare"); await f.deliver("prepare"); await f.controls()
      const prepares = f.fixture.state().counts.prepare
      step7Evidence("prepare-readiness-before-frames", f.fixture.state())
      for (let index = 0; index < 12; index++) {
        await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
      }
      expect(f.fixture.state().latencyReadyEpoch).toBeDefined()
      expect(f.fixture.state().counts.prepare).toBe(prepares)
      expect(f.fixture.adoptionRunning()).toBe(true)
      await f.until(() => f.fixture.state().latencyReadyEpoch === undefined)
      await f.advance()
      expect(f.fixture.state().counts.prepare).toBe(prepares + 1)
      expect(f.fixture.adoptionRunning()).toBe(false)
      expect(f.fixture.adoptionRetained()).toBe(false)
      expect(f.fixture.state().actual.fft).toBe(4096)
      const counts = f.fixture.state().counts
      await f.act({ kind: "deliver-progress" }); await f.controls()
      expect(f.fixture.state().counts).toEqual(counts)
      step7Evidence("prepare-readiness", f.fixture.state())
    } finally { await f.close() }
  })
  test("W47 lost Retire retains cleanup through real completion", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "sample", value: 1 }); await f.act({ kind: "submit-schedule", mode: "asset" }); await f.advance()
      await f.act({ kind: "latency", value: 2048 })
      await f.execute("retire"); await f.deadline()
      expect(f.fixture.state().retiredRevision).toBeDefined()
      expect(f.fixture.state().leases[0]?.reclaimed).toBe(false)
      for (let index = 0; index < 40; index++) {
        await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
      }
      expect(f.fixture.state().latencyReadyEpoch).toBeUndefined()
      expect(f.fixture.state().retiredRevision).toBeUndefined()
      expect(f.fixture.state().leases[0]?.releases).toBe(0)
      const counts = f.fixture.state().counts
      await f.act({ kind: "deliver-progress" }); await f.controls()
      expect(f.fixture.state().counts).toEqual(counts)
      step7Evidence("lost-retire-recovery", f.fixture.state())
    } finally { await f.close() }
  })
  test("W47 predecessor Stretch lease waits for native reader proof", async () => {
    const f = await step6Publication(true, false, true)
    try {
      await f.advance()
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 0 })
      const previous = f.fixture.state().activeRevision
      await f.act({ kind: "sample", value: 0 })
      await f.act({ kind: "submit-schedule", mode: "remove" })
      for (let index = 0; index < 300 && f.fixture.state().activeRevision === previous; index++) {
        await f.fixture.storage()
        const action = f.next()
        if (!action) break
        await f.act(action)
      }
      await f.act({ kind: "deliver-progress" }); await f.controls(); await f.fixture.storage(); await f.controls()
      expect(f.fixture.state().retiredRevision).toBe(previous)
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 0 })
      for (let index = 0; index < 40 && f.fixture.state().retiredRevision !== undefined; index++) {
        await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
      }
      await f.fixture.storage()
      expect(f.fixture.state().retiredRevision).toBeUndefined()
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 1 })
      await f.close()
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 1 })
      step7Evidence("stretch-retire-safety", f.fixture.state())
    } finally { await f.close() }
  })
})

describe("DV01 STEP7 latency publication witnesses", () => {
  test("W50 retained override across two captures needs successor proof, not graph bytes", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "gain", value: -7 })
      await f.act({ kind: "latency", value: 2048 }); await f.advance()
      await f.act({ kind: "latency", value: 512 }); await f.execute("prepare")
      await f.act({ kind: "gain", value: -22 })
      await f.deliver("prepare")
      await f.execute("parameters"); await f.deliver("parameters")
      await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" })
      await f.execute("publish"); await f.deliver("publish"); await f.claim()
      await f.act({ kind: "publication-acknowledge" }); await f.controls()
      expect(f.fixture.state().actual.gain).toBe(-22)
      await f.act({ kind: "latency", value: 2048 })
      await f.act({ kind: "gain", value: -8 })
      await f.act({ kind: "flush", value: -17 })
      await f.advance()
      step7Evidence("W50-two-captures", f.fixture.state())
      expect(f.fixture.state().actual.gain).toBe(-17)
      expect(f.fixture.pending()).toEqual([])
      expect(f.fixture.failures).toEqual([])
    } finally { await f.close() }
  })

  for (const pending of [false, true]) {
    test(`W50 latency publication retains a different native override, pending=${pending}`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "flush", value: -22 }); await f.advance()
        await f.act({ kind: "latency", value: 2048 }); await f.execute("prepare")
        await f.deliver("prepare")
        await f.act({ kind: "flush", value: -17 })
        if (!pending) { await f.execute("parameters"); await f.deliver("parameters") }
        await f.advance()
        step7Evidence(`W50-retained-override-${pending}`, f.fixture.state())
        expect(f.fixture.state().actual.gain).toBe(-17)
        expect(f.fixture.pending()).toEqual([])
        expect(f.fixture.state().waiters.filter(waiter => waiter.name === "flush").every(waiter => waiter.settled)).toBe(true)
        expect(f.fixture.failures).toEqual([])
      } finally { await f.close() }
    })
  }

  for (const terminal of ["pause", "seek", "loss"]) {
    test(`W41 amended seed7 ${terminal}: lane release then strict control-only old-domain terminality`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "latency", value: 2048 })
        await f.execute("publish"); await f.deliver("publish")
        const old = new Set(f.fixture.pending().map(waiter => waiter.id))
        const frame = f.fixture.state().frame
        await f.act({ kind: terminal })
        const immediate = f.fixture.state()
        const laneReleased = terminal === "loss" || [immediate.pendingControl, ...immediate.queuedSends, ...immediate.commands]
          .some(command => command?.name === "transport")
        const afterLoss = immediate.counts
        await f.controls()
        const stranded = f.fixture.pending().filter(waiter => old.has(waiter.id))
        step7Evidence(`W41-${terminal}`, { frame, afterFrame: f.fixture.state().frame, laneReleased,
          immediate, controls: f.controlTrace, stranded })
        // Neither the amended observation nor its classifier uses behindPublicationWait.
        expect(f.fixture.state().frame).toBe(frame)
        if (terminal === "loss") expect(f.fixture.state().counts).toEqual(afterLoss)
        expect({ laneReleased, stranded },
          "Release the lane immediately and finish sent unclaimed work after bounded native cancellation proof")
          .toEqual({ laneReleased: true, stranded: [] })
        if (terminal !== "loss") {
          await f.advance()
          expect(f.fixture.pending().filter(waiter => waiter.name === terminal)).toEqual([])
        }
      } finally { await f.close() }
    })
  }

  for (const terminal of ["pause", "seek"]) for (const claimed of [false, true]) {
    test(`W42 ${terminal} ${claimed ? "callback wins" : "unclaimed negative control"} has one truthful terminal`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "latency", value: 2048 })
        await f.execute("publish"); await f.deliver("publish")
        if (claimed) await f.claim()
        const receipt = f.fixture.state().waiters.findLast(waiter => waiter.name === "latency")
        if (!receipt) throw new Error("Missing latency receipt")
        await f.act({ kind: terminal }); await f.controls()
        if (claimed) {
          expect(receipt.settled, "A callback claim is not an ACK").toBe(false)
          expect(f.fixture.state().preparedRevision).toBeDefined()
          await f.act({ kind: "publication-acknowledge" })
          await f.advance()
        }
        const result = receipt.result
        step7Evidence(`W42-${terminal}-${claimed}`, { receipt, published: f.fixture.state().published, counts: f.fixture.state().counts })
        expect(receipt.settled).toBe(true)
        expect(receipt.result).toEqual(claimed ? { state: "applied" } : { state: "refused", reason: "not-claimed" })
        await f.act({ kind: "deliver-progress" }); await f.controls()
        expect(receipt.result).toEqual(result)
        expect(f.fixture.state().published.filter(graph => graph.fft === 2048)).toHaveLength(claimed ? 1 : 0)
      } finally { await f.close() }
    })
  }

  test("B6d2 a latency edit folded into an adoption that pause cancels reaches native in the paused domain", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "submit-schedule", mode: "A" })
      await f.until(() => f.fixture.enabled().some(action => action.kind === "resolve-compile"))
      await f.act({ kind: "latency", value: 2048 })
      const compile = f.fixture.enabled().find(action => action.kind === "resolve-compile")
      if (!compile) throw new Error("Missing held compile")
      await f.act(compile)
      await f.execute("prepare"); await f.deliver("prepare")
      await f.act({ kind: "pause" })
      await f.advance()
      step7Evidence("B6d2-G", f.fixture.state())
      expect(f.fixture.state().actual.fft).toBe(2048)
      expect(f.fixture.state().actual.latency).toBe(2048)
      expect(f.fixture.pending()).toEqual([])
      expect(f.fixture.failures).toEqual([])
    } finally { await f.close() }
  })

  test("B6d2 a latency edit whose own publication pause cancels reaches native in the paused domain", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "latency", value: 2048 })
      await f.execute("prepare"); await f.deliver("prepare")
      await f.act({ kind: "pause" })
      await f.advance()
      step7Evidence("B6d2-G-admitted", f.fixture.state())
      expect(f.fixture.state().actual.fft).toBe(2048)
      expect(f.fixture.state().actual.latency).toBe(2048)
      expect(f.fixture.pending()).toEqual([])
      expect(f.fixture.failures).toEqual([])
    } finally { await f.close() }
  })

  test("B6d2 an admitted latency edit pause cancels gives way to the newer latency edit queued behind it", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "latency", value: 2048 })
      await f.execute("prepare"); await f.deliver("prepare")
      await f.act({ kind: "latency", value: 4096 })
      await f.act({ kind: "pause" })
      await f.advance()
      step7Evidence("B6d2-G-queued-newer", f.fixture.state())
      expect(f.fixture.state().actual.fft).toBe(4096)
      expect(f.fixture.state().actual.latency).toBe(4096)
      // The cancelled publication's own receipt is an attempt terminal; the newer edit is answered by its own proof.
      const [older, newer] = f.fixture.state().waiters.filter(waiter => waiter.name === "latency")
      expect(older?.result).toEqual({ state: "refused", reason: "not-claimed" })
      expect(newer?.result).toEqual({ state: "applied" })
      expect(f.fixture.pending()).toEqual([])
      expect(f.fixture.failures).toEqual([])
    } finally { await f.close() }
  })

  for (const pause of [false, true]) {
    test(`W43 pending latency ${pause ? "pause completes transition" : "negative control stays pending before callback"}`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "latency", value: 2048 })
        await f.until(() => f.fixture.state().latencyReadyEpoch !== undefined && !f.fixture.state().pendingControl)
        await f.act({ kind: "inspect-latency" }); await f.controls()
        const pending = f.fixture.state().waiters.findLast(waiter => waiter.name === "inspect-latency")
        expect(pending?.result).toMatchObject({ ok: true, revision: { status: "publish-pending" } })
        const before = f.fixture.state().counts
        if (pause) {
          await f.act({ kind: "pause" }); await f.controls()
          // One actual callback, not enough for the long FFT transition to finish naturally.
          await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
          await f.act({ kind: "inspect-latency" }); await f.controls()
        }
        step7Evidence(`W43-${pause}`, { events: f.events, state: f.fixture.state() })
        expect(f.fixture.state().counts["initial-graph"]).toBe(before["initial-graph"])
        expect(f.fixture.state().latencyReadyEpoch === undefined).toBe(pause)
        if (pause) {
          expect(f.events.some(event => z.object({ event: z.literal("latency-transition-complete-on-pause") }).safeParse(event).success)).toBe(true)
          expect(f.fixture.state().waiters.findLast(waiter => waiter.name === "inspect-latency")?.result)
            .not.toMatchObject({ revision: { status: "publish-pending" } })
        }
      } finally { await f.close() }
    })
  }

  for (const lost of ["none", "publish", "inspect"]) for (const cancel of [false, true]) {
    test(`W44 latency ${lost} reply loss cancel=${cancel} retains binding until actual proof`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "latency", value: 2048 })
        await f.execute("publish")
        const receipt = f.fixture.state().waiters.findLast(waiter => waiter.name === "latency")
        if (!receipt) throw new Error("Missing receipt")
        if (lost === "publish") await f.deadline()
        else await f.deliver("publish")
        if (lost === "inspect") { await f.execute("inspect"); await f.deadline() }
        expect(receipt.settled).toBe(false)
        expect(f.fixture.state().preparedRevision).toBeDefined()
        const frame = f.fixture.state().frame
        if (cancel) await f.act({ kind: "pause" })
        await f.controls()
        expect(f.fixture.state().frame).toBe(frame)
        expect(f.fixture.state().assets.every(([, asset]) => !asset.released)).toBe(true)
        if (cancel) {
          step7Evidence(`W44-${lost}-cancel`, { receipt, controls: f.controlTrace, state: f.fixture.state() })
          expect(receipt.result).toEqual({ state: "refused", reason: "not-claimed" })
        } else {
          await f.advance()
          expect(receipt.result).toEqual({ state: "applied" })
          const result = receipt.result
          await f.act({ kind: "deliver-progress" }); await f.advance()
          expect(receipt.result).toEqual(result)
          expect(f.fixture.state().published.filter(graph => graph.fft === 2048)).toHaveLength(1)
        }
      } finally { await f.close() }
    })
  }

  for (const explicitRetire of [false, true]) {
    test(`W45 removed real asset ${explicitRetire ? "native retirement negative control" : "reclaims without a later Prepare"}`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "sample", value: 1 }); await f.act({ kind: "submit-schedule", mode: "with-asset" }); await f.advance()
        const capacity = f.fixture.state().capacityGeneration
        const retires = f.fixture.state().counts.retire ?? 0
        await f.act({ kind: "sample", value: 0 }); await f.act({ kind: "submit-schedule", mode: "without-asset" }); await f.advance()
        const prepares = f.fixture.state().counts.prepare
        expect(f.fixture.state().leases).toHaveLength(1)
        expect(f.fixture.state().leases[0]?.releases).toBe(1)
        if (explicitRetire) {
          expect((f.fixture.state().counts.retire ?? 0) - retires).toBe(1)
          expect(f.fixture.state().retiredRevision).toBeUndefined()
          await f.controls()
          expect((f.fixture.state().counts.retire ?? 0) - retires).toBe(1)
        }
        await f.act({ kind: "reclaim" }); await f.act({ kind: "render-block" }); await f.act({ kind: "reclaim" })
        step7Evidence(`W45-${explicitRetire}`, { capacity, state: f.fixture.state() })
        expect(f.fixture.state().counts.prepare).toBe(prepares)
        expect(f.fixture.state().capacityGeneration).toBeGreaterThan(capacity)
        expect(f.fixture.state().assets).toEqual([])
        expect(f.fixture.state().leases[0]?.releases).toBe(1)
      } finally { await f.close() }
    })
  }

  for (const loseRollback of [false, true]) {
    test(`W44 unadmitted latency replacement lost Rollback=${loseRollback} keeps prepared ownership until proof`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "callback-mode", mode: "not-admitted" })
        await f.act({ kind: "latency", value: 2048 })
        await f.claim(); await f.act({ kind: "publication-acknowledge" })
        await f.act({ kind: "latency", value: 4096 })
        await f.act({ kind: "deliver-progress" })
        await f.execute("inspect"); await f.deliver("inspect")
        await f.execute("rollback")
        if (loseRollback) await f.deadline()
        else await f.deliver("rollback")
        await f.controls()
        const before = f.fixture.state()
        step7Evidence(`W44-rollback-${loseRollback}`, before)
        if (loseRollback) {
          expect(before.waiters.find(waiter => waiter.name === "latency")?.settled,
            "Lost Rollback is uncertainty, not permission to refuse a sent publication").toBe(false)
        } else {
          await f.advance()
          expect(f.fixture.state().actual.fft).toBe(4096)
          expect(f.fixture.pending()).toEqual([])
        }
      } finally { await f.close() }
    })
  }

  for (const payload of ["schedule", "latency"]) for (const loss of [false, true]) {
    test(`W47 ${payload} live readers survive repeated progress and ${loss ? "loss sends nothing" : "native auto-retire"}`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "sample", value: 1 }); await f.act({ kind: "submit-schedule", mode: "asset" }); await f.advance()
        const previous = f.fixture.state().activeRevision
        if (payload === "schedule") await f.act({ kind: "sample", value: 0 })
        await f.act(payload === "schedule" ? { kind: "submit-schedule", mode: "removed" } : { kind: "latency", value: 2048 })
        await f.until(() => f.fixture.state().activeRevision !== previous && f.fixture.state().retiredRevision === previous
          && !f.fixture.state().publicationPending)
        const held = f.fixture.state()
        await f.act({ kind: "reclaim" })
        expect(f.fixture.state().capacityGeneration).toBe(held.capacityGeneration)
        expect(f.fixture.state().leases.every(lease => !lease.reclaimed)).toBe(true)
        if (loss) {
          await f.act({ kind: "loss" }); const counts = f.fixture.state().counts
          await f.controls()
          expect(f.fixture.state().counts).toEqual(counts)
          expect(f.fixture.pending()).toEqual([])
        } else {
          await f.advance()
          // Caller success no longer drains Retire's latency transition. Drive
          // that real native completion explicitly before the auto-retire probe.
          if (payload === "latency") await f.until(() => f.fixture.state().latencyReadyEpoch === undefined)
          const counts = f.fixture.state().counts
          await f.act({ kind: "deliver-progress" }); await f.controls()
          await f.act({ kind: "deliver-progress" }); await f.controls()
          expect((f.fixture.state().counts.retire ?? 0) - (counts.retire ?? 0)).toBeLessThanOrEqual(1)
          await f.act({ kind: "submit-schedule", mode: "auto-retire" }); await f.advance()
          expect(f.fixture.state().waiters.findLast(waiter => waiter.name === "schedule-adoption:auto-retire")?.result).toEqual({ status: "adopted" })
          expect(f.fixture.failures.filter(failure => failure.invariant === "I5")).toEqual([])
        }
        step7Evidence(`W47-${payload}-${loss}`, f.fixture.state())
      } finally { await f.close() }
    })
  }

  for (const payload of ["schedule", "latency"]) for (const delay of ["prepare", "publish", "inspect"]) {
    test(`W52 shared driver ${payload} delayed ${delay} releases transport and keeps admitted coverage`, async () => {
      const f = await step7Host(false, true)
      try {
        if (payload === "schedule") {
          await f.act({ kind: "sample", value: 1 })
          await f.act({ kind: "submit-schedule", mode: `delayed-${delay}` })
        } else await f.act({ kind: "latency", value: 2048 })
        await f.execute(delay)
        // Hold this actual native reply, but deliver the already produced
        // running callbacks and progress. No synthetic readiness is injected.
        const frame = f.fixture.state().frame
        let rendered = 0
        for (let block = 0; block < 4; block++) {
          if (!f.fixture.enabled().some(action => action.kind === "render-block")) break
          await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" })
          rendered++
        }
        expect(rendered).toBeGreaterThan(0)
        expect(f.fixture.state().frame).toBeGreaterThanOrEqual(frame)
        if (f.fixture.state().frame === frame) expect(f.fixture.state().publicationClaimed).toBe(true)
        expect(f.fixture.state().metrics.minimumCoverageBlocks).toBeGreaterThanOrEqual(1)
        const old = new Set(f.fixture.pending().map(waiter => waiter.id))
        await f.act({ kind: "pause" })
        const immediate = f.fixture.state()
        const transportQueued = [immediate.pendingControl, ...immediate.queuedSends, ...immediate.commands]
          .some(command => command?.name === "transport")
        // The supervisor may still own the held control slot, but the
        // renderer's execution lane must already have admitted transport.
        step7Evidence(`W52-delayed-${payload}-${delay}`, { transportQueued, immediate })
        expect(transportQueued).toBe(true)
        await f.deliver(delay)
        await f.controls()
        if (f.fixture.state().publicationClaimed) await f.act({ kind: "publication-acknowledge" })
        await f.advance()
        expect(f.fixture.pending().filter(waiter => old.has(waiter.id))).toEqual([])
        expect(f.fixture.failures.filter(failure => failure.invariant === "I8")).toEqual([])
      } finally { await f.close() }
    })
  }

  for (const admitted of [false, true]) for (const payload of ["schedule", "latency"]) {
    test(`W52 ${payload} delayed publication admitted=${admitted} preserves coverage and window identity`, async () => {
      const windows: Uint8Array[] = []
      const f = await step7Host(false, true, fixture => {
        const send = fixture.bridge.session.queueScheduleWindow
        fixture.bridge.session.queueScheduleWindow = bytes => { windows.push(bytes.slice()); return send(bytes) }
      })
      try {
        if (!admitted) await f.act({ kind: "callback-mode", mode: "not-admitted" })
        await f.act(payload === "schedule" ? { kind: "submit-schedule", mode: "coverage" } : { kind: "latency", value: 2048 })
        await f.execute("publish"); await f.deliver("publish")
        await f.claim()
        await f.controls()
        await f.act({ kind: "publication-acknowledge" }); await f.advance()
        if (!admitted) { await f.act({ kind: "callback-mode", mode: "normal" }); await f.act({ kind: "deliver-progress" }); await f.advance() }
        const seen = new Set<string>()
        const duplicates: string[] = []
        for (const bytes of windows) {
          const view = new DataView(bytes.buffer, bytes.byteOffset)
          for (let index = 0; index < view.getUint32(44, true); index++) {
            const offset = 72 + index * 48
            if (view.getUint32(offset + 32, true) !== 1) continue
            const identity = `${view.getUint32(4, true)}:${view.getBigUint64(offset, true)}:${view.getBigUint64(offset + 8, true)}:${view.getBigUint64(offset + 16, true)}`
            if (seen.has(identity)) duplicates.push(identity)
            seen.add(identity)
          }
        }
        step7Evidence(`W52-${payload}-${admitted}`, { metrics: f.fixture.state().metrics, duplicates, windows: windows.length, state: f.fixture.state() })
        expect(f.fixture.state().metrics.minimumCoverageBlocks).toBeGreaterThanOrEqual(1)
        expect(f.fixture.failures.filter(failure => failure.invariant === "I8")).toEqual([])
        expect(windows.length).toBeGreaterThan(0)
        expect(duplicates).toEqual([])
        expect(f.fixture.state().activeRevision).toBeGreaterThan(1)
      } finally { await f.close() }
    })
  }

  for (const lost of [false, true]) {
    test(`W47 latency Retire ${lost ? "lost reply" : "reader-safety negative control"} never frees a live predecessor`, async () => {
      const f = await step7Host()
      try {
        await f.act({ kind: "sample", value: 1 }); await f.act({ kind: "submit-schedule", mode: "readers" }); await f.advance()
        await f.act({ kind: "latency", value: 2048 })
        await f.execute("publish"); await f.deliver("publish"); await f.claim()
        await f.act({ kind: "publication-acknowledge" }); await f.controls()
        await f.act({ kind: "deliver-progress" }); await f.controls()
        expect(f.fixture.state().latencyReadyEpoch).toBeDefined()
        expect(f.fixture.state().retiredRevision).toBeDefined()
        expect(f.fixture.state().leases[0]?.reclaimed).toBe(false)
        // The owner retains cleanup independently of the caller. Repeated
        // identical progress does not authorize another Retire.
        const sends = f.fixture.state().counts.retire
        await f.act({ kind: "deliver-progress" }); await f.controls()
        await f.act({ kind: "deliver-progress" }); await f.controls()
        expect(f.fixture.state().counts.retire).toBe(sends)
        if (lost) {
          for (let index = 0; index < 30 && f.fixture.state().latencyReadyEpoch !== undefined; index++)
            await f.act({ kind: "render-block" })
          await f.act({ kind: "deliver-progress" })
          await f.execute("retire"); await f.deadline()
          expect(f.fixture.state().leases[0]?.reclaimed).toBe(false)
          await f.act({ kind: "loss" })
          const counts = f.fixture.state().counts
          await f.controls()
          expect(f.fixture.state().counts).toEqual(counts)
        }
        step7Evidence(`W47-retire-${lost}`, f.fixture.state())
      } finally { await f.close() }
    })
  }

  test("W53 quiet transport refusal without a publication is not a claimed-publication retry", async () => {
    const fixture = createBridge()
    const controller = createObservedController({ bridge: fixture.bridge,
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...input(), transport }) })
    try {
      await controller.ensureLivePreview(0)
      let attempts = 0
      fixture.bridge.session.setTransport = async () => { attempts++; return { ok: false, kind: "refused", error: "ordinary refusal" } }
      await expect(controller.seekPrepared(0.25)).rejects.toThrow("ordinary refusal")
      expect(attempts).toBe(1)
    } finally { await controller.dispose() }
  })

  for (const terminal of ["pause", "seek"]) {
    test(`W53 claimed latency ${terminal} retries the same refused transport once without disposal`, async () => {
      const f = await step7Host()
      const transports: NativeHostTransport[] = []
      const send = f.fixture.bridge.session.setTransport
      f.fixture.bridge.session.setTransport = value => { transports.push(value); return send(value) }
      try {
        await f.act({ kind: "latency", value: 2048 }); await f.execute("publish"); await f.deliver("publish"); await f.claim()
        await f.act({ kind: terminal }); await f.controls()
        const beforeAck = transports.filter(value => !value.running).length
        await f.act({ kind: "publication-acknowledge" }); await f.advance()
        step7Evidence(`W53-${terminal}`, { beforeAck, transports, state: f.fixture.state() })
        expect(beforeAck).toBe(1)
        const cancellation = transports.filter(value => !value.running)
        expect(cancellation).toHaveLength(2)
        expect(cancellation[1]?.transitionId).toBe(cancellation[0]?.transitionId)
        expect(cancellation[1]?.epoch).toBe(cancellation[0]?.epoch)
        expect(f.fixture.state().counts.stop ?? 0).toBe(0)
        expect(f.fixture.state().counts.teardown ?? 0).toBe(0)
      } finally { await f.close() }
    })
  }

  test("W55 real queued parameter blocker ends through its owner, not synthetic completion credit", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "flush", value: -3 })
      await f.execute("parameters"); await f.deliver("parameters")
      const flush = f.fixture.state().waiters.findLast(waiter => waiter.name === "flush")
      expect(flush?.settled).toBe(false)
      await f.act({ kind: "submit-schedule", mode: "queued-control" })
      await f.execute("prepare"); await f.deliver("prepare")
      expect(f.fixture.state().preparedRevision).toBeUndefined()
      const prepares = f.fixture.state().counts.prepare
      await f.controls()
      expect(f.fixture.state().counts.prepare).toBe(prepares)
      await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.advance()
      step7Evidence("W55-owner-event", { flush, state: f.fixture.state() })
      expect(flush?.result).toEqual({ state: "applied" })
      expect(f.fixture.state().waiters.findLast(waiter => waiter.name === "schedule-adoption:queued-control")?.result).toEqual({ status: "adopted" })
    } finally { await f.close() }
  })

  test("W55 arena refusal ignores completion-only frames and waits for physical reclamation capacity", async () => {
    const f = await step6Publication()
    const frames: NativeScheduleProgress[] = []
    const unsubscribe = f.fixture.bridge.session.onScheduleProgress(progress => frames.push(progress))
    try {
      await f.act({ kind: "asset-capacity", value: 1 })
      await f.execute("asset"); await f.deliver("asset")
      await f.act({ kind: "drop-intents" }); await f.controls()
      await f.act({ kind: "sample-source", mode: "source-b" })
      await f.act({ kind: "submit-schedule", mode: "arena" })
      await f.execute("prepare"); await f.deliver("prepare"); await f.controls()
      expect(f.fixture.adoptionRetained()).toBe(true)
      await f.act({ kind: "latency", value: 2048 })
      await f.execute("publish"); await f.deliver("publish"); await f.claim()
      await f.act({ kind: "publication-acknowledge" }); await f.controls()
      const before = f.fixture.state().counts
      const capacity = f.fixture.state().capacityGeneration
      expect(f.fixture.state().latencyReadyEpoch).toBeDefined()
      for (let index = 0; index < 30 && f.fixture.state().latencyReadyEpoch !== undefined; index++)
        await f.act({ kind: "render-block" })
      await f.act({ kind: "deliver-progress" }); await f.controls()
      expect(frames.at(-1)?.latencyCompletionGeneration).toBe(1n)
      await f.act({ kind: "deliver-progress" }); await f.controls()
      expect(f.fixture.state().counts.prepare).toBe(before.prepare)
      expect(f.fixture.state().counts.asset).toBe(before.asset)
      expect(f.fixture.state().capacityGeneration).toBe(capacity)
      await f.advance()
      await f.act({ kind: "render-block" }); await f.act({ kind: "reclaim" })
      await f.act({ kind: "deliver-progress" }); await f.advance()
      step7Evidence("W55-capacity", f.fixture.state())
      expect(f.fixture.state().capacityGeneration).toBeGreaterThan(capacity)
      expect(f.fixture.state().leases[0]?.reclaimed).toBe(true)
      expect(f.fixture.state().waiters.find(waiter => waiter.name === "schedule-adoption:arena")?.result).toMatchObject({ status: "blocked" })
      expect(f.fixture.state().activeRevision).toBeGreaterThan(2)
    } finally { unsubscribe(); await f.close() }
  })
})

const step7Turns = async () => { for (let turn = 0; turn < 240; turn++) await Promise.resolve() }
type Step7Answer<Value> = { value?: Value; answers: number }
const step7Watch = <Value,>(promise: Promise<Value>) => {
  const box: Step7Answer<Value> = { answers: 0 }
  void promise.then(value => { box.value = value; box.answers++ })
  return box
}
const step7LatencyFixture = async (attachment = false, sampleRateHz = 48_000, maximumFrames = 512) => {
  const fixture = createBridge("runtime-revision-progress", false, false, "failed", sampleRateHz, false, maximumFrames)
  let keep = new Set<string>()
  const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
  const snapshot: LivePlaybackSnapshotInput = { ...input(),
    tracks: [sourceTrack(), { ...sourceTrack(), id: "parallel", clips: [] }],
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: { track: { instances: [
      { id: "spectral:1", kind: "spectral", params: { version: 1, state: from } },
      { id: "utility:1", kind: "utility", params: { version: 1, state: createDefaultUtilityParams() } },
    ] }, parallel: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } } } },
    automationEnvelopes: [] } }
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project", getKeepLatencyNodeIds: () => keep,
    compileSnapshot: async transport => {
      const compiled = compileLivePlaybackSnapshot({ ...snapshot, transport })
      return attachment && compiled.supported
        ? { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } } : compiled
    },
  })
  await controller.ensureLivePreview(0)
  const fft = (value: 512 | 2048 | 4096, order: number) => controller.deliverProcessor(fixturePatchEdit({
    bpm: 120, processorStateSequence: order, payload: { effect: "spectral", instanceId: "spectral:1", targetId: "track",
      from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize: value } } },
  })).settled
  const update = (nodes: string[]) => { keep = new Set(nodes); return controller.updateKeepLatency() }
  const progress = (sequence: number, completion = 0n, frame = 512n) => fixture.emitScheduleProgress({
    revision: 2, epoch: 1, progressSequence: BigInt(sequence),
    renderedThroughFrame: frame, acceptedThroughFrame: frame + 96000n, lastAcceptedWindowId: 1n,
    appliedTransportTransitionId: 1n, appliedUrgentSequence: 0n, appliedProcessorSequence: 0n,
    running: true, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    latencyCompletionGeneration: completion,
  })
  return { fixture, controller, fft, update, progress, close: async () => { fixture.emitLoss("STEP7 cleanup"); await controller.dispose() } }
}
const step7KeptNodes = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(12, true) !== 5) return []
  return Array.from({ length: view.getUint32(20, true) }, (_, index) => 36 + index * 140)
    .filter(offset => view.getUint32(offset + 32, true) === 1).map(offset => view.getBigUint64(offset, true).toString())
}

const step7PublicHost = async (attachment: boolean, running = false) => {
  const events: unknown[] = [], windows: Uint8Array[] = []
  const host = createFuzzHost(event => events.push(event), undefined, false,
    (invariant, detail) => { throw new Error(`${invariant}: ${detail}`) }, () => {})
  const queueWindow = host.bridge.session.queueScheduleWindow
  host.bridge.session.queueScheduleWindow = bytes => { windows.push(bytes.slice()); return queueWindow(bytes) }
  let keep = new Set<string>()
  const controller = createObservedController({ bridge: host.bridge, getProjectId: () => "fixture-project",
    getKeepLatencyNodeIds: () => keep,
    compileSnapshot: async transport => {
      const snapshot = nativeInstrumentInput()
      const compiled = compileLivePlaybackSnapshot({ ...snapshot,
        tracks: [...snapshot.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, duration: 30 })) })),
          { ...sourceTrack(), clips: [] }], transport })
      return attachment && compiled.supported
        ? { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } } : compiled
    } })
  const act = async (action: Step6Action) => {
    host.act(action, [], host.lose, () => {})
    await step7Turns()
  }
  let turn = 0
  const advance = async (done: () => boolean, bound = 300) => {
    await step7Turns()
    for (let index = 0; index < bound && !done(); index++) {
      const enabled = host.enabled()
      const frameAction = turn++ % 2 ? "deliver-progress" : "render-block"
      const action = enabled.find(entry => ["control-wake", "deliver-reply", "publication-acknowledge"].includes(entry.kind))
        ?? enabled.find(entry => entry.kind === frameAction) ?? enabled.find(entry => entry.kind === "render-block")
      if (!action) break
      await act(action)
    }
  }
  const startup = step7Watch(running ? controller.start(nativeInstrumentInput().transport) : controller.ensureLivePreview(0))
  await advance(() => startup.answers === 1)
  expect(startup.value).toBe("started")
  const update = () => { keep = new Set(["instrument"]); return controller.updateKeepLatency() }
  const close = async () => { host.endLeases(); host.lose(); await step7Turns(); await controller.dispose() }
  return { host, controller, act, advance, update, close, events, windows }
}

describe("DV01 STEP7 frozen inputs and cleanup witnesses", () => {
  test("W41 lost held latency sends no reconciliation after local terminal", async () => {
    const f = await step7LatencyFixture()
    const reply = Promise.withResolvers<NativeRevisionReply>()
    let lost = false, postLossInspects = 0
    const inspect = f.fixture.bridge.session.revisions.inspect
    f.fixture.bridge.session.revisions.inspect = request => {
      if (lost) postLossInspects++
      return inspect(request)
    }
    f.fixture.bridge.session.revisions.publish = () => reply.promise
    try {
      const answer = step7Watch(f.update(["track"]))
      await step7Turns()
      expect(answer.value).toBeUndefined()
      lost = true
      f.fixture.emitLoss("held latency owner lost")
      await step7Turns()
      reply.resolve({ ok: false, kind: "unavailable", error: "late Publish after loss" })
      f.progress(100)
      await step7Turns()
      step7Evidence("W41-post-loss-reconciliation", { postLossInspects, answer })
      expect(postLossInspects).toBe(0)
      expect(answer.answers).toBe(1)
      expect(answer.value).toMatchObject({ handled: false })
    } finally {
      reply.resolve({ ok: false, kind: "unavailable", error: "cleanup" })
      await f.close()
    }
  })

  test("W42 published ACK never rolls back the active latency bank", async () => {
    const f = await step7Host()
    let activeRollbacks = 0
    const rollback = f.fixture.bridge.session.revisions.rollback
    f.fixture.bridge.session.revisions.rollback = request => {
      if (request.revision === f.fixture.state().activeRevision) activeRollbacks++
      return rollback(request)
    }
    try {
      await f.act({ kind: "latency", value: 2048 })
      await f.execute("publish"); await f.deliver("publish"); await f.claim()
      await f.act({ kind: "pause" }); await f.controls()
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      step7Evidence("W42-no-active-rollback", { activeRollbacks, state: f.fixture.state() })
      expect(f.fixture.state().waiters.findLast(waiter => waiter.name === "latency")?.result).toEqual({ state: "applied" })
      expect(activeRollbacks).toBe(0)
    } finally { await f.close() }
  })

  test("W53 first claimed refusal preserves the session until its real ACK", async () => {
    const f = await step7Host()
    try {
      await f.act({ kind: "latency", value: 2048 })
      await f.execute("publish"); await f.deliver("publish"); await f.claim()
      await f.act({ kind: "pause" }); await f.controls()
      const beforeAck = f.fixture.state()
      step7Evidence("W53-first-refusal", beforeAck)
      expect(beforeAck.counts.stop ?? 0).toBe(0)
      expect(beforeAck.counts.teardown ?? 0).toBe(0)
      expect(beforeAck.publicationClaimed).toBe(true)
      expect(beforeAck.waiters.findLast(waiter => waiter.name === "latency")?.settled).toBe(false)
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.fixture.pending()).toEqual([])
    } finally { await f.close() }
  })

  test("W49 attachment-only follower preserves both frozen native captures", async () => {
    const f = await step7LatencyFixture(true)
    const gate = Promise.withResolvers<void>()
    const publish = f.fixture.bridge.session.revisions.publish
    let sends = 0
    f.fixture.bridge.session.revisions.publish = async request => {
      if (++sends === 1) await gate.promise
      return publish(request)
    }
    try {
      const attachment = nativeAttachmentPlan.attachments[0]
      if (!attachment) throw new Error("Missing attachment")
      const generation = f.controller.attachmentGeneration(attachment.instanceId)
      if (generation === undefined) throw new Error("Missing owning generation")
      const before = f.fixture.graphPayloads.length
      const first = step7Watch(f.controller.publishAttachmentLatency({ instanceId: attachment.instanceId, generation, latencyFrames: 1024 }))
      await step7Turns()
      const second = step7Watch(f.controller.publishAttachmentLatency({ instanceId: attachment.instanceId, generation, latencyFrames: 2048 }))
      gate.resolve()
      await step7Turns()
      const graphs = f.fixture.graphPayloads.slice(before).map(bytes => fields(decodeGraph(bytes)))
      step7Evidence("W49-attachment-only", { first, second, graphs })
      expect(first.value).toEqual({ handled: true })
      expect(second.value).toEqual({ handled: true })
      expect(graphs.map(graph => graph.pdc)).toEqual([[0, 512 + 1024 + 512], [0, 512 + 2048 + 512]])
    } finally { gate.resolve(); await f.close() }
  })

  test("M1 a plug-in latency report reaches the live graph as a publication, with no stop and no rebuild", async () => {
    const f = await step7LatencyFixture(true)
    const attachment = nativeAttachmentPlan.attachments[0]
    if (!attachment) throw new Error("Missing attachment")
    try {
      const before = f.fixture.graphPayloads.length
      const calls = f.fixture.calls.length
      f.fixture.emitVstInstanceEvent({ kind: "latency", instanceId: attachment.instanceId, latencyFrames: 2048 })
      await step7Turns()
      const graphs = f.fixture.graphPayloads.slice(before).map(bytes => fields(decodeGraph(bytes)))
      expect(graphs.map(graph => graph.pdc)).toEqual([[0, 512 + 2048 + 512]])
      const added = f.fixture.calls.slice(calls)
      expect(added).toContain("revision-publish")
      for (const call of ["stop", "teardown", "prepare", "start"]) expect(added).not.toContain(call)
      f.fixture.emitVstInstanceEvent({ kind: "latency", instanceId: crypto.randomUUID(), latencyFrames: 4096 })
      await step7Turns()
      expect(f.fixture.graphPayloads.length).toBe(before + 1)
    } finally { await f.close() }
  })

  // The worker's trust gate refusing its launch record is not a crash: it opens the existing authorization flow.
  test("a refused worker launch record goes to the trust flow and never marks the device failed", async () => {
    const fixture = createBridge("runtime-revision-progress")
    const faults: NativePlaybackFault[] = []
    const snapshotInput = input()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      reportFault: fault => { faults.push(fault) },
      compileSnapshot: async transport => {
        const compiled = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
        return compiled.supported ? { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } } : compiled
      },
    })
    const instanceId = nativeAttachmentPlan.attachments[0].instanceId
    try {
      expect(await controller.start(snapshotInput.transport)).toBe("started")
      const before = fixture.graphPayloads.length
      fixture.emitVstInstanceEvent({ kind: "launch-not-trusted", instanceId })
      await step7Turns()
      expect({ faults, failed: vstInstanceFailed(instanceId), published: fixture.graphPayloads.length - before, active: controller.isActive() })
        .toEqual({ faults: [{ kind: "session-stopped", message: nativeVst3LaunchAuthorizationRequiredMessage }], failed: false, published: 0, active: true })
      expect(classifyNativeVst3PlaybackFault(nativeVst3LaunchAuthorizationRequiredMessage)).toBe("launch-authorization-required")
    } finally { await controller.dispose() }
  })

  test("a plug-in fault marks only that instance failed and publishes nothing", async () => {
    const f = await step7LatencyFixture(true)
    const attachment = nativeAttachmentPlan.attachments[0]
    if (!attachment) throw new Error("Missing attachment")
    try {
      const before = f.fixture.graphPayloads.length
      f.fixture.emitVstInstanceEvent({ kind: "failed", instanceId: crypto.randomUUID() })
      expect(vstInstanceFailed(attachment.instanceId)).toBe(false)
      f.fixture.emitVstInstanceEvent({ kind: "failed", instanceId: attachment.instanceId })
      expect(vstInstanceFailed(attachment.instanceId)).toBe(true)
      await step7Turns()
      expect(f.fixture.graphPayloads.length).toBe(before)
      expect(f.fixture.calls).not.toContain("stop")
      expect(f.controller.isPrepared()).toBe(true)
    } finally { await f.close() }
    expect(f.fixture.vstInstanceListenerCount()).toBe(0)
  })

  test("W57 queued patch recovery materializes newest projected desired, not submitted bytes", () => {
    const owner = createNativeProcessorStateOwner()
    const desired = (order: number, state: Uint8Array) => ({
      id: `recovery-${order}`, order,
      target: { nodeId: "track", instanceId: "utility:1", kindId: 1, incarnation: 0 },
      content: { state, values: { gain: -order } }, bypassed: false, tailFrames: 0,
    })
    const old = desired(10, new Uint8Array([1]))
    const latest = desired(11, new Uint8Array([2]))
    owner.configured(1, new Map([["utility:1", { kindId: 1, state: new Uint8Array([0]) }]]))
    const delivery = owner.deliver({ key: "utility:1", editId: old.id, order: old.order,
      kindId: 1, incarnation: 0, epoch: 1, state: old.content.state, values: old.content.values, desired: old })
    expect(delivery.plan.carrier).toBe("patch")
    owner.submit(latest)
    const recovery = owner.nextPatch(value => value)
    step7Evidence("W57-newest-queued-patch", recovery?.desired)
    expect(recovery?.desired).toEqual(latest)
    expect(recovery?.execution.materialized).toEqual(latest)
  })

  test("W43 paused-preview maintenance cannot dispose the active publication during pause", async () => {
    const f = await step7PublicHost(false, true)
    try {
      const answer = step7Watch(f.update())
      await f.advance(() => f.host.publicationClaimed)
      await f.act({ kind: "publication-acknowledge" })
      const pause = step7Watch(f.controller.pause(0))
      const maintenance = step7Watch(f.controller.dispose(undefined, "paused-preview-structural-change"))
      await step7Turns()
      // Deferred, not dropped: it answers when the transition that owns the transport ends.
      expect(maintenance.answers).toBe(0)
      expect(f.controller.isPrepared()).toBe(true)
      expect(f.host.counts.get("stop") ?? 0).toBe(0)
      expect(f.host.counts.get("teardown") ?? 0).toBe(0)
      await f.advance(() => pause.answers === 1 && answer.answers === 1 && maintenance.answers === 1)
      expect(pause.answers).toBe(1)
      expect(answer.value).toEqual({ handled: true })
      // The paused session the maintenance was requested for is disposed once the pause has ended.
      expect(maintenance.answers).toBe(1)
      expect(f.controller.isPrepared()).toBe(false)
      expect(f.host.counts.get("teardown") ?? 0).toBe(1)
    } finally { await f.close() }
  })

  test("B6d2 deferred paused-preview maintenance never tears down a session that is still playing", async () => {
    const f = await step7PublicHost(false, true)
    try {
      const answer = step7Watch(f.update())
      await f.advance(() => f.host.publicationClaimed)
      // No pause owns the transport: the maintenance meets a session that keeps playing.
      const maintenance = step7Watch(f.controller.dispose(undefined, "paused-preview-structural-change"))
      await f.act({ kind: "publication-acknowledge" })
      await f.advance(() => answer.answers === 1 && maintenance.answers === 1)
      step7Evidence("B6d2-maintenance-playing", { maintenance: maintenance.answers, active: f.controller.isActive(),
        stop: f.host.counts.get("stop") ?? 0, teardown: f.host.counts.get("teardown") ?? 0 })
      expect(answer.value).toEqual({ handled: true })
      expect(f.controller.isActive()).toBe(true)
      expect(f.host.counts.get("stop") ?? 0).toBe(0)
      expect(f.host.counts.get("teardown") ?? 0).toBe(0)
    } finally { await f.close() }
  })

  test("B6d3 deferred paused-preview maintenance does not dispose again after a failed pause", async () => {
    const f = await step7PublicHost(false, true)
    try {
      const answer = step7Watch(f.update())
      await f.advance(() => f.host.publicationClaimed)
      await f.act({ kind: "publication-acknowledge" })
      // The pause's transport fails, so the pause disposes the session itself.
      f.host.bridge.session.setTransport = async () => { throw new Error("pause transport failed") }
      const pausing = f.controller.pause(0)
      const pause = step7Watch(pausing.then(() => "paused", () => "failed"))
      const maintenance = step7Watch(f.controller.dispose(undefined, "paused-preview-structural-change"))
      await f.advance(() => pause.answers === 1 && maintenance.answers === 1 && answer.answers === 1)
      await step7Turns()
      step7Evidence("B6d3-maintenance-failed-pause", { pause: pause.value, maintenance: maintenance.answers, answer: answer.value,
        prepared: f.controller.isPrepared(), stop: f.host.counts.get("stop") ?? 0, teardown: f.host.counts.get("teardown") ?? 0 })
      expect(pause.value).toBe("failed")
      await expect(pausing).rejects.toThrow("pause transport failed")
      expect(maintenance.answers).toBe(1)
      expect(f.controller.isPrepared()).toBe(false)
      expect(f.host.counts.get("stop") ?? 0).toBe(1)
      expect(f.host.counts.get("teardown") ?? 0).toBe(1)
    } finally { await f.close() }
  })

  for (const lost of [false, true]) {
    test(`W46 publication success survives an actually ${lost ? "lost" : "delivered"} native Retire reply`, async () => {
      const f = await step7PublicHost(false, true)
      try {
        const answer = step7Watch(f.update())
        await f.advance(() => f.host.pendingControl?.name === "retire")
        const execute = f.host.enabled().find(entry => entry.kind === "control-wake")
        if (!execute) throw new Error("Missing actual retirement command")
        await f.act(execute)
        const reply = f.host.enabled().find(entry => entry.kind === (lost ? "revision-deadline" : "deliver-reply"))
        if (!reply) throw new Error("Missing retirement reply")
        await f.act(reply)
        await f.advance(() => answer.answers === 1)
        step7Evidence(`W46-retire-${lost}`, { answer, active: f.host.active?.revision, retired: f.host.retired?.revision })
        expect(f.host.active?.revision).toBe(2)
        expect(answer.value).toEqual({ handled: true })
        expect(answer.answers).toBe(1)
      } finally { await f.close() }
    })
  }

  for (const lost of [false, true]) {
    test(`W52 running latency refills the promoted revision while Retire reply lost=${lost}`, async () => {
      const f = await step7PublicHost(false, true)
      const frames: NativeScheduleProgress[] = []
      const unsubscribe = f.host.bridge.session.onScheduleProgress(frame => frames.push(frame))
      try {
        const answer = step7Watch(f.update())
        await f.advance(() => f.host.pendingControl?.name === "retire")
        expect(f.host.active?.revision).toBe(2)
        const action = f.host.enabled().find(entry => entry.kind === "control-wake")
        if (!action || f.host.pendingControl?.name !== "retire") throw new Error("Missing real Retire")
        await f.act(action)
        const retireReply = f.host.enabled().find(entry => entry.kind === (lost ? "revision-deadline" : "deliver-reply"))
        if (!retireReply) throw new Error("Missing Retire reply/deadline")
        await f.act(retireReply)
        const start = f.windows.length
        for (let index = 0; index < 200; index++) {
          await f.act({ kind: "render-block" })
          await f.act({ kind: "deliver-progress" })
          // Run only the control/reply events, preserving one callback per observation.
          for (let control = 0; control < 16; control++) {
            const next = f.host.enabled().find(entry => entry.kind === "control-wake" || entry.kind === "deliver-reply")
            if (!next) break
            await f.act(next)
          }
        }
        const later = f.windows.slice(start)
        const seen = new Set<string>(), duplicates: string[] = []
        let noteOns = 0
        for (const bytes of f.windows) {
          const view = new DataView(bytes.buffer, bytes.byteOffset)
          for (let index = 0; index < view.getUint32(44, true); index++) {
            const offset = 72 + index * 48
            if (view.getUint32(offset + 32, true) !== 1) continue
            noteOns++
            const key = `${view.getUint32(4, true)}:${view.getBigUint64(offset, true)}:${view.getBigUint64(offset + 8, true)}:${view.getBigUint64(offset + 16, true)}`
            if (seen.has(key)) duplicates.push(key)
            seen.add(key)
          }
        }
        const running = frames.filter(frame => frame.running)
        expect(running.length).toBeGreaterThan(0)
        const minimum = Math.min(...running
          .map(frame => Number(frame.acceptedThroughFrame - frame.renderedThroughFrame) / 512))
        step7Evidence(`W52-refill-${lost}`, { minimum, noteOns, duplicates, later: later.length,
          revisions: later.map(bytes => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)), answer,
          retires: f.host.counts.get("retire") })
        expect(minimum).toBeGreaterThanOrEqual(1)
        expect(later.length).toBeGreaterThan(0)
        expect(later.every(bytes => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === 2)).toBe(true)
        expect(noteOns).toBeGreaterThan(0)
        expect(duplicates).toEqual([])
        expect(f.host.counts.get("initial-graph")).toBe(1)
      } finally { unsubscribe(); await f.close() }
    })
  }

  for (const payload of ["keep", "attachment"]) for (const collision of ["window", "preview", "parameter", "none"]) {
    test(`W46 ${payload} successful publication does not await ${collision} retirement control`, async () => {
      const f = await step7PublicHost(payload === "attachment")
      let occupied = false
      const inspect = f.host.bridge.session.revisions.inspect
      f.host.bridge.session.revisions.inspect = async request => {
        const reply = await inspect(request)
        if (collision !== "none" && !occupied && reply.ok && reply.revision.status === "published") {
          occupied = true
          // Native's single supervisor slot is actually held here. Retire
          // queues behind it; no fake busy refusal or alternate serialization.
          if (collision === "window") {
            const bytes = f.windows.at(-1)
            if (!bytes) throw new Error("Missing actual coordinator window")
            void f.host.bridge.session.queueScheduleWindow(bytes).catch(() => undefined)
          } else if (collision === "preview") {
            f.controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.5 })
          } else {
            const request = { instanceId: "synth:1", values: [{ parameterId: "synth.filterCutoffHz", value: 5000 }] }
            void f.controller.deliverProcessor(fixtureParameterEdit(request), fixtureGesture(request, true)).settled
          }
          await step7Turns()
        }
        return reply
      }
      try {
        const attachment = nativeAttachmentPlan.attachments[0]
        if (!attachment) throw new Error("Missing attachment")
        const generation = f.controller.attachmentGeneration(attachment.instanceId)
        const pending = payload === "keep" ? f.update()
          : f.controller.publishAttachmentLatency({ instanceId: attachment.instanceId, generation: generation ?? -1, latencyFrames: 2048 })
        const answer = step7Watch(pending)
        await f.advance(() => collision === "none" ? answer.answers === 1 : occupied)
        await step7Turns()
        step7Evidence(`W46-${payload}-${collision}`, { answer, occupied,
          active: f.host.active?.revision, pending: f.host.pendingControl?.name,
          queued: f.host.queuedSends.map(command => command.name), events: f.events })
        if (collision !== "none") {
          expect(occupied).toBe(true)
          expect(f.host.pendingControl?.name).toBe(collision === "window" ? "window" : "instrument-events")
          expect(f.host.queuedSends.some(command => command.name === "retire")).toBe(true)
        }
        expect(answer.value, "Published caller success is independent of predecessor cleanup").toEqual({ handled: true })
        await f.advance(() => answer.answers === 1)
        expect(answer.answers).toBe(1)
      } finally { await f.close() }
    })
  }

  for (const at of ["prepare", "publish"]) for (const changed of [false, true]) {
    test(`W48 frozen Keep Latency at ${at}, changed=${changed}, has only the necessary follow-up`, async () => {
      const f = await step7LatencyFixture()
      const gate = Promise.withResolvers<void>()
      let held = false
      if (at === "prepare") {
        const prepare = f.fixture.bridge.session.revisions.prepare
        f.fixture.bridge.session.revisions.prepare = async request => {
          const reply = await prepare(request)
          if (!held) { held = true; await gate.promise }
          return reply
        }
      } else f.fixture.bridge.session.revisions.publish = async request => {
        const reply = await f.fixture.bridge.session.revisions.inspect(request)
        if (!held) { held = true; await gate.promise }
        return reply
      }
      try {
        const baseline = f.fixture.graphPayloads.length
        const first = step7Watch(f.update(["track"]))
        await step7Turns()
        expect(held).toBe(true)
        const frozen = f.fixture.graphPayloads[baseline]
        if (!frozen) throw new Error("Missing captured membership graph")
        const bytes = frozen.slice()
        const next = step7Watch(f.update(changed ? [] : ["track"]))
        await step7Turns()
        expect(f.fixture.graphPayloads[baseline]).toEqual(bytes)
        expect(step7KeptNodes(bytes)).toEqual([nativeGraphNodeId("track").toString()])
        gate.resolve(); await step7Turns()
        step7Evidence(`W48-${at}-${changed}`, { first, next, graphs: f.fixture.graphPayloads.slice(baseline).map(step7KeptNodes) })
        expect(first.value).toEqual({ handled: true })
        expect(next.value).toEqual({ handled: true })
        expect(f.fixture.graphPayloads.length - baseline).toBe(changed ? 2 : 1)
        expect(step7KeptNodes(f.fixture.graphPayloads.at(-1) ?? bytes)).toEqual(changed ? [] : [nativeGraphNodeId("track").toString()])
      } finally {
        gate.resolve()
        await f.close()
      }
    })
  }

  for (const stale of [false, true]) {
    test(`W49 two attachment captures combine FFT and Keep Latency; stale-generation=${stale}`, async () => {
      const f = await step7LatencyFixture(true)
      const gate = Promise.withResolvers<void>()
      const publish = f.fixture.bridge.session.revisions.publish
      let publications = 0
      f.fixture.bridge.session.revisions.publish = async request => {
        if (++publications === 1) await gate.promise
        return publish(request)
      }
      try {
        const attachment = nativeAttachmentPlan.attachments[0]
        if (!attachment) throw new Error("Missing attachment")
        const generation = f.controller.attachmentGeneration(attachment.instanceId)
        if (generation === undefined) throw new Error("Missing owning attachment generation")
        const before = f.fixture.graphPayloads.length
        const first = step7Watch(f.controller.publishAttachmentLatency({ instanceId: attachment.instanceId, generation, latencyFrames: 1024 }))
        await step7Turns()
        const captured = f.fixture.graphPayloads.at(-1)?.slice()
        if (!captured) throw new Error("Missing first attachment capture")
        const second = step7Watch(f.controller.publishAttachmentLatency({ instanceId: attachment.instanceId,
          generation: stale ? generation + 1 : generation, latencyFrames: 2048 }))
        const fft = step7Watch(f.fft(4096, 30))
        const keep = step7Watch(f.update(["track"]))
        expect(f.fixture.graphPayloads.at(-1)).toEqual(captured)
        gate.resolve(); await step7Turns()
        const graphs = f.fixture.graphPayloads.slice(before).map(bytes => fields(decodeGraph(bytes)))
        step7Evidence(`W49-${stale}`, { first, second, fft, keep, graphs })
        // Independent parallel-route arithmetic, not compensateGraph.
        expect(graphs[0]?.pdc).toEqual([0, 512 + 1024 + 512])
        expect(graphs.at(-1)?.fft).toBe(4096)
        expect(graphs.at(-1)?.pdc).toEqual([0, 4096 + (stale ? 1024 : 2048) + 512])
        expect(first.value).toEqual({ handled: true })
        expect(second.value).toEqual(stale ? { handled: false, reason: "stale" } : { handled: true })
        expect(fft.value).toEqual({ state: "applied" })
        expect(keep.value).toEqual({ handled: true })
        const count = f.fixture.graphPayloads.length
        f.fixture.emitLoss("attachment owner replaced")
        expect(await f.controller.publishAttachmentLatency({ instanceId: attachment.instanceId, generation, latencyFrames: 0 }))
          .toEqual({ handled: false, reason: "stale" })
        expect(f.fixture.graphPayloads.length).toBe(count)
      } finally { gate.resolve(); await f.close() }
    })
  }

  for (const lost of [false, true]) {
    test(`W44 late negative Publish and lost Inspect preserve ${lost ? "uncertain" : "conclusive"} latency ownership`, async () => {
      const f = await step7LatencyFixture()
      const publishReply = Promise.withResolvers<NativeRevisionReply>()
      const rollbackReply = Promise.withResolvers<NativeRevisionReply>()
      let rollbacks = 0, proved = false, inspections = 0
      f.fixture.bridge.session.revisions.publish = () => publishReply.promise
      f.fixture.bridge.session.revisions.inspect = async () => {
        inspections++
        if (!proved) throw new Error("Inspect reply lost")
        return f.fixture.revisionReply("published")
      }
      f.fixture.bridge.session.revisions.rollback = async () => { rollbacks++; return rollbackReply.promise }
      try {
        const answer = step7Watch(f.update(["track"]))
        await step7Turns()
        expect(answer.value).toBeUndefined()
        if (!lost) proved = true
        f.progress(100); await step7Turns()
        if (lost) {
          expect(answer.value).toBeUndefined()
          f.fixture.emitLoss("no publication proof")
          await step7Turns()
          expect(answer.value).toMatchObject({ handled: false })
        } else {
          expect(answer.value).toEqual({ handled: true })
          publishReply.resolve({ ok: false, kind: "refused", error: "late negative" })
          await step7Turns()
          expect(answer.value).toEqual({ handled: true })
        }
        step7Evidence(`W44-late-negative-${lost}`, { answer, inspections, rollbacks })
        expect(rollbacks).toBe(0)
        expect(answer.answers).toBe(1)
      } finally {
        publishReply.resolve({ ok: false, kind: "unavailable", error: "cleanup" })
        rollbackReply.resolve({ ok: false, kind: "unavailable", error: "cleanup" })
        await f.close()
      }
    })
  }

  for (const opportunities of [0, 12]) {
    test(`W51 latency resubmit budget counts initial plus eight, opportunities=${opportunities}`, async () => {
      const f = await step7LatencyFixture()
      let sends = 0, activeRollbacks = 0
      f.fixture.bridge.session.revisions.publish = async () => {
        sends++
        const reply = f.fixture.revisionReply("prepared")
        return reply.ok ? { ...reply, revision: { ...reply.revision, activeRevision: 1 } } : reply
      }
      f.fixture.bridge.session.revisions.inspect = async () => {
        const reply = f.fixture.revisionReply("prepared")
        return reply.ok ? { ...reply, revision: { ...reply.revision, activeRevision: 1 } } : reply
      }
      const rollback = f.fixture.bridge.session.revisions.rollback
      f.fixture.bridge.session.revisions.rollback = async request => { if (request.revision === 1) activeRollbacks++; return rollback(request) }
      try {
        const answer = step7Watch(f.update(["track"]))
        await step7Turns()
        for (let index = 0; index < opportunities; index++) {
          const frame = BigInt((index + 2) * 512)
          f.progress(100 + index, 0n, frame)
          await step7Turns()
          const before = sends
          f.progress(100 + index, 0n, frame); await step7Turns()
          expect(sends, "Identical progress is not another submission opportunity").toBe(before)
        }
        step7Evidence(`W51-${opportunities}`, { sends, activeRollbacks, answer })
        expect(sends).toBe(opportunities ? 9 : 1)
        expect(activeRollbacks).toBe(0)
      } finally { await f.close() }
    })
  }

  // Each row consumes the same record budget, including unpublished recapture.
  for (const recovery of ["prepared", "negative-status", "own-rollback", "changed-desired"]) {
    test(`W51 latency exact shared budget survives ${recovery}`, async () => {
      const f = await step7LatencyFixture()
      let sends = 0, rollbacks = 0, activeRollbacks = 0, prepares = 0
      const prepare = f.fixture.bridge.session.revisions.prepare
      f.fixture.bridge.session.revisions.prepare = async request => { prepares++; return prepare(request) }
      const status = (): NativeRevisionReply => {
        const reply = f.fixture.revisionReply("prepared")
        return reply.ok ? { ...reply, revision: { ...reply.revision, activeRevision: 1,
          status: recovery === "negative-status" && sends === 9 ? "invalid-revision" : "prepared" } } : reply
      }
      f.fixture.bridge.session.revisions.publish = async () => { sends++; return status() }
      f.fixture.bridge.session.revisions.inspect = async () => status()
      const rollback = f.fixture.bridge.session.revisions.rollback
      f.fixture.bridge.session.revisions.rollback = async request => {
        rollbacks++
        if (request.revision === 1) activeRollbacks++
        return rollback(request)
      }
      try {
        const answer = step7Watch(f.update(["track"]))
        await step7Turns()
        expect(sends).toBe(1)
        for (let index = 0; index < 12; index++) {
          if (index < 8 && recovery === "own-rollback") void f.update(index % 2 ? ["track"] : [])
          if (index < 8 && recovery === "changed-desired") void f.fft(index % 2 ? 2048 : 4096, 100 + index)
          f.progress(500 + index, 0n, BigInt((index + 2) * 512))
          await step7Turns()
          expect(sends).toBe(Math.min(index + 2, 9))
          const before = { sends, prepares, rollbacks }
          f.progress(500 + index, 0n, BigInt((index + 2) * 512))
          await step7Turns()
          expect({ sends, prepares, rollbacks }, "Duplicate progress is not a recovery opportunity").toEqual(before)
        }
        const recaptures = recovery === "own-rollback" || recovery === "changed-desired"
        step7Evidence(`W51-exact-${recovery}`, { sends, prepares, rollbacks, activeRollbacks, answer })
        expect({ sends, prepares, rollbacks, activeRollbacks }).toEqual({
          sends: 9, prepares: recaptures ? 9 : 1, rollbacks: recaptures ? 9 : 1, activeRollbacks: 0,
        })
        expect(answer.answers).toBe(1)
        expect(answer.value).toMatchObject({ handled: false })
      } finally { await f.close() }
    })
  }

  for (const prepareRecoveries of [0, 3]) {
    test(`W51 schedule rebase shares initial plus eight with ${prepareRecoveries} admission recoveries`, async () => {
      const f = await step7LatencyFixture()
      let prepares = 0, sends = 0, rebases = 0, rollbacks = 0, activeRollbacks = 0
      let seam = 0n, lastSeam = 0n
      let status: NativeGraphRevisionStatus["status"] = "prepared"
      const reply = (): NativeRevisionReply => ({ ok: true, hostPid: 123, hostGeneration: 7,
        revision: { status, continuity: "accepted", requestedRevision: 2, activeRevision: 1,
          preparedRevision: prepares <= prepareRecoveries ? 0 : 2, retiredRevision: 0, renderEpoch: 1n,
          transportEpoch: 1, publicationFrame: 0n, progressFrame: seam + 128n } })
      const prepare = f.fixture.bridge.session.revisions.prepare
      f.fixture.bridge.session.revisions.prepare = async request => {
        prepares++; seam = request.requestedPublicationFrame ?? 0n
        if (prepares <= prepareRecoveries) { status = "invalid-revision"; return reply() }
        await prepare(request)
        lastSeam = seam; status = "prepared"
        return reply()
      }
      f.fixture.bridge.session.revisions.publish = async request => {
        sends++
        const requested = request.requestedPublicationFrame ?? 0n
        if (requested !== lastSeam) { rebases++; lastSeam = requested; status = "prepared" }
        else status = "rebase-required"
        return reply()
      }
      f.fixture.bridge.session.revisions.inspect = async () => reply()
      const rollback = f.fixture.bridge.session.revisions.rollback
      f.fixture.bridge.session.revisions.rollback = async request => {
        rollbacks++; if (request.revision === 1) activeRollbacks++
        return rollback(request)
      }
      try {
        // Preview has no active schedule; start the real coordinator before adoption.
        await f.controller.start(input().transport)
        const answer = step7Watch(f.controller.adoptSchedule(migrationIntent("W51-shared-rebase")))
        await step7Turns()
        for (let index = 0; index < 24; index++) {
          f.progress(900 + index, 0n, BigInt((index + 2) * 512)); await step7Turns()
          const before = { sends, prepares, rebases, rollbacks }
          f.progress(900 + index, 0n, BigInt((index + 2) * 512)); await step7Turns()
          expect({ sends, prepares, rebases, rollbacks }).toEqual(before)
        }
        step7Evidence(`W51-schedule-${prepareRecoveries}`, { sends, prepares, rebases, rollbacks, answer })
        expect(prepares).toBe(prepareRecoveries + 1)
        expect(sends).toBe(9 - prepareRecoveries)
        expect(rebases).toBe(Math.floor((9 - prepareRecoveries) / 2))
        expect(rollbacks).toBe(1)
        expect(activeRollbacks).toBe(0)
        expect(answer.answers).toBe(1)
        expect(answer.value?.status).toBe("failed")
      } finally { await f.close() }
    })
  }
  for (const equalOrder of [false, true]) {
    test(`W50 late FFT content equal-order=${equalOrder} is not proved by the older frozen floor`, async () => {
      const f = await step7LatencyFixture()
      const gate = Promise.withResolvers<void>()
      const publish = f.fixture.bridge.session.revisions.publish
      let sends = 0
      f.fixture.bridge.session.revisions.publish = async request => {
        if (++sends === 1) await gate.promise
        return publish(request)
      }
      try {
        const first = step7Watch(f.fft(2048, 20))
        await step7Turns()
        const captured = f.fixture.graphPayloads.at(-1)?.slice()
        if (!captured) throw new Error("Missing frozen FFT graph")
        const next = step7Watch(f.fft(4096, equalOrder ? 20 : 21))
        await step7Turns()
        expect(next.value).toBeUndefined()
        expect(fields(decodeGraph(captured)).fft).toBe(2048)
        expect(f.fixture.graphPayloads.at(-1)).toEqual(captured)
        gate.resolve(); await step7Turns()
        step7Evidence(`W50-floor-${equalOrder}`, { first, next, graphs: f.fixture.graphPayloads.map(bytes => fields(decodeGraph(bytes))) })
        expect(next.value).toEqual({ state: "applied" })
        expect(fields(decodeGraph(f.fixture.graphPayloads.at(-1) ?? captured)).fft).toBe(4096)
        expect(next.answers).toBe(1)
      } finally { gate.resolve(); await f.close() }
    })
  }

  for (const latest of [2048, 4096] satisfies readonly (2048 | 4096)[]) {
    test(`W54 legacy latency terminal offers queued processor and latest FFT once, latest=${latest}`, async () => {
      const f = await step7LatencyFixture()
      const gate = Promise.withResolvers<void>()
      const publish = f.fixture.bridge.session.revisions.publish
      let sends = 0
      f.fixture.bridge.session.revisions.publish = async request => {
        if (++sends === 1) await gate.promise
        return publish(request)
      }
      try {
        const first = step7Watch(f.fft(2048, 20))
        await step7Turns()
        const newest = step7Watch(f.fft(latest, 21))
        const patch = step7Watch(f.controller.deliverProcessor(fixturePatchEdit({
          bpm: 120, processorStateSequence: 22,
          payload: utilityCommit("utility:1", createDefaultUtilityParams(), { ...createDefaultUtilityParams(), swap: true, gainDb: -9 }),
        })).settled)
        gate.resolve(); await step7Turns()
        const before = f.fixture.calls.slice()
        f.progress(100, 1n); await step7Turns()
        f.progress(100, 1n); await step7Turns()
        step7Evidence(`W54-followers-${latest}`, { first, newest, patch, sends, calls: f.fixture.calls })
        expect(first.answers).toBe(1)
        expect(newest.answers).toBe(1)
        expect(patch.answers).toBe(1)
        expect(f.fixture.calls).toEqual(before)
        expect(fields(decodeGraph(f.fixture.graphPayloads.at(-1) ?? new Uint8Array())).fft).toBe(latest)
      } finally { gate.resolve(); await f.close() }
    })
  }

  for (const finish of [false, true]) {
    test(`W54 owner publication terminal opportunity exactly once, terminal=${finish}`, () => {
      let opportunities = 0
      const owner = createNativeProcessorStateOwner({ onTerminal: () => { opportunities++ } })
      const fields = { host: "host", epoch: 1, structural: 1, capacity: 0, settled: 0 }
      const submitted = owner.submitAdoption(migrationIntent("W54"), false, fields)
      if (!submitted.start) throw new Error("Missing public adoption owner")
      const record = owner.capturePublication(submitted.start.attempt, new Map())
      expect(opportunities).toBe(0)
      if (!finish) {
        owner.cancelPublication()
        expect(opportunities).toBe(0)
        return
      }
      owner.finishPublication(record, { status: "adopted" }, "promoted")
      owner.finishPublication(record, { status: "adopted" }, "promoted")
      step7Evidence("W54-publication-terminal", { opportunities, phase: record.phase, publication: owner.publication() })
      expect(opportunities, "Publication itself emits one opportunity before adoption settlement").toBe(1)
      expect(owner.publication(), "Clear the slot before emitting the terminal opportunity").toBeUndefined()
      owner.settleAdoption(submitted.start.attempt, { status: "adopted" })
      owner.settleAdoption(submitted.start.attempt, { status: "adopted" })
      owner.clear(); owner.clear()
      step7Evidence("W54-terminal", { opportunities, phase: record.phase, publication: owner.publication() })
      expect(opportunities).toBe(1)
      expect(owner.publication()).toBeUndefined()
    })
  }
})

describe("DV01 STEP6 public publication witnesses", () => {
  for (const cancel of [false, true]) {
    test(`W02 deferred rebase ${cancel ? "cancels after Publish" : "republishes only after real progress"}`, async () => {
      const f = await step6Publication()
      try {
        await f.act({ kind: "callback-mode", mode: "not-admitted" })
        await f.claim(); await f.act({ kind: "publication-acknowledge" })
        for (let index = 0; index < 40 && f.fixture.state().frame <= f.fixture.state().seam; index++)
          await f.act({ kind: "render-block" })
        expect(f.fixture.state().frame).toBeGreaterThan(f.fixture.state().seam)
        const publishes = f.fixture.state().counts.publish
        await f.controls()
        expect(f.fixture.state().counts.publish).toBe(publishes)
        expect(f.outcome()?.settled).toBe(false)
        if (cancel) await f.act({ kind: "pause" })
        await f.act({ kind: "deliver-progress" }); await f.advance()
        expect(f.outcome()?.result).toEqual({ status: cancel ? "superseded" : "adopted" })
        expect(f.fixture.state().activeRevision).toBe(cancel ? 1 : 2)
        expect(f.fixture.state().publicationPending).toBe(false)
        expect(f.fixture.state().preparedRevision).toBeUndefined()
      } finally { await f.close() }
    })
  }

  test("W19 callback failure answers only the captured receipt cohort and releases once", async () => {
    const f = await step6Publication(false, "key-only")
    try {
      const joined = f.fixture.joinPublication({ target: { nodeId: "parallel", instanceId: "synth:1" },
        contentKey: nativeInstrumentContentKey(compilePortableSynthState(createDefaultSynthParams())), lifetime: 51 })
      let answer: ProcessorDeliveryOutcome | undefined
      void joined.settled.then(value => { answer = value })
      await f.act(f.compile)
      await f.act({ kind: "callback-mode", mode: "failed" }); await f.claim()
      expect(answer).toBeUndefined()
      await f.act({ kind: "publication-acknowledge" })
      expect(f.fixture.state().publicationPending).toBe(true)
      expect(f.fixture.state().preparedRevision).toBe(2)
      expect(answer).toBeUndefined()
      await f.act({ kind: "deliver-progress" }); await f.advance()
      expect(answer).toEqual({ state: "refused", reason: "apply-failed" })
      expect(f.outcome()?.result).toMatchObject({ status: "failed" })
      expect(f.fixture.state().publicationPending).toBe(false)
      expect(f.fixture.state().counts.rollback).toBe(1)
      expect(f.fixture.state().leases[0]?.releases).toBe(1)
      const counts = f.fixture.state().counts
      await f.act({ kind: "deliver-progress" }); await f.advance()
      expect(f.fixture.state().counts).toEqual(counts)
      expect(f.fixture.state().leases[0]?.releases).toBe(1)
    } finally { await f.close() }
  })

  for (const cancel of [false, true]) {
    test(`W02 deferred callback preserves bank and ${cancel ? "cancellation proves not-taken" : "republishes only on a new progress event"}`, async () => {
      const f = await step6Publication()
      try {
        await f.act({ kind: "callback-mode", mode: "not-admitted" })
        await f.claim()
        await f.act({ kind: "publication-acknowledge" })
        expect(f.fixture.state().publicationDeferred).toBe(true)
        expect(f.fixture.state().preparedRevision).toBe(2)
        const publishes = f.fixture.state().counts.publish
        if (cancel) await f.act({ kind: "pause" })
        else {
          await f.controls()
          expect(f.fixture.state().counts.publish).toBe(publishes)
          expect(f.outcome()?.settled).toBe(false)
          await f.act({ kind: "deliver-progress" })
        }
        await f.advance()
        expect(f.outcome()?.result).toEqual({ status: cancel ? "superseded" : "adopted" })
        expect(f.fixture.state().activeRevision).toBe(cancel ? 1 : 2)
        expect(f.fixture.state().publicationPending).toBe(false)
      } finally { await f.close() }
    })
  }

  test("W04 unclaimed SetTransport cancels before callback and ACK Inspect is stale once", async () => {
    const f = await step6Publication()
    try {
      await f.execute("publish")
      expect(f.fixture.state().publicationRequested).toBe(true)
      await f.deadline()
      await f.act({ kind: "pause" })
      await f.deliver("publish")
      await f.controls()
      expect(f.fixture.state().publicationClaimed).toBe(false)
      expect(f.fixture.state().publicationPending).toBe(false)
      expect(f.outcome()?.result).toEqual({ status: "superseded" })
      await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" })
      await f.controls()
      expect(f.outcome()?.result).toEqual({ status: "superseded" })
      expect(f.fixture.state().activeRevision).toBe(1)
      const inspections = f.fixture.state().counts.inspect
      await f.controls(); await f.act({ kind: "deliver-progress" }); await f.controls()
      expect(f.fixture.state().counts.inspect).toBe(inspections)
    } finally { await f.close() }
  })

  test("W05 ACK terminal agrees while latency stays behind resolving schedule", async () => {
    const f = await step6Publication()
    try {
      await f.claim()
      await f.act({ kind: "pause" })
      await f.execute("inspect"); await f.deliver("inspect")
      await f.execute("rollback"); await f.deliver("rollback")
      await f.act({ kind: "latency", value: 2048, sequence: 20 })
      const prepares = f.fixture.state().counts.prepare
      await f.execute("transport")
      expect(f.outcome()?.settled).toBe(false)
      expect(f.fixture.state().counts.prepare).toBe(prepares)
      await f.deliver("transport")
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
      expect(f.fixture.state().waiters.filter(waiter => !waiter.settled)).toEqual([])
    } finally { await f.close() }
  })

  for (const end of ["loss", "stop"]) for (const acknowledged of [false, true]) {
    test(`W14 ${end} during resolving ${acknowledged ? "after" : "before"} callback ACK ends caller and clears ownership`, async () => {
      const f = await step6Publication()
      try {
        await f.claim(); await f.act({ kind: "pause" })
        await f.execute("inspect"); await f.deliver("inspect")
        await f.execute("rollback"); await f.deliver("rollback")
        if (acknowledged) await f.act({ kind: "publication-acknowledge" })
        const beforeEnd = f.fixture.state().counts
        await f.act({ kind: end })
        await f.advance()
        expect(f.outcome()?.settled).toBe(true)
        expect(f.fixture.adoptionRunning()).toBe(false)
        if (end === "loss") {
          expect(f.fixture.state().counts).toEqual(beforeEnd)
          const counts = f.fixture.state().counts
          await f.controls()
          expect(f.fixture.state().counts).toEqual(counts)
          expect(f.outcome()?.result).toEqual({ status: "superseded" })
          expect(f.fixture.state().assets).toEqual([])
        }
      } finally { await f.close() }
    })
  }

  test("W11 callback failure keeps staged bank until Inspect and Rollback", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "callback-mode", mode: "failed" })
      await f.claim()
      expect(f.fixture.state().assets[0]?.[1].staged).toBe(2)
      await f.act({ kind: "publication-acknowledge" })
      expect(f.fixture.state().activeRevision).toBe(1)
      expect(f.fixture.state().preparedRevision).toBe(2)
      expect(f.fixture.state().publicationPending).toBe(true)
      await f.act({ kind: "deliver-progress" }); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "failed", reason: "Native live publication was publish-failed." })
      expect(f.fixture.state().counts.rollback).toBe(1)
      expect(f.fixture.state().preparedRevision).toBeUndefined()
      expect(f.fixture.state().publicationPending).toBe(false)
      expect(f.fixture.state().leases[0]?.releases).toBe(1)
    } finally { await f.close() }
  })

  for (const afterAck of [false, true]) {
    test(`W14 loss ${afterAck ? "after" : "before"} SetTransport ACK sends zero further commands`, async () => {
      const f = await step6Publication()
      try {
        await f.claim(); await f.act({ kind: "pause" })
        await f.execute("inspect"); await f.deliver("inspect")
        await f.execute("rollback"); await f.deliver("rollback")
        await f.execute("transport")
        if (afterAck) await f.deliver("transport")
        const counts = f.fixture.state().counts
        await f.act({ kind: "loss" }); await f.controls(); await f.advance()
        expect(f.fixture.state().counts).toEqual(counts)
        expect(f.outcome()?.result).toEqual({ status: "superseded" })
        expect(f.fixture.pending()).toEqual([])
        expect(f.fixture.state().assets).toEqual([])
      } finally { await f.close() }
    })
  }

  test("W01 pending claim activation adopts once and retains native assets", async () => {
    const f = await step6Publication()
    try {
      await f.claim()
      expect(f.outcome()?.settled).toBe(false)
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
      expect(f.fixture.state().activeRevision).toBe(2)
      expect(f.fixture.state().assets).toHaveLength(1)
      expect(f.fixture.state().assets[0]?.[1].released).toBe(false)
      const counts = f.fixture.state().counts
      const leases = f.fixture.state().leases
      await f.act({ kind: "deliver-progress" }); await f.advance()
      expect(f.fixture.state().counts.prepare).toBe(counts.prepare)
      expect(f.fixture.state().counts.publish).toBe(counts.publish)
      expect(f.fixture.state().leases).toEqual(leases)
    } finally { await f.close() }
  })

  test("W02 staged cancellation releases the retained bank without publication", async () => {
    const f = await step6Publication()
    try {
      await f.execute("prepare"); await f.deliver("prepare")
      expect(f.fixture.state().preparedRevision).toBe(2)
      await f.act({ kind: "drop-intents" }); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "superseded" })
      expect(f.fixture.state().preparedRevision).toBeUndefined()
      expect(f.fixture.state().counts.publish ?? 0).toBe(0)
    } finally { await f.close() }
  })

  test("W03 lost Publish retains caller until native proof", async () => {
    const f = await step6Publication()
    try {
      await f.execute("publish"); await f.deadline()
      await f.advance()
      expect(f.fixture.state().activeRevision).toBe(2)
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
    } finally { await f.close() }
  })

  test("W04 lost Publish plus unclaimed pause cancellation is not taken", async () => {
    const f = await step6Publication()
    try {
      await f.execute("publish")
      expect(f.fixture.state().publicationClaimed).toBe(false)
      await f.act({ kind: "pause" }); await f.deadline(); await f.deliver("publish"); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "superseded" })
      expect(f.fixture.state().activeRevision).toBe(1)
      expect(f.fixture.state().publicationPending).toBe(false)
      const inspections = f.fixture.state().counts.inspect
      await f.advance()
      expect(f.fixture.state().counts.inspect).toBe(inspections)
    } finally { await f.close() }
  })

  test("W05 lane detaches while transport ACK and caller are pending", async () => {
    const f = await step6Publication()
    try {
      await f.claim(); await f.act({ kind: "pause" })
      await f.execute("inspect"); await f.deliver("inspect")
      await f.execute("rollback"); await f.deliver("rollback")
      await f.execute("transport")
      expect(f.fixture.state().waiters.find(waiter => waiter.name === "pause")?.settled).toBe(false)
      expect(f.outcome()?.settled).toBe(false)
    } finally { await f.close() }
  })

  test("W06 claimed transport refusal retries once after callback ACK", async () => {
    const f = await step6Publication()
    try {
      await f.claim()
      const before = f.fixture.state().counts.transport ?? 0
      await f.act({ kind: "pause" })
      await f.execute("inspect"); await f.deliver("inspect")
      await f.execute("rollback"); await f.deliver("rollback")
      await f.execute("transport"); await f.deliver("transport")
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.fixture.state().waiters.find(waiter => waiter.name === "pause")?.settled).toBe(true)
      expect(f.fixture.state().counts.transport).toBe(before + 2)
    } finally { await f.close() }
  })

  test("W07 cancellation Inspect promotion answers adopted without Rollback", async () => {
    const f = await step6Publication()
    try {
      await f.claim(); await f.act({ kind: "pause" })
      await f.act({ kind: "publication-acknowledge" })
      await f.advance()
      expect(f.fixture.state().activeRevision).toBe(2)
      expect(f.fixture.state().counts.rollback ?? 0).toBe(0)
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
    } finally { await f.close() }
  })

  test("W08 ACK between Inspect and Rollback agrees with caller without readoption", async () => {
    const f = await step6Publication()
    try {
      await f.claim(); await f.act({ kind: "pause" })
      await f.execute("inspect"); await f.deliver("inspect")
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.fixture.state().activeRevision).toBe(2)
      expect(f.fixture.state().counts.prepare).toBe(1)
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
    } finally { await f.close() }
  })

  test("W09 lost promoting Inspect and stale Rollback require one resolving Inspect", async () => {
    const f = await step6Publication()
    try {
      await f.claim(); await f.act({ kind: "pause" })
      await f.act({ kind: "publication-acknowledge" })
      await f.execute("inspect"); await f.deadline(); await f.deliver("inspect")
      await f.execute("rollback")
      const before = f.fixture.state().counts.inspect ?? 0
      await f.deliver("rollback")
      await f.advance()
      expect((f.fixture.state().counts.inspect ?? 0) - before).toBe(1)
      expect(f.fixture.state().counts.rollback).toBe(1)
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
    } finally { await f.close() }
  })

  test("W10 lost pending Rollback keeps native ownership until ACK", async () => {
    const f = await step6Publication()
    try {
      await f.claim(); await f.act({ kind: "pause" })
      await f.execute("inspect"); await f.deliver("inspect")
      await f.execute("rollback"); await f.deadline()
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.fixture.state().activeRevision).toBe(2)
      expect(f.fixture.state().waiters.find(waiter => waiter.name === "pause")?.settled).toBe(true)
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
    } finally { await f.close() }
  })

  test("W10 resolving lost Publish holds latency while the execution lane is free", async () => {
    const f = await step6Publication()
    try {
      await f.execute("publish"); await f.deadline(); await f.deliver("publish")
      await f.execute("inspect"); await f.deadline(); await f.deliver("inspect")
      await f.controls()
      const prepares = f.fixture.state().counts.prepare
      await f.act({ kind: "latency", value: 2048, sequence: 20 })
      await f.controls()
      expect(f.outcome()?.settled).toBe(false)
      expect(f.fixture.state().publicationPending).toBe(true)
      expect(f.fixture.state().counts.prepare).toBe(prepares)
      await f.claim(); await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
      expect(f.fixture.pending()).toEqual([])
    } finally { await f.close() }
  })

  test("W15 held drop is a no-op and a newer intent waits for its own outcome", async () => {
    const f = await step6Publication()
    try {
      await f.claim(); await f.act({ kind: "drop-intents" })
      await f.act({ kind: "submit-schedule", mode: "B" })
      expect(f.outcome()?.settled).toBe(false)
      expect(f.fixture.state().counts.rollback ?? 0).toBe(0)
      expect(f.fixture.state().waiters.find(waiter => waiter.name === "schedule-adoption:B")?.settled).toBe(false)
      await f.act({ kind: "publication-acknowledge" }); await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "adopted" })
      expect(f.fixture.state().waiters.find(waiter => waiter.name === "schedule-adoption:B")?.settled).toBe(true)
    } finally { await f.close() }
  })

  for (const terminal of ["drop-intents", "pause", "loss", "dispose"]) {
    test(`W25 ${terminal} during compile releases hold despite late completion`, async () => {
      const f = await step6Publication(false)
      try {
        await f.act({ kind: "latency", value: 2048, sequence: 20 })
        expect(f.fixture.state().counts.prepare ?? 0).toBe(0)
        await f.act({ kind: terminal })
        await f.act(f.compile); await f.advance()
        expect(f.outcome()?.settled).toBe(true)
        if (terminal === "drop-intents" || terminal === "pause") {
          expect(f.fixture.state().counts.prepare).toBe(1)
          expect(f.fixture.state().actual.fft).toBe(2048)
          const count = f.fixture.state().counts.prepare
          await f.act({ kind: "drop-intents" }); await f.advance()
          expect(f.fixture.state().counts.prepare).toBe(count)
        } else {
          expect(f.fixture.adoptionRunning()).toBe(false)
          expect(f.fixture.adoptionRetained()).toBe(false)
        }
      } finally { await f.close() }
    })
  }

  test("W26 public retained refusal disposes its candidate on drop exactly once", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "block-asset" }); await f.advance()
      expect(f.outcome()?.result).toMatchObject({ status: "blocked" })
      expect(f.fixture.adoptionRetained()).toBe(true)
      const prepares = f.fixture.state().counts.prepare
      await f.act({ kind: "drop-intents" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(false)
      await f.act({ kind: "drop-intents" }); await f.advance()
      expect(f.fixture.state().counts.prepare).toBe(prepares)
    } finally { await f.close() }
  })

  test("W27 adversarial public replacement removes parked current before another rollback", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "block-asset" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(true)
      await f.act({ kind: "submit-schedule", mode: "B" })
      expect(f.fixture.adoptionRunning()).toBe(true)
      expect(f.fixture.adoptionRetained()).toBe(false)
      // Try to make A current again while B owns publication. A waits, never parks.
      await f.execute("prepare"); await f.deliver("prepare")
      await f.act({ kind: "submit-schedule", mode: "A" })
      await f.execute("rollback")
      expect(f.fixture.adoptionRetained()).toBe(false)
      const before = f.fixture.state()
      console.log("STEP6-W27", JSON.stringify({ scheduleReplacementOverlap: false, running: f.fixture.adoptionRunning(),
        retained: f.fixture.adoptionRetained(), blocked: f.outcome()?.result,
        preparedRevision: before.preparedRevision, rollbacks: before.counts.rollback }))
      await f.deliver("rollback"); await f.advance()
      expect(f.fixture.state().waiters.filter(waiter => waiter.name.startsWith("schedule-adoption") && !waiter.settled)).toEqual([])
    } finally { await f.close() }
  })

  test("W27 parked schedule coexists with a legacy latency publication", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "block-asset" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(true)
      await f.act({ kind: "latency", value: 2048, sequence: 10 })
      await f.execute("prepare"); await f.deliver("prepare")
      await f.execute("publish")
      expect(f.fixture.adoptionRetained()).toBe(true)
      expect(f.fixture.state().preparedRevision).toBeDefined()
      expect(f.fixture.state().publicationPending).toBe(true)
      console.log("STEP6-W27-LATENCY", JSON.stringify({ retained: f.fixture.adoptionRetained(),
        preparedRevision: f.fixture.state().preparedRevision, publicationPending: true,
        exactRollbackExercised: false }))
    } finally { await f.close() }
  })

  test("W27 latency Rollback owns no staged storage; earlier schedule release and reader epoch restore capacity", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "asset-capacity", value: 1 })
      await f.execute("asset"); await f.deliver("asset")
      expect(f.fixture.state().assets).toHaveLength(1)
      expect(f.fixture.state().assets[0]?.[1].staged).toBe(2)
      await f.act({ kind: "drop-intents" }); await f.controls()
      expect(f.fixture.state().preparedRevision).toBeUndefined()
      expect(f.fixture.state().assets[0]?.[1].released).toBe(true)
      await f.act({ kind: "sample-source", mode: "source-b" })
      await f.act({ kind: "submit-schedule", mode: "B" })
      await f.execute("prepare"); await f.deliver("prepare"); await f.controls()
      expect(f.fixture.adoptionRetained()).toBe(true)
      const blocked = f.fixture.state()
      expect(blocked.waiters.find(waiter => waiter.name === "schedule-adoption:B")?.result)
        .toEqual({ status: "blocked", reason: "asset-capacity-exceeded" })
      expect(blocked.assets[0]?.[1].staged).toBe(2)
      await f.act({ kind: "latency", value: 2048, sequence: 20 })
      await f.execute("prepare"); await f.deliver("prepare")
      const latencyRevision = f.fixture.state().preparedRevision
      expect(latencyRevision).toBeDefined()
      expect(latencyRevision).not.toBe(2)
      await f.act({ kind: "callback-mode", mode: "not-admitted" })
      await f.claim(); await f.act({ kind: "publication-acknowledge" })
      expect(f.fixture.state().publicationDeferred).toBe(true)
      await f.act({ kind: "latency", value: 4096, sequence: 21 })
      await f.act({ kind: "deliver-progress" })
      await f.execute("inspect"); await f.deliver("inspect")
      const before = f.fixture.state()
      expect(f.fixture.adoptionRetained()).toBe(true)
      expect(before.assets.filter(([, asset]) => asset.staged === latencyRevision)).toEqual([])
      await f.execute("rollback"); await f.deliver("rollback")
      const after = f.fixture.state()
      expect(after.assets).toEqual(before.assets)
      expect(after.leases).toEqual(before.leases)
      expect(after.capacityGeneration).toBe(before.capacityGeneration)
      expect(after.waiters.filter(waiter => waiter.name === "schedule-adoption:B")).toHaveLength(1)
      console.log("STEP6-W27-OCCUPANCY", JSON.stringify({
        blockedByOccupiedTable: true, retainedAtLatencyRollback: f.fixture.adoptionRetained(),
        owningStagedRevision: before.assets[0]?.[1].staged, latencyRevision,
        assetsBefore: before.assets, assetsAfter: after.assets,
        capacityBefore: String(before.capacityGeneration), capacityAfter: String(after.capacityGeneration),
        leasesBefore: before.leases, leasesAfter: after.leases,
      }))
      const preparesBeforeRecovery = after.counts.prepare ?? 0
      await f.advance()
      // The applied caller no longer holds the drain through native completion.
      for (let index = 0; index < 40 && f.fixture.state().latencyReadyEpoch !== undefined; index++) {
        await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
      }
      expect(f.fixture.state().latencyReadyEpoch).toBeUndefined()
      await f.act({ kind: "render-block" }); await f.act({ kind: "reclaim" })
      const reclaimed = f.fixture.state()
      expect(reclaimed.assets).toEqual([])
      expect(reclaimed.leases[0]?.reclaimed).toBe(true)
      expect(reclaimed.leases[0]?.owners).toEqual([])
      await f.act({ kind: "deliver-progress" }); await f.advance()
      const recovered = f.fixture.state()
      expect(recovered.capacityGeneration).toBe(before.capacityGeneration + 1n)
      expect(recovered.leases[0]?.reclaimed).toBe(true)
      expect(recovered.leases[0]?.acquisitions).toBe(1)
      expect(recovered.leases[0]?.releases).toBe(1)
      expect(recovered.leases[1]?.acquisitions).toBe(1)
      expect(recovered.leases[1]?.releases).toBe(0)
      expect(recovered.waiters.filter(waiter => waiter.name === "schedule-adoption:B").every(waiter => waiter.settled)).toBe(true)
      expect(recovered.counts.prepare).toBe(preparesBeforeRecovery + 1)
      expect(recovered.actual.fft).toBe(4096)
      expect(recovered.activeRevision).toBeGreaterThan(latencyRevision ?? 0)
      expect(f.fixture.adoptionRetained()).toBe(false)
      console.log("STEP6-W27-RECOVERY", JSON.stringify({ safeReclaimEpoch: String(reclaimed.renderEpoch),
        capacity: String(recovered.capacityGeneration), prepareDelta: (recovered.counts.prepare ?? 0) - preparesBeforeRecovery,
        assets: recovered.assets, leases: recovered.leases, activeRevision: recovered.activeRevision }))
    } finally { await f.close() }
  })

  test("W27 Rollback really reclaims staged assets and advances native capacity", async () => {
    const f = await step6Publication()
    try {
      await f.execute("asset"); await f.deliver("asset")
      const before = f.fixture.state()
      expect(before.assets).toHaveLength(1)
      expect(before.assets[0]?.[1].staged).toBe(2)
      expect(before.leases[0]?.owners).toEqual([])
      await f.act({ kind: "drop-intents" })
      await f.execute("rollback"); await f.deliver("rollback"); await f.advance()
      await f.act({ kind: "block-asset" })
      await f.act({ kind: "submit-schedule", mode: "B" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(true)
      const preparesBeforeCapacity = f.fixture.state().counts.prepare ?? 0
      await f.act({ kind: "render-block" }); await f.act({ kind: "reclaim" })
      await f.act({ kind: "deliver-progress" })
      await f.advance()
      const after = f.fixture.state()
      expect(after.assets).toEqual([])
      expect(after.capacityGeneration).toBe(before.capacityGeneration + 1n)
      expect(after.leases[0]?.reclaimed).toBe(true)
      expect(after.counts.prepare).toBe(preparesBeforeCapacity + 1)
      console.log("STEP6-W27-RECLAIM", JSON.stringify({ staged: 2, assetsBefore: before.assets.length,
        assetsAfter: after.assets.length, capacityBefore: String(before.capacityGeneration),
        capacityAfter: String(after.capacityGeneration), reclaimed: after.leases[0]?.reclaimed,
        preparesBeforeCapacity, preparesAfterCapacity: after.counts.prepare }))
    } finally { await f.close() }
  })

  test("B6d the fuzz host reuses an unreclaimed asset identity across rollback and re-prepare without a capacity limit", async () => {
    const f = await step6Publication()
    // Control lane only: a frame would let ReclaimAssets finish the rolled-back identity first.
    const controlLane = async (done: () => boolean) => {
      for (let index = 0; index < 200 && !done(); index++) {
        const action = f.fixture.enabled().find(entry => ["control-wake", "deliver-reply", "resolve-compile"].includes(entry.kind))
        if (!action) break
        await f.act(action)
      }
      expect(done(), "B6d control lane must reach its premise").toBe(true)
    }
    try {
      await f.execute("asset"); await f.deliver("asset")
      const [installed] = f.fixture.state().assets
      if (!installed) throw new Error("B6d missing the staged asset")
      const [assetId, staged] = installed
      expect(staged.staged).toBe(2)
      const identity = () => f.fixture.state().assets.map(([id, asset]) => [id, asset.released, asset.releaseRequested, asset.staged])
      await f.act({ kind: "drop-intents" })
      await f.execute("rollback"); await f.deliver("rollback")
      const rolledBack = f.fixture.state()
      expect(rolledBack.preparedRevision).toBeUndefined()
      expect(identity()).toEqual([[assetId, true, true, 2]])
      expect(rolledBack.leases).toMatchObject([{ id: assetId, acquisitions: 1, releases: 1, reclaimed: false }])
      await f.act({ kind: "submit-schedule", mode: "A" })
      await controlLane(() => (f.fixture.state().counts.asset ?? 0) >= 2 && !f.fixture.state().pendingControl)
      const reinstalled = f.fixture.state()
      expect(f.fixture.failures.filter(failure => failure.invariant === "I5")).toEqual([])
      expect(reinstalled.preparedRevision).toBe(3)
      expect(identity()).toEqual([[assetId, false, false, 3]])
      expect(reinstalled.leases).toMatchObject([{ id: assetId, acquisitions: 2, releases: 1, reclaimed: false }])
    } finally { await f.close() }
  })

  test("W27 legacy latency Rollback can occur while a public schedule stays parked", async () => {
    const fixture = createBridge("runtime-revision-progress")
    const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
    const base: LivePlaybackSnapshotInput = { ...input(), processorStateSequence: 10,
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {
        track: { instances: [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: from } }] },
      } }, automationEnvelopes: [] } }
    const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport }) })
    const published = Promise.withResolvers<void>()
    const rolledBack = Promise.withResolvers<boolean>()
    try {
      expect(await controller.start(base.transport)).toBe("started")
      const prepare = fixture.bridge.session.revisions.prepare
      fixture.bridge.session.revisions.prepare = async () => ({ ok: false, kind: "refused", error: "asset-capacity-exceeded" })
      expect(await controller.adoptSchedule({ key: "parked", schedule: "parked", context: {},
        loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })).toMatchObject({ status: "blocked" })
      expect(controller.adoptionWitness().retained).toBeDefined()
      fixture.bridge.session.revisions.prepare = prepare
      fixture.bridge.session.revisions.publish = async () => { published.resolve(); return fixture.revisionReply("publish-pending") }
      // Native's latency-not-admitted callback preserves the bank. A subsequent
      // Inspect clears its in-flight flag and proves `prepared` (audio-host.cpp).
      // This boundary proof is not a modeled callback/resource-capacity claim.
      fixture.bridge.session.revisions.inspect = async () => fixture.revisionReply("prepared")
      fixture.bridge.session.revisions.rollback = async () => {
        rolledBack.resolve(controller.adoptionWitness().retained !== undefined)
        return fixture.revisionReply("rolled-back")
      }
      const patch = (fftSize: 2048 | 4096, processorStateSequence: number) => controller.deliverProcessor(fixturePatchEdit({
        bpm: 120, processorStateSequence, payload: { effect: "spectral", instanceId: "spectral:1", targetId: "track",
          from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize } } },
      }))
      patch(2048, 11)
      await published.promise
      patch(4096, 12)
      fixture.emitScheduleProgress({ revision: 1, epoch: 1, progressSequence: 100n, renderedThroughFrame: 2048n,
        acceptedThroughFrame: 4096n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
        appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: true, scheduleComplete: false,
        instrumentCredits: 256, sourceCredits: 256, automationCredits: 256 })
      expect(await rolledBack.promise).toBe(true)
      console.log("STEP6-W27-LATENCY-ROLLBACK", JSON.stringify({ retainedAtRollback: true,
        nativeCallbackModeled: false, occupancyAdmissionModeled: false }))
    } finally { fixture.emitLoss("W27 boundary trace complete"); await controller.dispose() }
  })

  test("W28 own Rollback and identical native progress never renew refusal budget", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "block-asset" }); await f.advance()
      expect(f.outcome()?.result).toMatchObject({ status: "blocked" })
      const fields = { ...f.fixture.state().counts }
      const capacity = f.fixture.state().capacityGeneration
      expect(fields.rollback).toBe(1)
      for (let index = 0; index < 4; index++) {
        await f.act({ kind: "deliver-progress" })
        await f.act({ kind: "submit-schedule", mode: "A" })
      }
      await f.advance()
      expect(f.fixture.state().capacityGeneration).toBe(capacity)
      expect(f.fixture.state().counts.prepare).toBe(fields.prepare)
      expect(f.fixture.state().counts.publish).toBe(fields.publish)
      expect(f.fixture.state().counts.rollback).toBe(fields.rollback)
    } finally { await f.close() }
  })

  test("W25 owner emits one notice for a closed compile and none for duplicate close or clear", () => {
    let notices = 0
    const options = { reportIncident: () => {}, onTerminal: () => { notices++ } }
    const owner = createNativeProcessorStateOwner(options)
    const compile = owner.openCompile()
    owner.closeCompile(compile)
    expect(notices).toBe(1)
    owner.closeCompile(compile)
    owner.clear(); owner.clear()
    expect(notices).toBe(1)
    const withdrawn = owner.openCompile()
    owner.endDomain(2)
    expect(notices).toBe(2)
    owner.closeCompile(withdrawn)
    expect(notices).toBe(2)
    const cleared = owner.openCompile()
    owner.clear(); owner.clear(); owner.closeCompile(cleared)
    expect(notices).toBe(3)
    const submission = owner.submitAdoption({ key: "notice", schedule: "notice", context: {},
      loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } },
    false, { host: "host", epoch: 2, structural: 1, capacity: 0, settled: 0 })
    if (!submission.start) throw new Error("Notice witness needs an admitted attempt")
    owner.settleAdoption(submission.start.attempt, { status: "adopted" })
    owner.settleAdoption(submission.start.attempt, { status: "adopted" })
    expect(notices).toBe(4)
    owner.clear()
    expect(notices).toBe(4)
  })

  for (const end of ["drop", "domain", "clear"]) {
    test(`W25 ${end} aborts each compile once before late close`, () => {
      let notices = 0
      const options = { onTerminal: () => { notices++ } }
      const owner = createNativeProcessorStateOwner(options)
      const first = owner.openCompile(), second = owner.openCompile()
      if (end === "drop") owner.dropIntents()
      else if (end === "domain") owner.endDomain(2)
      else owner.clear()
      expect(first.signal.aborted).toBe(true)
      expect(second.signal.aborted).toBe(true)
      expect(notices).toBe(2)
      owner.closeCompile(first); owner.closeCompile(second)
      owner.dropIntents(); owner.endDomain(3); owner.clear()
      expect(notices).toBe(2)
    })
  }

  for (const status of ["adopted", "superseded", "failed", "blocked", "unchanged"]) {
    test(`W25 publication ${status} notifies once despite repeated settlement and clear`, () => {
      let notices = 0
      const options = { onTerminal: () => { notices++ } }
      const owner = createNativeProcessorStateOwner(options)
      const submitted = owner.submitAdoption({ key: status, schedule: status, context: {},
        loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } },
      false, { host: "host", epoch: 1, structural: 1, capacity: 0, settled: 0 })
      if (!submitted.start) throw new Error("W25 requires an admitted attempt")
      const outcome = status === "failed" || status === "blocked"
        ? { status, reason: "native-refused" } : { status }
      const parsed = z.union([
        z.object({ status: z.enum(["adopted", "superseded", "unchanged"]) }),
        z.object({ status: z.enum(["failed", "blocked"]), reason: z.string() }),
      ]).parse(outcome)
      owner.settleAdoption(submitted.start.attempt, parsed)
      expect(notices).toBe(1)
      owner.settleAdoption(submitted.start.attempt, parsed)
      owner.clear(); owner.clear()
      expect(notices).toBe(1)
    })
  }

  // The UD 8 retry reopens a refusal when a field it answers to moves. A limitation (E6) is no refusal and is never reopened.
  for (const status of ["failed", "unsupported"] as const) {
    test(`UD 8 a ${status} adoption ${status === "failed" ? "reopens" : "never reopens"} when the transport epoch moves`, () => {
      const owner = createNativeProcessorStateOwner()
      const intent = { key: status, schedule: status, context: {}, loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } }
      const submitted = owner.submitAdoption(intent, false, { host: "host", epoch: 1, structural: 1, capacity: 0, settled: 0 })
      if (!submitted.start) throw new Error("UD 8 requires an admitted attempt")
      owner.settleAdoption(submitted.start.attempt, { status, reason: "refused" })
      const moved = { host: "host", epoch: 2, structural: 1, capacity: 0, settled: 0 }
      expect(owner.reopenedIntent(moved)?.key).toBe(status === "failed" ? status : undefined)
      expect(owner.nextAdoption(moved, true)?.attempt.intent.key).toBe(status === "failed" ? status : undefined)
    })
  }

  for (const terminal of ["promoted", "not-taken", "failed", "lost"]) {
    test(`W25 ${terminal} releases each native lease once across repeated progress ACK clear and late replies`, async () => {
      const f = await step6Publication()
      try {
        await f.execute("asset"); await f.deliver("asset")
        expect(f.fixture.state().leases[0]?.acquisitions).toBe(1)
        if (terminal === "promoted") {
          await f.claim(); await f.act({ kind: "publication-acknowledge" })
        } else if (terminal === "not-taken") await f.act({ kind: "drop-intents" })
        else if (terminal === "failed") {
          await f.act({ kind: "callback-mode", mode: "failed" })
          await f.claim(); await f.act({ kind: "publication-acknowledge" })
        } else await f.act({ kind: "loss" })
        await f.advance()
        expect(f.outcome()?.settled).toBe(true)
        expect(f.fixture.state().leases[0]?.releases).toBe(terminal === "promoted" ? 0 : 1)
        if (terminal !== "lost") await f.act({ kind: "deliver-progress" })
        await f.controls()
        expect(f.fixture.state().leases[0]?.releases).toBe(terminal === "promoted" ? 0 : 1)
        await f.close(); await f.close()
        expect(f.fixture.state().leases[0]?.releases).toBe(1)
        expect(f.fixture.pending()).toEqual([])
      } finally { await f.close() }
    })
  }

  test("W25 nonretained disposal releases an already queued latency drain exactly once", async () => {
    const f = await step6Publication(false)
    try {
      // Both deliveries queue the same drain while compilation holds publication.
      await f.act({ kind: "latency", value: 2048, sequence: 20 })
      await f.act({ kind: "latency", value: 4096, sequence: 21 })
      expect(f.fixture.state().counts.prepare ?? 0).toBe(0)
      await f.act({ kind: "submit-schedule", mode: "B" })
      await f.act(f.compile)
      await f.advance()
      expect(f.outcome()?.result).toEqual({ status: "superseded" })
      expect(f.fixture.state().actual.fft).toBe(4096)
      expect(f.fixture.pending()).toEqual([])
      const counts = f.fixture.state().counts
      await f.act({ kind: "drop-intents" }); await f.controls()
      expect(f.fixture.state().counts).toEqual(counts)
    } finally { await f.close() }
  })

  test("W26 public retained owner keeps latency independent and seed 4 retirement reader safety", async () => {
    const f = await step6Publication()
    try {
      await f.act({ kind: "block-asset" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(true)
      await f.act({ kind: "latency", value: 2048, sequence: 20 }); await f.advance()
      expect(f.fixture.state().actual.fft).toBe(2048)
      // Retained schedule recovery needs the real transition end, not caller settlement.
      for (let index = 0; index < 40 && f.fixture.state().latencyReadyEpoch !== undefined; index++) {
        await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
      }
      expect(f.fixture.state().latencyReadyEpoch).toBeUndefined()
      await f.act({ kind: "block-asset", value: 0 }); await f.act({ kind: "grant-capacity" })
      await f.act({ kind: "deliver-progress" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(false)
      expect(f.fixture.state().actual.fft).toBe(2048)
      expect(f.fixture.state().leases[0]?.releases).toBe(0)
      await f.act({ kind: "release-asset" }); await f.advance()
      const capacity = f.fixture.state().capacityGeneration
      const retires = f.fixture.state().counts.retire ?? 0
      await f.act({ kind: "sample", value: 0 })
      expect(f.fixture.state().capacityGeneration).toBe(capacity)
      expect(f.fixture.state().leases[0]?.releases).toBe(1)
      expect(f.fixture.state().leases[0]?.reclaimed).toBe(false)
      await f.act({ kind: "submit-schedule", mode: "remove" }); await f.advance()
      expect((f.fixture.state().counts.retire ?? 0) - retires).toBe(1)
      expect(f.fixture.state().retiredRevision).toBeUndefined()
      await f.act({ kind: "render-block" }); await f.act({ kind: "reclaim" })
      const retirementCount = f.fixture.state().counts.retire
      await f.act({ kind: "deliver-progress" }); await f.controls()
      expect(f.fixture.state().counts.retire).toBe(retirementCount)
      await f.act({ kind: "render-block" }); await f.act({ kind: "reclaim" })
      expect(f.fixture.state().capacityGeneration).toBeGreaterThan(capacity)
      expect(f.fixture.state().leases[0]?.releases).toBe(1)
      expect(f.fixture.state().leases[0]?.owners).toEqual([])
    } finally { await f.close() }
  })

  test("W26 public hold disposal balances retained Stretch leases without a native progress wake", async () => {
    const f = await step6Publication(true, false, true)
    try {
      await f.act({ kind: "block-asset" }); await f.advance()
      expect(f.fixture.adoptionRetained()).toBe(true)
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 0 })
      await f.act({ kind: "drop-intents" }); await f.fixture.storage(); await f.controls()
      expect(f.fixture.adoptionRetained()).toBe(false)
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 1 })
      await f.act({ kind: "drop-intents" }); await f.close()
      expect(f.fixture.stretchLeases()).toEqual({ acquired: 1, released: 1 })
    } finally { await f.close() }
  })

  for (const readd of ["before", "after"]) {
    test(`W26 public compile captures content ${readd} registry readd and native sends exactly that configuration`, async () => {
      const fixture = createBridge("runtime-revision-progress")
      const registry = createProcessorEditRegistry(() => 120)
      const initial = nativeInstrumentInput()
      let desired = initial
      let captured: ReturnType<typeof compileLivePlaybackSnapshot> | undefined
      const configured: Uint8Array[] = []
      const configure = fixture.bridge.session.configureInstrumentStates
      fixture.bridge.session.configureInstrumentStates = async bytes => {
        configured.push(bytes.slice())
        return configure(bytes)
      }
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      let hold = false
      const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
        getProcessorTarget: registry.target,
        compileSnapshot: async transport => {
          registry.observe(desired.renderState.fx)
          const compilation = compileLivePlaybackSnapshot({ ...desired, transport })
          if (hold) { captured = compilation; entered.resolve(); await release.promise }
          return compilation
        } })
      try {
        await controller.start(initial.transport)
        const instrument: TrackInstrumentParams = { kind: "synth", instanceId: "synth:1",
          params: { ...createDefaultSynthParams(), polyphony: 4 } }
        desired = { ...initial, renderState: { ...initial.renderState, fx: { ...initial.renderState.fx,
          trackFx: { instrument: { instances: [], instrument } } } } }
        if (readd === "before") { registry.reset(); registry.observe(desired.renderState.fx) }
        hold = true
        const adoption = controller.adoptSchedule({ key: `W26-${readd}`, schedule: `W26-${readd}`, context: {},
          loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
        await entered.promise
        if (readd === "after") { registry.reset(); registry.observe(desired.renderState.fx) }
        desired = { ...desired, renderState: { ...desired.renderState, fx: { ...desired.renderState.fx,
          trackFx: { instrument: { instances: [], instrument: { ...instrument,
            params: { ...instrument.params, polyphony: 8 } } } } } } }
        acknowledgeStagedPublication(fixture)
        release.resolve()
        expect(await adoption).toEqual({ status: "adopted" })
        if (!captured?.supported) throw new Error("W26 needs the actual captured compile")
        expect(captured.snapshot.mixer.fx.trackFx?.instrument?.instrument).toEqual(instrument)
        expect(configured.at(-1)).toEqual(
          serializeNativeInstrumentStates([{ nodeId: "instrument", state: compilePortableSynthState(instrument.params) }], []))
      } finally { release.resolve(); await controller.dispose() }
    })
  }

  test("W20 a definite refusal cannot erase an earlier uncertain attempt of the same receipt", () => {
    const owner = createNativeProcessorStateOwner()
    const delivery = owner.deliver({ key: "synth:uncertain", editId: "uncertain", order: 1, kindId: 18,
      incarnation: 1, epoch: 1, values: { "synth.outputGain": 0.25 } })
    const execution = owner.register({ key: "synth:uncertain", editId: "uncertain", order: 1, kindId: 18,
      sequence: 1, strategy: { kind: "urgent", sequence: 1 }, values: new Map([["synth.outputGain", 0.25]]),
      receipts: [delivery.receipt] }, { revision: 1, epoch: 1 })
    owner.send(execution, 1, 1)
    expect(owner.refuse(execution, "uncertain")).toBe("retry")
    expect(delivery.receipt.answered).toBeUndefined()
    owner.rebind(execution, { revision: 1, epoch: 1 }, 2)
    owner.send(execution, 2, 2)
    expect(owner.refuse(execution, "definite")).toBe("ended")
    expect(delivery.receipt.answered).toEqual({ state: "unconfirmed" })
  })
})

const processorEdit = (order: number, id = `edit-${order}`) => ({
  id,
  order,
  target: { nodeId: "track", instanceId: "utility:1", kindId: 1, incarnation: 1 },
  content: { params: createDefaultUtilityParams() },
})

// Requests without an explicit identity are independent fixture writes, not compatibility controller entries.
let fixtureEditOrder = 100;
const fixturePatchEdit = (request: { payload: NativeBuiltInParameterPayload; bpm: number; processorStateSequence?: number }): LiveProcessorEditIdentity => {
  const captured = captureNativeBuiltInStateCommit(request.payload, request.bpm);
  const timing = nativeBuiltInPatchTiming(request.payload);
  const allocated = createProcessorEditRegistry(() => request.bpm).allocate(request.payload);
  const order = request.payload.edit?.order ?? request.processorStateSequence ?? 0;
  if (!captured || !timing || !allocated) throw new Error("The fixture patch is not a built-in processor.");
  return {
    id: request.payload.edit?.id ?? `fixture-patch-${order}`, order,
    target: request.payload.edit?.target ?? allocated.target,
    content: { params: request.payload.to, state: captured.state, timing, values: {} },
  };
};
const fixtureParameterEdit = (request: LiveProcessorControlRequest): LiveProcessorEditIdentity => {
  const edit = request.edit ?? processorEdit(++fixtureEditOrder);
  return { ...edit, target: { ...edit.target, instanceId: request.instanceId },
    content: { ...edit.content, values: Object.fromEntries(request.values.map(entry => [entry.parameterId, entry.value])) } };
};
const fixtureGesture = (request: LiveProcessorControlRequest, holds: boolean) => request.edit
  ? { token: request.edit.id, holds: holds && !request.edit.rollback } : undefined;

describe("DV01 step5 repair", () => {
  const progress = (epoch: number, sequence: number): NativeScheduleProgress => ({
    revision: 1, epoch, progressSequence: BigInt(sequence + epoch),
    renderedThroughFrame: 0n, acceptedThroughFrame: 96000n, lastAcceptedWindowId: 1n,
    appliedTransportTransitionId: 0n, appliedUrgentSequence: 0n,
    appliedProcessorSequence: BigInt(sequence), running: false, scheduleComplete: false,
    instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
  })
  for (const state of ["sent", "admitted", "applied-unobserved", "dropped"]) {
    test(`5-R1 rollback across earlier epoch ${state}`, () => {
      const owner = createNativeProcessorStateOwner()
      const bytes = new Uint8Array([1])
      owner.configured(0, new Map([["utility:1", { kindId: 1, state: bytes, values: { gain: 0 } }]]))
      const request = (order: number, epoch: number, gain: number) => ({
        key: "utility:1", editId: `rollback-${order}`, order, epoch, kindId: 1,
        incarnation: 1, state: bytes, values: { gain },
      })
      const old = owner.deliver(request(1, 1, -2))
      const carrier = owner.register({ key: "utility:1", editId: "rollback-1", order: 1, kindId: 1,
        sequence: 1, strategy: { kind: "parameters" }, values: new Map([["gain", -2]]),
        receipts: [old.receipt] }, { epoch: 1, revision: 1 })
      expect(owner.send(carrier, 1)).toBe(true)
      if (state !== "sent") owner.admit(carrier)
      // Native may have applied -2 without reporting progress. Cached installed 0 is not proof of the rollback.
      owner.endDomain(2)
      if (state === "dropped") owner.cancel(carrier, false)
      const restored = owner.deliver(request(2, 2, 0))
      if (state === "dropped") {
        expect(restored.plan).toEqual({ carrier: "none" })
        expect(restored.receipt.answered).toEqual({ state: "applied" })
        return
      }
      expect(restored.receipt.answered).toBeUndefined()
      expect(restored.plan).toEqual({ carrier: "parameters", values: new Map([["gain", 0]]) })
      const restore = owner.register({ key: "utility:1", editId: "rollback-2", order: 2, kindId: 1,
        sequence: 2, strategy: { kind: "parameters" }, values: new Map([["gain", 0]]),
        receipts: [restored.receipt] }, { epoch: 2, revision: 1 })
      owner.send(restore, 2)
      owner.admit(restore)
      owner.observe(progress(2, 2))
      expect(restored.receipt.answered).toEqual({ state: "applied" })
    })
  }

  for (const hold of ["stop", "prime"]) {
    test(`5-R2 equivalent prepared start waits for seek ${hold}`, async () => {
      const fixture = createBridge()
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const compiledResume = Promise.withResolvers<void>()
      const setTransport = fixture.bridge.session.setTransport
      const queueWindow = fixture.bridge.session.queueScheduleWindow
      let resumed = false
      fixture.bridge.session.setTransport = async transport => {
        if (hold === "stop" && transport.epoch === 2 && !transport.running) {
          reached.resolve()
          await release.promise
        }
        return setTransport(transport)
      }
      fixture.bridge.session.queueScheduleWindow = async bytes => {
        if (hold === "prime" && new DataView(bytes.buffer).getUint32(4, true) === 2) {
          reached.resolve()
          await release.promise
        }
        return queueWindow(bytes)
      }
      const controller = createObservedController({ bridge: fixture.bridge,
        compileSnapshot: async transport => {
          const result = compileLivePlaybackSnapshot({ ...input(), transport })
          if (resumed) {
            // A fixed microtask checkpoint observes the compile continuation, not elapsed time or a polling loop.
            queueMicrotask(() => queueMicrotask(() => compiledResume.resolve()))
          }
          return result
        } })
      let seek: Promise<unknown> | undefined
      let play: Promise<unknown> | undefined
      let prematureRuns = -1
      try {
        expect(await controller.ensureLivePreview(0)).toBe("started")
        seek = controller.seekPrepared(0)
        await reached.promise
        resumed = true
        play = controller.start(input().transport)
        await compiledResume.promise
        prematureRuns = fixture.transports.filter(transport => transport.epoch === 2 && transport.running).length
        release.resolve()
        expect(await seek).toBe("started")
        expect(await play).toBe("started")
        expect(fixture.transports.at(-1)?.running).toBe(true)
      } finally {
        release.resolve()
        await Promise.allSettled([seek, play])
        await controller.dispose()
      }
      expect(prematureRuns).toBe(0)
    })
  }
})

describe("DV01 instrument truth", () => {
  type Answer = { value?: ProcessorDeliveryOutcome }
  const turns = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve() }
  const watch = (promise: Promise<ProcessorDeliveryOutcome>) => {
    const result: Answer = {}
    void promise.then((value) => { result.value = value })
    return result
  }
  const setup = (initial: TrackInstrumentParams = { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() },
    projectDesired = false, registry?: ReturnType<typeof createProcessorEditRegistry>, fingerprint = false) => {
    const fixture = createBridge()
    const faults: NativePlaybackFault[] = []
    let instrument: TrackInstrumentParams | undefined = initial
    let incarnation = 1
    let compiles = 0
    const base = nativeInstrumentInput()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      ...(fingerprint && { fingerprintSnapshot: (snapshot: Extract<TestCompilation, { supported: true }>["snapshot"]) =>
        JSON.stringify({ ...snapshot, revision: undefined, processorStateSequence: undefined,
          transport: { ...snapshot.transport, playheadSec: undefined, state: undefined } }) }),
      reportFault: fault => { faults.push(fault) },
      getProcessorTarget: (nodeId, instanceId) => {
        fixture.calls.push(`registry:${instanceId}`)
        if (registry) return registry.target(nodeId, instanceId)
        return instrument?.kind === "synth" && instrument.instanceId === instanceId ? { kindId: 18, incarnation,
          latest: { id: "latest-instrument", order: 20,
            target: { nodeId: "instrument", instanceId, kindId: 18, incarnation },
            content: { params: instrument } } } : undefined
      },
      ...(projectDesired && { getDesiredProcessorState: (snapshot, sampleRate) => {
        fixture.calls.push("instrument-desired")
        const projection = compileLiveNativeProjection({ tracks: snapshot.tracks, fx: snapshot.mixer.fx,
          bpm: snapshot.bpm, sampleRateHz: sampleRate, revision: 1, epoch: 1, firstSequence: 1 })
        if (!projection.supported) throw new Error(projection.reasons.join("; "))
        return { sequence: 20, graph: projection.graph, instruments: new Map(instrument?.kind === "synth"
          ? [["instrument", { kind: "synth", instanceId: instrument.instanceId,
            state: compilePortableSynthState(instrument.params) }]]
          : []) }
      } }),
      compileSnapshot: async (transport) => { compiles++; return compileLivePlaybackSnapshot({
        ...base, transport, ...(registry && { processorStateSequence: registry.sequence() }), renderState: { ...base.renderState, fx: { ...base.renderState.fx,
          trackFx: { instrument: { instances: [], ...(instrument && { instrument }) } } } },
      }) },
    })
    const edit = (value: Extract<TrackInstrumentParams, { kind: "synth" }>, order = 10, values: Record<string, number> = {}): LiveProcessorEditIdentity => ({
      id: `instrument-${order}`, order,
      target: { nodeId: "instrument", instanceId: value.instanceId, kindId: 18, incarnation },
      content: { params: value, values },
    })
    const key = async () => {
      const compiled = compileLivePlaybackSnapshot({ ...base, renderState: { ...base.renderState,
        fx: { ...base.renderState.fx, trackFx: { instrument: { instances: [], ...(instrument && { instrument }) } } } } })
      if (!compiled.supported) throw new Error("Missing snapshot")
      const projection = compileLiveNativeProjection({ tracks: compiled.snapshot.tracks, fx: compiled.snapshot.mixer.fx,
        bpm: 120, sampleRateHz: 48000, revision: 1, epoch: 1, firstSequence: 1 })
      if (!projection.supported) throw new Error(projection.reasons.join("; "))
      const state = projection.graph.nodes.find((node) => node.id === "instrument")?.instrument
      if (!state) throw new Error("Missing configured instrument")
      return nativeInstrumentContentKey(state)
    }
    const publish = async () => {
      const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-1")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

      acknowledgeStagedPublication(fixture)
      expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
    }
    return { fixture, controller, edit, key, publish, base, faults, compiles: () => compiles,
      set: (next: TrackInstrumentParams | undefined) => { instrument = next },
      nextIncarnation: () => { incarnation++ } }
  }
  const synth = (params = createDefaultSynthParams(), instanceId = "synth:1"): Extract<TrackInstrumentParams, { kind: "synth" }> =>
    ({ kind: "synth", instanceId, params })
  const liveValues = (state: ReturnType<typeof compilePortableSynthState>) => ({
    "synth.outputGain": state.outputGain ?? 1, "synth.outputPan": state.outputPan ?? 0,
    "synth.filterCutoffHz": state.filterCutoffHz ?? 20000, "synth.filterResonance": state.filterResonance ?? 0.7,
    "synth.ampAttackMs": state.ampAttackMs ?? 0, "synth.ampDecayMs": state.ampDecayMs ?? 0,
    "synth.ampSustain": state.ampSustain ?? 1, "synth.ampReleaseMs": state.ampReleaseMs ?? 0,
  })

  test("3B0 equal logical synth close still belongs to the native boundary", async () => {
    const initial = synth()
    const f = setup(initial)
    await f.controller.start(f.base.transport)
    const desired = synth({ ...initial.params, gain: 0.25 })
    f.set(desired)
    const edit = f.edit(desired)
    let portableCalls = 0, previews = 0, closes = 0, dispose = () => {}
    let answer: Answer | undefined
    const panel = createRoot(end => {
      dispose = end
      return createPersistedEffectState<TrackInstrumentParams, TrackInstrumentParams>({
        targetId: () => "instrument", row: () => initial, readQueryParams: row => row,
        createInitialParams: () => initial, serializeParams: JSON.stringify,
        applyToEngine: () => { portableCalls++; return "applied" },
        allocateEdit: () => edit,
        registerDelivery: (_target, _params, edit, gesture) => {
          if (!edit) return undefined;
          if (gesture?.holds) previews++; else closes++;
          const registration = f.controller.deliverProcessor(edit, gesture);
          answer = watch(registration.settled);
          return registration;
        },
        persistParams: () => ({ kind: "committed-unordered" }),
      })
    })
    await turns()
    portableCalls = 0; previews = 0; closes = 0
    const holder = new ParameterGestureHolder()
    panel.gestureOwner.open(holder)
    panel.gestureOwner.tick(holder, () => panel.update(() => desired))
    await turns()
    expect(answer?.value).toEqual({ state: "applied" })
    panel.gestureOwner.end(holder); await panel.flushPending()
    expect([previews, closes, portableCalls]).toEqual([1, 1, 2])
    if (process.env.DV01_3B0_REPORT === "1") console.log(`DV01-3B0 ${JSON.stringify({
      name: "R3-A3a panel logical close after native proof",
      location: "src/components/timeline/parameter-gesture-owner.ts:420",
      failure: null,
      expectedFailure: null,
      flip: "3B-1 offers both logical calls; native may immediately reuse actual proof without dispatch",
      standIn: "Real persisted adapter/owner and actual controller proof; today's flush is a separate compatibility callback",
      status: "green",
    })}`)
    dispose(); await f.controller.dispose()
  })

  test("3B0 registration-before-receipt through the real persisted adapter", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const desired = synth({ ...createDefaultSynthParams(), polyphony: 4 })
    f.set(desired)
    const saved: TrackInstrumentParams[] = []
    let answer: Answer | undefined
    let dispose = () => {}
    const panel = createRoot(end => {
      dispose = end
      return createPersistedEffectState<undefined, TrackInstrumentParams>({
        targetId: () => "instrument", row: () => undefined, readQueryParams: () => undefined,
        createInitialParams: () => undefined, serializeParams: JSON.stringify,
        // No portable installation is claimed here; native proof comes only from the actual controller.
        applyToEngine: () => "skipped",
        registerDelivery: () => {
          const registration = f.controller.deliverProcessor(f.edit(desired));
          answer = watch(registration.settled);
          return registration;
        },
        persistParams: (_target, value) => { saved.push(value); return { kind: "committed-unordered" }; },
      })
    })
    panel.setForTarget("instrument", desired)
    await turns()
    const beforeProof = saved.length
    expect(answer?.value).toBeUndefined()
    expect(beforeProof).toBe(1)
    await f.publish()
    await panel.flushPending()
    expect(answer?.value).toEqual({ state: "applied" })
    expect(saved).toEqual([desired])
    if (process.env.DV01_3B0_REPORT === "1") console.log(`DV01-3B0 ${JSON.stringify({
      name: "registration-before-receipt real-controller",
      location: "src/components/timeline/parameter-gesture-owner.ts:434,444",
      failure: null,
      expectedFailure: null,
      flip: "3B-1 save starts after synchronous registration, before matching native adoption",
      standIn: "Real adapter/owner/controller/bridge; boolean flush awaits the real receipt only to expose today's dependency",
      status: "green",
    })}`)
    dispose()
    await f.controller.dispose()
  })
  for (const kind of ["sampler", "granular", "drum-rack"] satisfies readonly ("sampler" | "granular" | "drum-rack")[]) {
    test(`3B0 sampled panel registers before save ${kind}`, async () => {
      const initial: TrackInstrumentParams = kind === "sampler" ? { kind, instanceId: "sampled", params: createDefaultSamplerParams() }
        : kind === "granular" ? { kind, instanceId: "sampled", params: createDefaultGranularParams() }
        : { kind, instanceId: "sampled", params: createDefaultDrumRackParams() }
      const f = setup(initial)
      await f.controller.start(f.base.transport)
      const contentKey = await f.key()
      let joins = 0, joinsAtSave = -1, dispose = () => {}
      let answer: Answer | undefined
      const panel = createRoot(end => {
        dispose = end
        return createPersistedEffectState<undefined, TrackInstrumentParams>({
          targetId: () => "instrument", row: () => undefined, readQueryParams: () => undefined,
          createInitialParams: () => undefined, serializeParams: JSON.stringify,
          applyToEngine: () => "skipped",
          persistParams: () => { joinsAtSave = joins; return { kind: "committed-unordered" }; },
          registerDelivery: () => {
            joins++;
            const registration = f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" }, contentKey, lifetime: 987 });
            answer = watch(registration.settled);
            return registration;
          },
        })
      })
      panel.setForTarget("instrument", initial)
      await panel.flushPending()
      expect(joinsAtSave).toBe(1)
      expect(joins).toBe(1)
      expect(answer?.value).toBeUndefined()
      expect(f.fixture.calls.includes("registry:sampled")).toBe(false)
      expect(f.fixture.instrumentPayloads).toHaveLength(0)
      await f.publish()
      await turns()
      expect(answer?.value).toEqual({ state: "applied" })
      if (process.env.DV01_3B0_REPORT === "1") console.log(`DV01-3B0 ${JSON.stringify({
        name: `sampled-joins-publication adapter ${kind}`,
        location: "src/components/timeline/create-persisted-effect-state.ts:137-140",
        failure: null,
        expectedFailure: null,
        flip: "3B-1 registers the content/target/lifetime join before persistence and structural handoff",
        standIn: "Current announce callback registers the real join; this proves its current late ordering, not the future callback contract",
        status: "green",
      })}`)
      dispose()
      await f.controller.dispose()
    })
  }

  test("3B1 urgent synth panel refusal retries once without prepare and real adoption recovers", async () => {
    const initial = synth()
    const registry = createProcessorEditRegistry(() => 120)
    registry.observe(nativeInstrumentInput().renderState.fx)
    const f = setup(initial, false, registry)
    await f.controller.start(f.base.transport)
    const desired = synth({ ...initial.params, gain: 0.25, pan: -0.2 })
    let refuse = true
    let attempts = 0
    const sent: number[][] = []
    const queue = f.fixture.bridge.session.queueInstrumentEvents
    f.fixture.bridge.session.queueInstrumentEvents = async bytes => {
      attempts++
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      sent.push(Array.from({ length: view.getUint32(0, true) }, (_, index) => view.getFloat32(48 + index * 48, true)))
      return refuse ? { ok: false, kind: "refused", error: "urgent refused" } : queue(bytes)
    }
    let answer: Answer | undefined, dispose = () => {}
    const histories: TrackInstrumentParams[] = []
    const panel = createRoot(end => {
      dispose = end
      return createPersistedEffectState<TrackInstrumentParams, TrackInstrumentParams>({
        targetId: () => "instrument", row: () => initial, readQueryParams: row => row,
        createInitialParams: () => initial, serializeParams: JSON.stringify, applyToEngine: () => "skipped",
        allocateEdit: (_target, _from, to) => {
          f.set(to)
          return registry.allocate({ effect: "instrument", targetId: "instrument", from: to, to })
        },
        registerDelivery: (_target, _value, edit, gesture) => {
          if (!edit) throw new Error("Missing urgent panel edit")
          const registration = f.controller.deliverProcessor(edit, gesture)
          answer = watch(registration.settled)
          return registration
        },
        persistParams: () => ({ kind: "committed-unordered" }),
        history: (_target, _from, to) => { histories.push(to) },
      })
    })
    await panel.flushPending()
    attempts = 0; sent.length = 0
    const before = f.fixture.calls.filter(call => call === "revision-prepare").length
    panel.setForTarget("instrument", desired)
    expect((await panel.flushPending()).unanswered).toEqual([])
    await turns()
    expect(attempts).toBe(2)
    expect(sent.every(values => values.length === 2)).toBeTrue()
    expect(sent[0]).toEqual(sent[1])
    expect(answer?.value).toEqual({ state: "refused", reason: "native-refused" })
    expect(f.faults).toEqual([{ kind: "delivery-refused", targets: 1 }])
    expect(histories).toEqual([desired])
    expect(f.fixture.calls.filter(call => call === "revision-prepare")).toHaveLength(before)
    refuse = false
    await f.publish()
    const configured = f.fixture.graphPayloads.length
    panel.setForTarget("instrument", synth({ ...desired.params, gain: 0.3 }))
    await panel.flushPending(); await turns()
    expect(answer?.value).toEqual({ state: "applied" })
    expect(attempts).toBe(3)
    expect(f.fixture.graphPayloads).toHaveLength(configured)
    if (process.env.DV01_3B1_REPORT === "1") console.log(`DV01-3B1 ${JSON.stringify({
      name: "R2-B6d urgent outcome through panel", location: "src/lib/desktop/native-playback-controller.test.ts",
      evidence: { refusedAttempts: 2, refusedValues: sent.slice(0, 2), histories: histories.length, recovery: answer?.value, totalAttempts: attempts },
      status: "green", failure: null, expectedFailure: null, standIn: null, flip: "Actual persisted synth panel registration and urgent bridge proof",
    })}`)
    dispose(); await f.controller.dispose()
  })

  test("3B1 reconfigured synth panel proof follows sent state, not the newer held state", async () => {
    const initial = synth()
    const registry = createProcessorEditRegistry(() => 120)
    registry.observe(nativeInstrumentInput().renderState.fx)
    const f = setup(initial, false, registry)
    await f.controller.start(f.base.transport)
    const a = synth({ ...initial.params, polyphony: 4 })
    const b = synth({ ...initial.params, polyphony: 8 })
    const answers: Answer[] = []
    const history: TrackInstrumentParams[] = []
    let dispose = () => {}
    const panel = createRoot(end => {
      dispose = end
      return createPersistedEffectState<TrackInstrumentParams, TrackInstrumentParams>({
        targetId: () => "instrument", row: () => initial, readQueryParams: row => row,
        createInitialParams: () => initial, serializeParams: JSON.stringify, applyToEngine: () => "skipped",
        allocateEdit: (_target, _from, to) => {
          f.set(to)
          return registry.allocate({ effect: "instrument", targetId: "instrument", from: to, to })
        },
        registerDelivery: (_target, _value, edit, gesture) => {
          if (!edit) throw new Error("Missing reconfigure panel identity")
          const registration = f.controller.deliverProcessor(edit, gesture)
          answers.push(watch(registration.settled))
          return registration
        },
        persistParams: () => ({ kind: "committed-unordered" }),
        history: (_target, _from, to) => { history.push(to) },
      })
    })
    await panel.flushPending()
    answers.length = 0
    panel.setForTarget("instrument", a)
    await panel.flushPending()
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-2")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const configure = f.fixture.bridge.session.configureInstrumentStates
    const captured = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const states: Uint8Array[] = []
    f.fixture.bridge.session.configureInstrumentStates = async bytes => {
      states.push(bytes.slice())
      captured.resolve()
      await release.promise
      return configure(bytes)
    }
    acknowledgeStagedPublication(f.fixture)
    const publication = (candidateCompile.release(), candidateAdoption)
    await captured.promise
    panel.setForTarget("instrument", b)
    await panel.flushPending()
    expect(answers.map(answer => answer.value)).toEqual([undefined, undefined])
    expect(states).toEqual([serializeNativeInstrumentStates([{ nodeId: "instrument", state: compilePortableSynthState(a.params) }], [])])
    release.resolve()
    expect(await publication).toEqual({ status: "adopted" })
    await turns()
    expect(answers.map(answer => answer.value)).toEqual([{ state: "applied" }, undefined])
    const before = f.fixture.instrumentPayloads.length
    const nextB = synth({ ...b.params, gain: 0.3 })
    panel.setForTarget("instrument", nextB)
    const pending = await panel.flushPending()
    await turns()
    expect(answers.at(-1)?.value).toBeUndefined()
    expect(pending.unanswered).toHaveLength(2)
    expect(f.fixture.instrumentPayloads).toHaveLength(before)
    expect(panel.params()).toEqual(nextB)
    expect(history).toEqual([a, b, nextB])
    await f.publish()
    await turns()
    expect(answers.at(-1)?.value).toEqual({ state: "applied" })
    expect(states.at(-1)).toEqual(serializeNativeInstrumentStates([{ nodeId: "instrument", state: compilePortableSynthState(nextB.params) }], []))
    if (process.env.DV01_3B1_REPORT === "1") console.log(`DV01-3B1 ${JSON.stringify({
      name: "R2-B6c panel reconfigure from sent synth", location: "src/lib/desktop/native-playback-controller.test.ts",
      evidence: { sentPolyphony: a.params.polyphony, heldPolyphony: b.params.polyphony, urgentWhileMismatched: 0, unansweredAfterFirstAdoption: pending.unanswered.length, final: answers.at(-1)?.value, history: history.length },
      status: "green", failure: null, expectedFailure: null, standIn: null, flip: "Actual persisted panel and exact sent instrument-state publication",
    })}`)
    dispose(); await f.controller.dispose()
  })

  test("synth-unknown-live", async () => {
    const f = setup(synth(), true)
    await f.controller.start(f.base.transport)
    const desired = synth({ ...createDefaultSynthParams(), gain: 0.25 })
    // Native has no installed proof for this new registry incarnation, even though the visible instance is equal.
    f.nextIncarnation()
    f.set(desired)
    const before = f.fixture.instrumentPayloads.length
    const answer = watch(f.controller.deliverProcessor(f.edit(desired)).settled)
    expect(answer.value).toBeUndefined()
    await turns()
    expect(answer.value).toBeUndefined()
    expect(f.fixture.instrumentPayloads.length).toBe(before)
    expect(f.fixture.calls.filter((call) => call === "stage-prepare")).toHaveLength(0)
    expect(liveValues(compilePortableSynthState(desired.params))).toEqual({
      "synth.outputGain": 0.25, "synth.outputPan": 0,
      "synth.filterCutoffHz": 12000, "synth.filterResonance": 0.7,
      "synth.ampAttackMs": 5, "synth.ampDecayMs": 100, "synth.ampSustain": 0.8, "synth.ampReleaseMs": 120,
    })
    await f.publish()
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    await f.controller.dispose()
  })
  test("synth-unknown-nonlive", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const desired = synth({ ...createDefaultSynthParams(), polyphony: 4 })
    f.set(desired)
    const before = f.fixture.instrumentPayloads.length
    const answer = watch(f.controller.deliverProcessor(f.edit(desired, 10, liveValues(compilePortableSynthState(desired.params)))).settled)
    await turns()
    expect(answer.value).toBeUndefined()
    expect(f.fixture.instrumentPayloads.length).toBe(before)
    await f.publish()
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    await f.controller.dispose()
  })
  for (const [name, change] of [
    ["polyphony", { polyphony: 4 }],
    ["waveform", { oscillators: [{ wave: "square" }] }],
  ] satisfies readonly [string, SynthParamsUpdate][]) test(`a non-live Synth ${name} edit while playing is adopted through the instrument-state configuration, with no new session`, async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const before = f.fixture.calls.length
    f.set(synth(mergeSynthParams(createDefaultSynthParams(), change)))
    let configurations = 0
    const configure = f.fixture.bridge.session.configureInstrumentStates
    f.fixture.bridge.session.configureInstrumentStates = async bytes => { configurations++; return configure(bytes) }
    acknowledgeStagedPublication(f.fixture)
    expect(await f.controller.adoptSchedule(migrationIntent(`synth-${name}`), true)).toEqual({ status: "adopted" })
    expect(configurations).toBe(1)
    expect(f.fixture.calls.slice(before).filter(call => ["graph", "stop", "teardown", "begin"].includes(call))).toEqual([])
    await f.controller.dispose()
  })
  test("synth-retrigger-equal-native-content", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const desired = synth({ ...createDefaultSynthParams(), retrigger: !createDefaultSynthParams().retrigger })
    const before = f.fixture.instrumentPayloads.length
    const answer = watch(f.controller.deliverProcessor(f.edit(desired)).settled)
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    expect(f.fixture.instrumentPayloads.length).toBe(before)
    expect(f.fixture.calls.filter((call) => call === "stage-prepare")).toHaveLength(0)
    await f.controller.dispose()
  })
  test("synth-instance-swap", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const old = f.edit(synth({ ...createDefaultSynthParams(), polyphony: 4 }))
    const oldAnswer = watch(f.controller.deliverProcessor(old).settled)
    f.set(synth({ ...createDefaultSynthParams(), gain: 0.3 }, "synth:2"))
    f.nextIncarnation()
    const next = synth({ ...createDefaultSynthParams(), gain: 0.3 }, "synth:2")
    const before = f.fixture.instrumentPayloads.length
    const answer = watch(f.controller.deliverProcessor(f.edit(next, 11)).settled)
    await turns()
    expect(answer.value).toBeUndefined()
    expect(f.fixture.instrumentPayloads.length).toBe(before)
    await f.publish()
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    expect(oldAnswer.value?.state).toBe("unavailable")
    const retired = watch(f.controller.deliverProcessor(old).settled)
    await turns()
    expect(retired.value).toEqual({ state: "unavailable" })
    await f.controller.dispose()
  })
  test("installed-follows-published", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const published = synth({ ...createDefaultSynthParams(), polyphony: 4 })
    f.set(published)
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-3")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

    const captured = watch(f.controller.deliverProcessor(f.edit(published, 11)).settled)
    f.set(synth({ ...published.params, polyphony: 8 }))
    f.nextIncarnation()
    acknowledgeStagedPublication(f.fixture)
    expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
    await turns()
    expect(captured.value).toEqual({ state: "applied" })
    const answer = watch(f.controller.deliverProcessor(f.edit(published, 12)).settled)
    await turns()
    expect(answer.value).toBeUndefined()
    const latest = synth({ ...published.params, polyphony: 8 })
    const unanswered = watch(f.controller.deliverProcessor(f.edit(latest, 13)).settled)
    await turns()
    expect(unanswered.value).toBeUndefined()
    await f.controller.dispose()
  })
  // Review m1: the compile reads the project, which a drag reaches on release; a live value delivered while it runs is
  // part of the instrument state the adoption configures, or the publication would slew every live target back.
  test("m1 a live Synth value delivered while an adoption compiles is in the instrument state it configures", async () => {
    const f = setup(synth(), true)
    await f.controller.start(f.base.transport)
    const compiled = synth({ ...createDefaultSynthParams(), polyphony: 4 })
    f.set(compiled)
    const compile = holdCompile(f.controller)
    const adoption = f.controller.adoptSchedule(migrationIntent("m1"), true)
    await compile.entered
    const live = synth({ ...compiled.params, gain: 0.125 })
    f.set(live)
    const answer = watch(f.controller.deliverProcessor(f.edit(live, 30, liveValues(compilePortableSynthState(live.params)))).settled)
    const states: Uint8Array[] = []
    const configure = f.fixture.bridge.session.configureInstrumentStates
    f.fixture.bridge.session.configureInstrumentStates = async bytes => { states.push(bytes.slice()); return configure(bytes) }
    acknowledgeStagedPublication(f.fixture)
    expect(await (compile.release(), adoption)).toEqual({ status: "adopted" })
    await turns()
    expect(states).toEqual([serializeNativeInstrumentStates([{ nodeId: "instrument", state: compilePortableSynthState(live.params) }], [])])
    expect(answer.value).toEqual({ state: "applied" })
    await f.controller.dispose()
  })
  test("R2-B6c-configured-content-not-held", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const before = f.fixture.instrumentPayloads.length
    const state = compilePortableSynthState(createDefaultSynthParams())
    expect(nativeInstrumentContentKey({ outputGain: state.outputGain, ...state })).toBe(nativeInstrumentContentKey(state))
    const answer = watch(f.controller.deliverProcessor(f.edit(synth())).settled)
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    expect(f.fixture.instrumentPayloads.length).toBe(before)
    await f.controller.dispose()
  })
  test("R2-B6a-post-capture-instrument-ingest", async () => {
    const f = setup(synth(), true)
    const start = f.fixture.bridge.session.start
    f.fixture.bridge.session.start = async () => {
      f.set(synth({ ...createDefaultSynthParams(), gain: 0.25 }))
      return start()
    }
    expect(await f.controller.start(f.base.transport)).toBe("started")
    await turns()
    expect(f.fixture.calls.slice(f.fixture.calls.indexOf("start")).filter((call) => call === "instrument-desired")).toHaveLength(1)
    expect(f.fixture.instrumentPayloads).toHaveLength(2)
    const last = f.fixture.instrumentPayloads.at(-1)
    expect(last && new DataView(last.buffer).getFloat32(48, true)).toBe(0.25)
    await f.controller.dispose()
  })
  test("sampled-abort-and-readd-controller", async () => {
    const params = createDefaultGranularParams()
    const f = setup({ kind: "granular", instanceId: "sampled", params })
    await f.controller.start(f.base.transport)
    const join = { target: { nodeId: "instrument", instanceId: "sampled" }, contentKey: await f.key(), lifetime: 3 }
    const old = watch(f.controller.joinPublication(join).settled)
    f.set(synth())
    await f.publish()
    f.set({ kind: "granular", instanceId: "sampled", params })
    const next = watch(f.controller.joinPublication(join).settled)
    await f.publish()
    await turns()
    expect(old.value?.state).toBe("unavailable")
    expect(next.value?.state).toBe("applied")
    await f.controller.dispose()
  })
  test("R2-B6b-N2-equal-mapped-different-structure", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    const desired = synth({ ...createDefaultSynthParams(), polyphony: 4 })
    const before = f.fixture.instrumentPayloads.length
    const answer = watch(f.controller.deliverProcessor(f.edit(desired, 10, liveValues(compilePortableSynthState(desired.params)))).settled)
    await turns()
    expect(answer.value).toBeUndefined()
    expect(f.fixture.instrumentPayloads.length).toBe(before)
    f.set(desired)
    await f.publish()
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    await f.controller.dispose()
    // N2's built-in companion: publication installed a different non-live structure, but the mapped values agree.
    const fixture = createBridge()
    const base = utilityPlaybackInput()
    const row = createDefaultUtilityParams()
    const controller = createObservedController({
      bridge: fixture.bridge, compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
        ...base, transport, renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: {
          track: { instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: { ...row, polarity: "invert" } } }] },
        } } },
      }),
    })
    await controller.start(base.transport)
    const payload: EffectParamsCommitPayload<"utility"> = {
      effect: "utility", targetId: "track", instanceId: "utility:1", from: { version: 1, state: row }, to: { version: 1, state: row },
    }
    const restored = watch(controller.deliverProcessor({
      id: "row-structure", order: 30, target: { nodeId: "track", instanceId: "utility:1", kindId: 1, incarnation: 1 },
      content: { params: row, state: encodeUtilityProcessorState(row), values: { "utility.gainDb": 0, "utility.pan": 0 },
        timing: nativeBuiltInPatchTiming(payload) },
    }).settled)
    await turns()
    expect(restored.value).toEqual({ state: "applied" })
    expect(fixture.statePatchPayloads).toHaveLength(1)
    expect(fixture.builtInParameterPayloads).toHaveLength(0)
    await controller.dispose()
  })
  for (const kind of ["sampler", "granular", "drum-rack"] satisfies readonly ("sampler" | "granular" | "drum-rack")[]) {
    const initial: TrackInstrumentParams = kind === "sampler" ? { kind, instanceId: "sampled", params: createDefaultSamplerParams() }
      : kind === "granular" ? { kind, instanceId: "sampled", params: createDefaultGranularParams() }
      : { kind, instanceId: "sampled", params: createDefaultDrumRackParams() }
    test(`sampled-joins-publication-${kind}`, async () => {
      const f = setup(initial)
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 987 }).settled)
      await turns()
      expect(answer.value).toBeUndefined()
      await f.publish()
      await turns()
      expect(answer.value).toEqual({ state: "applied" })
      expect(f.fixture.builtInParameterPayloads).toHaveLength(0)
      expect(f.fixture.calls.includes("registry:sampled")).toBeFalse()
      await f.controller.dispose()
    })
  }
  for (const strict of [false, true]) test(
    `W18 associated pre-Publish drop ${strict ? "answers not-claimed" : "retains desired without incident or exhaustion"}`, async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    await f.controller.start(f.base.transport)
    f.set({ kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), densityHz: 7 } })
    const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
      contentKey: await f.key(), lifetime: 14 }).settled)
    acknowledgeStagedPublication(f.fixture)
    const prepare = f.fixture.bridge.session.revisions.prepare
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.fixture.bridge.session.revisions.prepare = async request => {
      entered.resolve()
      await release.promise
      return prepare(request)
    }
    try {
      const adoption = f.controller.adoptSchedule({ key: "drop", schedule: "drop", context: {},
        loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
      await entered.promise
      f.controller.dropAdoptionIntents()
      release.resolve()
      const outcome = await adoption
      await turns()
      console.log("STEP6-EVIDENCE", JSON.stringify({ test: "not-taken", outcome, answer: answer.value ?? "unanswered" }))
      expect(outcome.status).toBe("superseded")
      expect(f.faults.filter(fault => fault.kind === "delivery-refused")).toHaveLength(0)
      if (strict) expect(answer.value).toEqual({ state: "refused", reason: "not-claimed" })
      const recovery = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 14 }).settled)
      expect(await f.controller.adoptSchedule({ key: "recover", schedule: "recover", context: {},
        loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })).toMatchObject({ status: "adopted" })
      expect(f.faults.filter(fault => fault.kind === "delivery-refused")).toHaveLength(0)
      expect(recovery.value).toEqual({ state: "applied" })
    } finally { release.resolve(); await f.controller.dispose() }
  })

  for (const terminal of ["prepare-refused", "publish-failed"]) {
    test(`W19 associated ${terminal} refuses its own join`, async () => {
      const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
      await f.controller.start(f.base.transport)
      f.set({ kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), densityHz: 7 } })
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 13 }).settled)
      acknowledgeStagedPublication(f.fixture)
      if (terminal === "prepare-refused") f.fixture.bridge.session.revisions.prepare = async () =>
        ({ ok: false, error: "native refused this prepare", kind: "refused" })
      else {
        const proof = f.fixture.bridge.session.revisions.inspect
        const failure = async (request: Parameters<NativeRevisionSession["inspect"]>[0]): Promise<NativeRevisionReply> => {
          const value = await proof(request)
          return value.ok ? { ...value, revision: { ...value.revision, status: "publish-failed" } } : value
        }
        f.fixture.bridge.session.revisions.publish = failure
        f.fixture.bridge.session.revisions.inspect = failure
      }
      try {
        const outcome = await f.controller.adoptSchedule({ key: terminal, schedule: terminal, context: {},
          loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
        await turns()
        console.log("STEP6-EVIDENCE", JSON.stringify({ terminal, outcome, answer: answer.value ?? "unanswered",
          prepared: f.controller.isPrepared() }))
        expect(outcome.status).toBe("failed")
        expect(answer.value).toEqual({ state: "refused", reason: terminal === "prepare-refused" ? "native-refused" : "apply-failed" })
      } finally { await f.controller.dispose() }
    })
  }

  test("W14 E8 live-session generation drift still inspects prepared bank", async () => {
    const fixture = createBridge("runtime-revision-progress")
    const base = nativeInstrumentInput()
    let generation = 1
    const controller = createObservedController({ bridge: fixture.bridge,
      getProjectId: () => "local_project", getProjectGeneration: () => generation,
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport }) })
    await controller.start(base.transport)
    acknowledgeStagedPublication(fixture)
    let inspections = 0, rollbacks = 0
    fixture.bridge.session.revisions.publish = async () => {
      generation++
      throw new Error("lost publish reply during live session generation change")
    }
    fixture.bridge.session.revisions.inspect = async () => {
      inspections++
      return fixture.revisionReply("prepared")
    }
    fixture.bridge.session.revisions.rollback = async () => {
      rollbacks++
      return fixture.revisionReply("rolled-back")
    }
    try {
      const outcome = await controller.adoptSchedule({ key: "generation", schedule: "generation", context: {},
        loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
      console.log("STEP6-EVIDENCE", JSON.stringify({ test: "session-alive-generation", outcome,
        inspections, rollbacks, prepared: controller.isPrepared(), nativeStopped: fixture.calls.includes("stop") }))
      expect(inspections).toBeGreaterThan(0)
      expect(rollbacks).toBe(1)
    } finally { await controller.dispose() }
  })

  test("W14 loss after Publish sends zero native reconciliation commands", async () => {
    const f = setup()
    await f.controller.start(f.base.transport)
    acknowledgeStagedPublication(f.fixture)
    let afterLoss = false, postLossCommands = 0
    f.fixture.bridge.session.revisions.publish = async () => {
      afterLoss = true
      f.fixture.emitLoss("Host lost in publication")
      return { ok: false, error: "Host lost", kind: "unavailable" }
    }
    f.fixture.bridge.session.revisions.inspect = async () => {
      if (afterLoss) postLossCommands++
      return f.fixture.revisionReply("stale-revision")
    }
    f.fixture.bridge.session.revisions.rollback = async () => {
      if (afterLoss) postLossCommands++
      return f.fixture.revisionReply("rolled-back")
    }
    try {
      const outcome = await f.controller.adoptSchedule({ key: "loss", schedule: "loss", context: {},
        loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
      await turns()
      console.log("STEP6-EVIDENCE", JSON.stringify({ test: "loss", outcome, postLossCommands }))
      expect(outcome.status).toBe("superseded")
      expect(postLossCommands).toBe(0)
    } finally { await f.controller.dispose() }
  })

  for (const postAck of ["stale-revision", "publish-pending"] satisfies NativeGraphRevisionStatus["status"][]) {
    test(`W17 post-ACK ${postAck} is conclusive with one Inspect`, async () => {
      const f = setup()
      await f.controller.start(f.base.transport)
      acknowledgeStagedPublication(f.fixture)
      const entered = Promise.withResolvers<void>()
      let acked = false, afterAckInspections = 0, afterAckRollbacks = 0
      const afterAckRequests: number[] = []
      const nativeTransport = f.fixture.bridge.session.setTransport
      f.fixture.bridge.session.setTransport = async transport => {
        const reply = await nativeTransport(transport)
        if (transport.epoch > 1) acked = true
        return reply
      }
      f.fixture.bridge.session.revisions.publish = async () => {
        acked = false
        entered.resolve()
        return f.fixture.revisionReply("publish-pending")
      }
      f.fixture.bridge.session.revisions.inspect = async request => {
        if (acked) {
          afterAckRequests.push(request.revision)
          if (request.revision === 2) afterAckInspections++
        }
        return f.fixture.revisionReply(acked ? postAck : "publish-pending")
      }
      f.fixture.bridge.session.revisions.rollback = async () => {
        if (acked) afterAckRollbacks++
        return f.fixture.revisionReply("publish-pending")
      }
      try {
        const adoption = f.controller.adoptSchedule({ key: postAck, schedule: postAck, context: {},
          loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
        await entered.promise
        await f.controller.pause(0)
        const outcome = await adoption
        console.log("STEP6-EVIDENCE", JSON.stringify({ test: "post-ACK", postAck, outcome,
          afterAckInspections, afterAckRequests, afterAckRollbacks }))
        expect(afterAckInspections).toBe(1)
        expect(outcome.status).toBe("superseded")
        expect(afterAckRollbacks).toBe(0)
      } finally { await f.controller.dispose() }
    })
  }

  for (const status of ["stale-revision", "invalid-revision"] satisfies NativeGraphRevisionStatus["status"][]) {
    test(`W12 native ${status} fails definitely and releases once`, async () => {
      const f = setup()
      await f.controller.start(f.base.transport)
      acknowledgeStagedPublication(f.fixture)
      const proof = f.fixture.bridge.session.revisions.inspect
      let rollbacks = 0
      const failure = async (request: Parameters<NativeRevisionSession["inspect"]>[0]): Promise<NativeRevisionReply> => {
        const value = await proof(request)
        return value.ok ? { ...value, revision: { ...value.revision, status,
          preparedRevision: status === "stale-revision" ? 0 : value.revision.preparedRevision } } : value
      }
      f.fixture.bridge.session.revisions.publish = failure
      f.fixture.bridge.session.revisions.inspect = failure
      f.fixture.bridge.session.revisions.rollback = async () => { rollbacks++; return f.fixture.revisionReply("rolled-back") }
      try {
        const outcome = await f.controller.adoptSchedule({ key: status, schedule: status, context: {},
          loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })
        console.log("STEP6-EVIDENCE", JSON.stringify({ test: "native-terminal", status, outcome, rollbacks,
          candidates: f.controller.liveScheduleCandidates() }))
        expect(outcome.status).toBe("failed")
        expect(rollbacks).toBeLessThanOrEqual(1)
        expect(f.controller.liveScheduleCandidates()).toBe(0)
      } finally { await f.controller.dispose() }
    })
  }

  const step6Intent = (key: string) => ({ key, schedule: key, context: {},
    loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } })

  test("W11 native publish-failed proves failure and releases its bank", async () => {
    const f = setup()
    try {
      await f.controller.start(f.base.transport)
      acknowledgeStagedPublication(f.fixture)
      const inspect = f.fixture.bridge.session.revisions.inspect
      const failed = async (request: Parameters<NativeRevisionSession["inspect"]>[0]): Promise<NativeRevisionReply> => {
        const reply = await inspect(request)
        return reply.ok ? { ...reply, revision: { ...reply.revision, status: "publish-failed" } } : reply
      }
      let rollbacks = 0
      f.fixture.bridge.session.revisions.publish = failed
      f.fixture.bridge.session.revisions.inspect = failed
      f.fixture.bridge.session.revisions.rollback = async () => { rollbacks++; return f.fixture.revisionReply("rolled-back") }
      expect(await f.controller.adoptSchedule(step6Intent("W11"))).toEqual({
        status: "failed", reason: "Native live publication was publish-failed.",
      })
      expect(rollbacks).toBe(1)
      expect(f.controller.liveScheduleCandidates()).toBe(0)
    } finally { await f.controller.dispose() }
  })

  test("W13 pending label without in-flight ownership uses rolled-back proof", async () => {
    const f = setup()
    const entered = Promise.withResolvers<void>()
    let rollbacks = 0
    try {
      await f.controller.start(f.base.transport)
      acknowledgeStagedPublication(f.fixture)
      f.fixture.bridge.session.revisions.publish = async () => { entered.resolve(); return f.fixture.revisionReply("publish-pending") }
      f.fixture.bridge.session.revisions.inspect = async () => f.fixture.revisionReply("prepared")
      f.fixture.bridge.session.revisions.rollback = async () => { rollbacks++; return f.fixture.revisionReply("rolled-back") }
      const adoption = f.controller.adoptSchedule(step6Intent("W13"))
      await entered.promise
      await f.controller.pause(0)
      expect(await adoption).toEqual({ status: "superseded" })
      expect(rollbacks).toBe(1)
      expect(f.controller.liveScheduleCandidates()).toBe(0)
    } finally { await f.controller.dispose() }
  })

  for (const foreign of ["host", "revision", "seam", "epoch"]) {
    test(`W16 rejects foreign ${foreign} proof without applying a join`, async () => {
      const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
      try {
        await f.controller.start(f.base.transport)
        const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
          contentKey: await f.key(), lifetime: 41 }).settled)
        acknowledgeStagedPublication(f.fixture)
        const publish = f.fixture.bridge.session.revisions.publish
        const proof = async (request: Parameters<NativeRevisionSession["publish"]>[0]): Promise<NativeRevisionReply> => {
          const reply = await publish(request)
          return reply.ok ? { ...reply, hostPid: foreign === "host" ? 999 : reply.hostPid,
            revision: { ...reply.revision,
              activeRevision: foreign === "revision" ? 999 : reply.revision.activeRevision,
              publicationFrame: foreign === "seam" ? 1n : reply.revision.publicationFrame,
              transportEpoch: foreign === "epoch" ? 999 : reply.revision.transportEpoch } } : reply
        }
        f.fixture.bridge.session.revisions.publish = proof
        f.fixture.bridge.session.revisions.inspect = proof
        expect((await f.controller.adoptSchedule(step6Intent(`W16-${foreign}`))).status).not.toBe("adopted")
        expect(answer.value).toBeUndefined()
      } finally { await f.controller.dispose() }
    })
  }

  for (const terminal of ["proof", "loss"]) {
    test(`W20 uncertain Publish receipt stays pending until ${terminal}`, async () => {
      const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const proof = Promise.withResolvers<void>()
      try {
        await f.controller.start(f.base.transport)
        f.set({ kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), densityHz: 7 } })
        const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
          contentKey: await f.key(), lifetime: 42 }).settled)
        acknowledgeStagedPublication(f.fixture)
        const publish = f.fixture.bridge.session.revisions.publish
        const inspect = f.fixture.bridge.session.revisions.inspect
        let armed = false
        f.fixture.bridge.session.revisions.inspect = async request => {
          if (!armed) return inspect(request)
          await proof.promise
          return inspect(request)
        }
        f.fixture.bridge.session.revisions.publish = async request => {
          armed = true
          await publish(request)
          entered.resolve()
          await release.promise
          throw new Error("Publish reply lost")
        }
        const adoption = f.controller.adoptSchedule(step6Intent(`W20-${terminal}`))
        let result: Awaited<typeof adoption> | undefined
        void adoption.then(value => { result = value })
        await entered.promise
        expect(answer.value).toBeUndefined()
        release.resolve()
        await turns()
        expect(result).toBeUndefined()
        expect(answer.value).toBeUndefined()
        if (terminal === "loss") f.fixture.emitLoss("W20 session ended")
        proof.resolve()
        const outcome = await adoption; await turns()
        console.log("STEP6-EVIDENCE", JSON.stringify({ witness: "W20", terminal, outcome, answer: answer.value }))
        expect(answer.value).toEqual({ state: terminal === "proof" ? "applied" : "unavailable" })
      } finally { release.resolve(); proof.resolve(); await f.controller.dispose() }
    })
  }

  test("W21 unrelated content adoption leaves unmatched join unanswered", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "unrelated-sampled" },
        contentKey: "future-content-not-captured", lifetime: 43 }).settled)
      acknowledgeStagedPublication(f.fixture)
      const outcome = await f.controller.adoptSchedule(step6Intent("W21-unrelated"))
      console.log("STEP6-EVIDENCE", JSON.stringify({ witness: "W21-unrelated", outcome }))
      expect(outcome.status).toBe("adopted")
      expect(answer.value).toBeUndefined()
    } finally { await f.controller.dispose() }
  })

  test("W21 same instance on another node cannot inherit proof", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "another-node", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 44 }).settled)
      acknowledgeStagedPublication(f.fixture)
      await f.controller.adoptSchedule(step6Intent("W21-node"))
      expect(answer.value).toBeUndefined()
    } finally { await f.controller.dispose() }
  })

  test("W21 equal content different edit IDs joins actual adoption", async () => {
    const f = setup()
    try {
      await f.controller.start(f.base.transport)
      const desired = synth({ ...createDefaultSynthParams(), polyphony: 4 })
      f.set(desired)
      const edit = f.edit(desired)
      const a = watch(f.controller.deliverProcessor(edit).settled)
      const b = watch(f.controller.deliverProcessor({ ...edit, id: "equal-other-id" }).settled)
      expect([a.value, b.value]).toEqual([undefined, undefined])
      acknowledgeStagedPublication(f.fixture)
      const outcome = await f.controller.adoptSchedule(step6Intent("W21-equal")); await turns()
      console.log("STEP6-EVIDENCE", JSON.stringify({ witness: "W21-equal", outcome }))
      expect([a.value, b.value]).toEqual([{ state: "applied" }, { state: "applied" }])
    } finally { await f.controller.dispose() }
  })

  for (const guard of ["future-lifetime", "carrier-freeze", "incarnation"]) {
    test(`W21 frozen carrier rejects ${guard} from its old proof`, async () => {
      const sampled: TrackInstrumentParams = { kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() }
      const f = setup(guard === "incarnation" ? synth() : sampled)
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      try {
        await f.controller.start(f.base.transport)
        const desired = synth({ ...createDefaultSynthParams(), polyphony: 4 })
        if (guard === "incarnation") f.set(desired)
        const key = await f.key()
        const old = guard === "incarnation" ? watch(f.controller.deliverProcessor(f.edit(desired, 10)).settled)
          : watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" }, contentKey: key, lifetime: 61 }).settled)
        acknowledgeStagedPublication(f.fixture)
        const prepare = f.fixture.bridge.session.revisions.prepare
        f.fixture.bridge.session.revisions.prepare = async request => {
          entered.resolve(); await release.promise; return prepare(request)
        }
        const adoption = f.controller.adoptSchedule(step6Intent(`W21-${guard}`))
        await entered.promise
        if (guard === "incarnation") f.nextIncarnation()
        if (guard === "carrier-freeze") f.set({ ...sampled, params: { ...createDefaultGranularParams(), densityHz: 7 } })
        const next = guard === "incarnation" ? watch(f.controller.deliverProcessor(f.edit(desired, 11)).settled)
          : watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
            contentKey: await f.key(), lifetime: guard === "future-lifetime" ? 62 : 61 }).settled)
        release.resolve(); expect((await adoption).status).toBe("adopted"); await turns()
        expect(next.value).toBeUndefined()
        if (guard !== "incarnation") expect(old.value).toEqual({ state: "applied" })
      } finally { release.resolve(); await f.controller.dispose() }
    })
  }

  test("W20 publication definite refusal preserves an earlier uncertain attempt", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 63 }).settled)
      f.fixture.bridge.session.revisions.prepare = async () => { throw new Error("Prepare reply lost before bank identity") }
      expect((await f.controller.adoptSchedule(step6Intent("W20-first"))).status).toBe("failed")
      expect(answer.value).toBeUndefined()
      f.fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "typed second refusal", kind: "refused" })
      expect((await f.controller.adoptSchedule(step6Intent("W20-second"), true)).status).toBe("failed")
      await turns()
      expect(answer.value).toEqual({ state: "unconfirmed" })
    } finally { await f.controller.dispose() }
  })

  test("W22 associated structural failure unblocks the same compatible gain receipt", async () => {
    const f = setup()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    try {
      await f.controller.start(f.base.transport)
      const polyphony = synth({ ...createDefaultSynthParams(), polyphony: 4 })
      f.set(polyphony)
      const structural = watch(f.controller.deliverProcessor(f.edit(polyphony, 10)).settled)
      acknowledgeStagedPublication(f.fixture)
      f.fixture.bridge.session.revisions.prepare = async () => {
        entered.resolve(); await release.promise
        return { ok: false, error: "typed prepare refusal", kind: "refused" }
      }
      const adoption = f.controller.adoptSchedule(step6Intent("W22"))
      await entered.promise
      const gain = synth({ ...createDefaultSynthParams(), gain: 0.25 })
      f.set(gain)
      const follower = watch(f.controller.deliverProcessor(f.edit(gain, 11)).settled)
      expect([structural.value, follower.value]).toEqual([undefined, undefined])
      release.resolve()
      expect((await adoption).status).toBe("failed"); await turns()
      // A later real event reselects the follower, not an obsolete polyphony reoffer.
      const sends = f.fixture.instrumentPayloads.length
      await f.controller.seekPrepared(0); await turns()
      expect(structural.value).toEqual({ state: "refused", reason: "native-refused" })
      expect(follower.value).toEqual({ state: "applied" })
      expect(f.fixture.instrumentPayloads.length).toBeGreaterThan(sends)
      // The refused Prepare never calls the bridge's graph recorder.
      expect(f.fixture.graphPayloads).toHaveLength(1)
      expect(f.faults.filter(fault => fault.kind === "delivery-refused")).toHaveLength(1)
    } finally { release.resolve(); await f.controller.dispose() }
  })

  test("W29 not-taken terminal does not recompile the active desired schedule", async () => {
    const f = setup(synth(), false, undefined, true)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    try {
      await f.controller.start(f.base.transport)
      acknowledgeStagedPublication(f.fixture)
      const active = step6Intent("W29-active")
      const commands: string[] = []
      const prepare = f.fixture.bridge.session.revisions.prepare
      f.fixture.bridge.session.revisions.prepare = async request => {
        commands.push("prepare")
        entered.resolve(); await release.promise
        return prepare(request)
      }
      const publish = f.fixture.bridge.session.revisions.publish
      f.fixture.bridge.session.revisions.publish = async request => {
        commands.push("publish")
        return publish(request)
      }
      const rollback = f.fixture.bridge.session.revisions.rollback
      f.fixture.bridge.session.revisions.rollback = async request => {
        commands.push("rollback")
        return rollback(request)
      }
      const structural = synth({ ...createDefaultSynthParams(), polyphony: 4 })
      f.set(structural)
      const pending = f.controller.adoptSchedule(step6Intent("W29-structural"))
      await entered.promise
      f.set(synth())
      const compiles = f.compiles()
      const instruments = f.fixture.instrumentPayloads.length
      const patches = f.fixture.statePatchPayloads.length
      f.controller.dropAdoptionIntents()
      let newest: Awaited<ReturnType<TestController["adoptSchedule"]>> | undefined
      void f.controller.adoptSchedule({ ...active, key: "W29-returned-active" }).then(value => { newest = value })
      release.resolve()
      expect(await pending).toEqual({ status: "superseded" })
      await turns()
      expect(newest).toEqual({ status: "unchanged" })
      expect(f.compiles() - compiles).toBeLessThanOrEqual(1)
      // Only the cancelled structural attempt may have prepared or rolled back.
      expect(commands).toEqual(["prepare", "rollback"])
      expect(f.fixture.builtInParameterPayloads).toHaveLength(0)
      expect(f.fixture.instrumentPayloads).toHaveLength(instruments)
      expect(f.fixture.statePatchPayloads).toHaveLength(patches)
      const native = f.fixture.revisionReply("published")
      expect(native.ok && native.revision.activeRevision).toBe(1)
      expect(f.controller.adoptionWitness()).toMatchObject({ running: undefined, waiting: undefined, retained: undefined })
    } finally { release.resolve(); await f.controller.dispose() }
  })

  test("W32 retained live override is not whole-content publication proof", async () => {
    const f = setup()
    try {
      await f.controller.start(f.base.transport)
      const live = synth({ ...createDefaultSynthParams(), gain: 0.25 })
      f.set(live)
      const applied = watch(f.controller.deliverProcessor(f.edit(live, 8)).settled)
      await turns()
      expect(applied.value).toEqual({ state: "applied" })
      const structural = synth({ ...createDefaultSynthParams(), polyphony: 4 })
      f.set(structural)
      f.controller.deliverProcessor(f.edit(structural, 10))
      f.set(synth())
      const follower = watch(f.controller.deliverProcessor(f.edit(synth(), 11)).settled)
      const before = f.fixture.instrumentPayloads.length
      const configured: Uint8Array[] = []
      const configure = f.fixture.bridge.session.configureInstrumentStates
      f.fixture.bridge.session.configureInstrumentStates = async bytes => {
        configured.push(bytes.slice())
        return configure(bytes)
      }
      acknowledgeStagedPublication(f.fixture)
      await f.controller.adoptSchedule(step6Intent("REVIEW6-retained-live"))
      await turns()
      const events = decodeNativeInstrumentEvents(f.fixture.instrumentPayloads.slice(before))
      console.log("STEP6-R1-RETAINED", JSON.stringify({ answer: follower.value, sends: f.fixture.instrumentPayloads.length - before,
        configurations: configured.map(bytes => new DataView(bytes.buffer).getUint32(0, true)),
        events: events.map(event => ({ ...event, nodeId: event.nodeId.toString() })) }))
      expect(configured.map(bytes => new DataView(bytes.buffer).getUint32(0, true))).toEqual([0])
      expect(events.length).toBeGreaterThan(0)
      expect(follower.value).toEqual({ state: "applied" })
    } finally { await f.controller.dispose() }
  })

  test("W33 native prepare-failed is a definite receipt refusal", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      f.set({ kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), densityHz: 7 } })
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 71 }).settled)
      f.fixture.bridge.session.revisions.prepare = async () => {
        const reply = f.fixture.revisionReply("prepare-failed")
        return reply.ok ? { ...reply, revision: { ...reply.revision, requestedRevision: 2, preparedRevision: 0, continuity: "rejected" } } : reply
      }
      const outcome = await f.controller.adoptSchedule(step6Intent("REVIEW6-prepare-failed"))
      await turns()
      console.log("STEP6-R1-PREPARE", JSON.stringify({ outcome, answer: answer.value ?? "unanswered", faults: f.faults }))
      expect(answer.value).toEqual({ state: "refused", reason: "native-refused" })
      expect(f.faults.filter(fault => fault.kind === "delivery-refused")).toHaveLength(1)
    } finally { await f.controller.dispose() }
  })

  test("an adoption refused because a take locks the routing is blocked, not logged as a defect", async () => {
    const f = setup(synth())
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await f.controller.start(f.base.transport)
      f.set(synth({ ...createDefaultSynthParams(), polyphony: 4 }))
      f.fixture.bridge.session.revisions.prepare = async () => {
        const reply = f.fixture.revisionReply("capture-target-locked")
        return reply.ok ? { ...reply, revision: { ...reply.revision, requestedRevision: 2, preparedRevision: 0 } } : reply
      }
      const outcome = await f.controller.adoptSchedule(step6Intent("REVIEW6-capture-locked"))
      expect(outcome.status).toBe("blocked")
      expect(warn.mock.calls.filter(([message]) => String(message).includes("adoption failed"))).toHaveLength(0)
    } finally {
      warn.mockRestore()
      await f.controller.dispose()
    }
  })

  test("W31 transient urgent refusal wakes at the named publication terminal", async () => {
    const f = setup()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    try {
      await f.controller.start(f.base.transport)
      f.set(synth({ ...createDefaultSynthParams(), polyphony: 4 }))
      f.fixture.bridge.session.revisions.prepare = async () => {
        entered.resolve(); await release.promise
        return { ok: false, error: "native refused prepare", kind: "refused" }
      }
      const adoption = f.controller.adoptSchedule(step6Intent("REVIEW6-transient"))
      await entered.promise
      let sends = 0
      const queue = f.fixture.bridge.session.queueInstrumentEvents
      f.fixture.bridge.session.queueInstrumentEvents = async bytes => {
        sends++
        return sends === 1 ? { ok: false, kind: "refused", error: "prepared bank outstanding" } : queue(bytes)
      }
      const gain = synth({ ...createDefaultSynthParams(), gain: 0.25 })
      f.set(gain)
      const answer = watch(f.controller.deliverProcessor(f.edit(gain, 11)).settled)
      await turns()
      expect(sends).toBe(1)
      release.resolve()
      await adoption; await turns()
      console.log("STEP6-R1-TRANSIENT", JSON.stringify({ sends, answer: answer.value ?? "unanswered", witness: f.controller.adoptionWitness() }))
      expect(sends).toBe(2)
      expect(answer.value).toEqual({ state: "applied" })
    } finally { release.resolve(); await f.controller.dispose() }
  })

  test("W34 typed refused Publish ends the receipt policy", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 72 }).settled)
      acknowledgeStagedPublication(f.fixture)
      let publishes = 0, inspections = 0, rollbacks = 0
      let preparedRevision: number | undefined
      const inspected = Promise.withResolvers<void>()
      const prepare = f.fixture.bridge.session.revisions.prepare
      const inspect = f.fixture.bridge.session.revisions.inspect
      const rollback = f.fixture.bridge.session.revisions.rollback
      f.fixture.bridge.session.revisions.prepare = async request => {
        const reply = await prepare(request)
        if (reply.ok) preparedRevision = reply.revision.requestedRevision
        return reply
      }
      f.fixture.bridge.session.revisions.inspect = async request => {
        const reply = await inspect(request)
        inspections++
        inspected.resolve()
        return reply
      }
      f.fixture.bridge.session.revisions.rollback = async request => {
        rollbacks++
        const reply = await rollback(request)
        if (reply.ok && reply.revision.status === "rolled-back") preparedRevision = undefined
        return reply
      }
      f.fixture.bridge.session.revisions.publish = async () => {
        publishes++
        return { ok: false, error: "native rejected publish", kind: "refused" }
      }
      let outcome: Awaited<ReturnType<TestController["adoptSchedule"]>> | undefined
      void f.controller.adoptSchedule(step6Intent("REVIEW6-publish-refused")).then(value => { outcome = value })
      await inspected.promise
      await turns()
      console.log("STEP6-R1-PUBLISH", JSON.stringify({ publishes, inspections, rollbacks, outcome: outcome ?? "unanswered", answer: answer.value ?? "unanswered" }))
      expect(outcome).toMatchObject({ status: "failed" })
      expect(answer.value).toEqual({ state: "refused", reason: "native-refused" })
      expect(rollbacks).toBe(1)
      expect(preparedRevision).toBeUndefined()
      expect(f.controller.liveScheduleCandidates()).toBe(0)
      expect(f.controller.adoptionWitness()).toMatchObject({ running: undefined, retained: undefined })
    } finally { await f.controller.dispose() }
  })

  test("W35 loss during staged priming sends no Inspect after the fence", async () => {
    const f = setup()
    try {
      let lost = false, inspectionsAfterLoss = 0, stagedWindows = 0
      const schedule = f.fixture.bridge.session.queueScheduleWindow
      const inspect = f.fixture.bridge.session.revisions.inspect
      f.fixture.bridge.session.revisions.inspect = async request => {
        if (lost) inspectionsAfterLoss++
        return inspect(request)
      }
      f.fixture.bridge.session.queueScheduleWindow = async bytes => {
        const revision = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(60, true)
        console.log("STEP6-R1-WINDOW", revision)
        if (revision === 2) {
          stagedWindows++
          lost = true
          f.fixture.emitLoss("host lost while staged prime command was in flight")
          throw new Error("schedule reply lost with host")
        }
        return schedule(bytes)
      }
      await f.controller.start(f.base.transport)
      acknowledgeStagedPublication(f.fixture)
      const adoptedInspect = f.fixture.bridge.session.revisions.inspect
      f.fixture.bridge.session.revisions.inspect = async request => {
        if (lost) inspectionsAfterLoss++
        return adoptedInspect(request)
      }
      const outcome = await f.controller.adoptSchedule(step6Intent("REVIEW6-prime-loss"))
      await turns()
      console.log("STEP6-R1-PRIME-LOSS", JSON.stringify({ stagedWindows, inspectionsAfterLoss, outcome }))
      expect(stagedWindows).toBe(1)
      expect(inspectionsAfterLoss).toBe(0)
    } finally { await f.controller.dispose() }
  })
  for (const projected of [false, true]) test(`W36 key-only synth join recovers retained override projected=${projected}`, async () => {
    const f = setup(synth(), projected)
    try {
      await f.controller.start(f.base.transport)
      const live = synth({ ...createDefaultSynthParams(), gain: 0.25 })
      f.set(live)
      const first = watch(f.controller.deliverProcessor(f.edit(live, 8)).settled)
      await turns()
      expect(first.value).toEqual({ state: "applied" })
      f.set(synth())
      const joined = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "synth:1" },
        contentKey: await f.key(), lifetime: 81 }).settled)
      const before = f.fixture.instrumentPayloads.length
      acknowledgeStagedPublication(f.fixture)
      const outcome = await f.controller.adoptSchedule(step6Intent("rereview-key-only"))
      await turns()
      console.log("REREVIEW6-KEY-ONLY", JSON.stringify({ projected, outcome, sends: f.fixture.instrumentPayloads.length - before,
        answer: joined.value ?? "unanswered" }))
      expect(joined.value).toEqual({ state: "applied" })
      expect(f.fixture.instrumentPayloads.length - before).toBe(1)
    } finally { await f.controller.dispose() }
  })

  test("W37 positive publish-failed survives a lost Inspect", async () => {
    const lostInspect = true
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 82 }).settled)
      acknowledgeStagedPublication(f.fixture)
      let rollbacks = 0, publishes = 0
      const rollback = f.fixture.bridge.session.revisions.rollback
      const inspect = f.fixture.bridge.session.revisions.inspect
      let inspections = 0
      f.fixture.bridge.session.revisions.inspect = async request => {
        inspections++
        if (lostInspect && inspections === 1) return { ok: false, kind: "unconfirmed", error: "first inspect reply lost" }
        return inspect(request)
      }
      f.fixture.bridge.session.revisions.rollback = async request => { rollbacks++; return rollback(request) }
      f.fixture.bridge.session.revisions.publish = async () => {
        publishes++
        const reply = f.fixture.revisionReply("publish-failed")
        return reply.ok ? { ...reply, revision: { ...reply.revision, requestedRevision: 2, activeRevision: 1,
          preparedRevision: 2, transportEpoch: 1 } } : reply
      }
      const outcome = await f.controller.adoptSchedule(step6Intent("rereview-positive-failed"))
      await turns()
      console.log("REREVIEW6-POSITIVE-FAILED", JSON.stringify({ lostInspect, outcome, answer: answer.value, rollbacks, publishes, inspections }))
      expect(outcome.status).toBe("failed")
      expect(answer.value).toEqual({ state: "refused", reason: "apply-failed" })
      expect(rollbacks).toBe(1)
      expect(publishes).toBe(1)
    } finally { await f.controller.dispose() }
  })

  test("W38 rebase invalid-revision keeps its typed terminal", async () => {
      const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
      try {
        await f.controller.start(f.base.transport)
        const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
          contentKey: await f.key(), lifetime: 84 }).settled)
        acknowledgeStagedPublication(f.fixture)
        const entered = Promise.withResolvers<void>()
        let status: NativeGraphRevisionStatus["status"] = "prepared"
        let publishes = 0, rollbacks = 0
        let seam = 0n
        const prepare = f.fixture.bridge.session.revisions.prepare
        const rollback = f.fixture.bridge.session.revisions.rollback
        const reply = (): NativeRevisionReply => ({ ok: true, hostPid: 123, hostGeneration: 7,
          revision: { status, continuity: "accepted", requestedRevision: 2, activeRevision: 1, preparedRevision: 2,
            retiredRevision: 0, renderEpoch: 1n, transportEpoch: 1, publicationFrame: 0n, progressFrame: seam + 128n } })
        f.fixture.bridge.session.revisions.prepare = async request => {
          seam = request.requestedPublicationFrame ?? 0n
          return prepare(request)
        }
        f.fixture.bridge.session.revisions.publish = async request => {
          publishes++
          if (publishes === 1) { status = "rebase-required"; entered.resolve(); return reply() }
          const frameAtInspect = seam + 128n
          const frameAtPublish = frameAtInspect + 128n
          const requested = request.requestedPublicationFrame ?? 0n
          expect(requested).toBeGreaterThan(frameAtPublish)
          expect((requested - frameAtPublish) % 512n).not.toBe(0n)
          console.log("REREVIEW6-NATIVE-INVALID", JSON.stringify({ requested: requested.toString(),
            frameAtInspect: frameAtInspect.toString(), frameAtPublish: frameAtPublish.toString(),
            remainder: ((requested - frameAtPublish) % 512n).toString() }))
          status = "invalid-revision"
          const failed = reply()
          // Native rejects before changing its original seam; Inspect still reports rebase-required.
          status = "rebase-required"
          return failed
        }
        f.fixture.bridge.session.revisions.inspect = async () => {
          return reply()
        }
        f.fixture.bridge.session.revisions.rollback = async request => {
          rollbacks++
          return rollback(request)
        }
        const adoption = f.controller.adoptSchedule(step6Intent("W38-rebase-invalid"))
        await entered.promise
        await turns()
        expect(publishes).toBe(1)
        f.fixture.emitScheduleProgress({ revision: 1, epoch: 1, progressSequence: 999n,
          renderedThroughFrame: 128n, acceptedThroughFrame: 96000n, lastAcceptedWindowId: 1n,
          appliedTransportTransitionId: 1n, appliedUrgentSequence: 0n, appliedProcessorSequence: 0n,
          running: true, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256 })
        const outcome = await adoption
        await turns()
        expect(outcome.status).toBe("failed")
        expect(answer.value).toEqual({ state: "refused", reason: "invalid" })
        expect(rollbacks).toBe(1)
        expect(publishes).toBe(2)
        expect(f.controller.adoptionWitness().running).toBeUndefined()
      } finally { await f.controller.dispose() }
    })

  for (const terminal of ["proven", "cancelled"]) test(`W39 deferred key-only recovery wakes after carrier ${terminal}`, async () => {
    const f = setup(synth(), false)
    const release = Promise.withResolvers<Awaited<ReturnType<typeof f.fixture.bridge.session.queueInstrumentEvents>>>()
    try {
      await f.controller.start(f.base.transport)
      const old = synth({ ...createDefaultSynthParams(), gain: 0.25 })
      f.set(old)
      expect(await f.controller.deliverProcessor(f.edit(old, 8)).settled).toEqual({ state: "applied" })
      const queue = f.fixture.bridge.session.queueInstrumentEvents
      let held: Uint8Array | undefined
      let sends = 0
      f.fixture.bridge.session.queueInstrumentEvents = async bytes => {
        sends++
        if (sends !== 1) return queue(bytes)
        held = bytes
        return terminal === "proven" ? { ok: true } : release.promise
      }
      const pending = synth({ ...createDefaultSynthParams(), gain: 0.5 })
      f.set(pending)
      const carrier = watch(f.controller.deliverProcessor(f.edit(pending, 9)).settled)
      await turns()
      expect(held).toBeDefined()
      f.set(synth())
      const receipt = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "synth:1" },
        contentKey: await f.key(), lifetime: 121 }).settled)
      acknowledgeStagedPublication(f.fixture)
      expect(await f.controller.adoptSchedule(step6Intent("W39-" + terminal))).toEqual({ status: "adopted" })
      await turns()
      expect(receipt.value).toBeUndefined()
      expect(sends).toBe(1)
      if (!held) throw new Error("Missing held batch")
      if (terminal === "proven") await queue(held)
      else release.resolve({ ok: false, kind: "unavailable", error: "carrier was not delivered" })
      await turns()
      console.log("STEP6-R3-DEFERRED", JSON.stringify({ terminal, sends, carrier: carrier.value, receipt: receipt.value ?? "unanswered" }))
      expect(carrier.value).toEqual(terminal === "proven" ? { state: "applied" } : { state: "unavailable" })
      expect(sends).toBe(2)
      expect(receipt.value).toEqual({ state: "applied" })
    } finally {
      release.resolve({ ok: false, kind: "unavailable", error: "finish W39" })
      await f.controller.dispose()
    }
  })

  for (const proof of ["rebase-required", "published"] satisfies NativeGraphRevisionStatus["status"][])
    test(`W40 typed refused Publish reconciles before rebase wait, Inspect ${proof}`, async () => {
      const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
      let adoption: ReturnType<TestController["adoptSchedule"]> | undefined
      try {
        await f.controller.start(f.base.transport)
        const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
          contentKey: await f.key(), lifetime: 128 }).settled)
        acknowledgeStagedPublication(f.fixture)
        let publishes = 0, rollbacks = 0
        const rollback = f.fixture.bridge.session.revisions.rollback
        const publish = f.fixture.bridge.session.revisions.publish
        if (proof === "rebase-required") f.fixture.bridge.session.revisions.inspect = async () => {
          const reply = f.fixture.revisionReply("rebase-required")
          return reply.ok ? { ...reply, revision: { ...reply.revision, requestedRevision: 2, activeRevision: 1,
            preparedRevision: 2, transportEpoch: 1, progressFrame: 8320n } } : reply
        }
        f.fixture.bridge.session.revisions.publish = async request => {
          publishes++
          if (proof === "published") await publish(request)
          return { ok: false, kind: "refused", error: "typed publish refused" }
        }
        f.fixture.bridge.session.revisions.rollback = async request => { rollbacks++; return rollback(request) }
        let outcome: Awaited<ReturnType<TestController["adoptSchedule"]>> | undefined
        adoption = f.controller.adoptSchedule(step6Intent("W40-" + proof))
        void adoption.then(value => { outcome = value })
        await turns()
        console.log("STEP6-R3-DEFINITE", JSON.stringify({ proof, outcome: outcome ?? "unanswered",
          answer: answer.value ?? "unanswered", publishes, rollbacks, witness: f.controller.adoptionWitness() }))
        expect(outcome?.status).toBe(proof === "published" ? "adopted" : "failed")
        expect(answer.value).toEqual(proof === "published" ? { state: "applied" } : { state: "refused", reason: "native-refused" })
        expect(publishes).toBe(1)
        expect(rollbacks).toBe(proof === "published" ? 0 : 1)
        expect(f.controller.liveScheduleCandidates()).toBe(0)
        expect(f.controller.adoptionWitness()).toMatchObject({ running: undefined, retained: undefined })
      } finally {
        f.fixture.emitLoss("finish W40")
        if (adoption) await adoption
        await f.controller.dispose()
      }
    })

  for (const proof of ["stale-revision", "published"] satisfies NativeGraphRevisionStatus["status"][])
    test(`W56 typed refused Publish reconciles before rebase wait, Inspect ${proof}`, async () => {
      const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
      let adoption: ReturnType<TestController["adoptSchedule"]> | undefined
      try {
        await f.controller.start(f.base.transport)
        const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
          contentKey: await f.key(), lifetime: 128 }).settled)
        acknowledgeStagedPublication(f.fixture)
        let publishes = 0, rollbacks = 0, inspections = 0
        const inspect = f.fixture.bridge.session.revisions.inspect
        f.fixture.bridge.session.revisions.inspect = async request => {
          if (publishes === 0) return inspect(request)
          inspections++
          if (inspections > 1) return { ok: false, kind: "unconfirmed", error: "later Inspect lost" }
          if (proof === "published") return inspect(request)
          const reply = f.fixture.revisionReply("stale-revision")
          return reply.ok ? { ...reply, revision: { ...reply.revision, requestedRevision: 2, activeRevision: 1,
            preparedRevision: 0, transportEpoch: 1 } } : reply
        }
        const rollback = f.fixture.bridge.session.revisions.rollback
        const publish = f.fixture.bridge.session.revisions.publish
        f.fixture.bridge.session.revisions.publish = async request => {
          publishes++
          if (proof === "published") await publish(request)
          return { ok: false, kind: "refused", error: "typed publish refused" }
        }
        f.fixture.bridge.session.revisions.rollback = async request => { rollbacks++; return rollback(request) }
        let outcome: Awaited<ReturnType<TestController["adoptSchedule"]>> | undefined
        adoption = f.controller.adoptSchedule(step6Intent("W56-" + proof))
        void adoption.then(value => { outcome = value })
        await turns()
        step7Evidence("W56-first-proof", { proof, outcome: outcome ?? "unanswered",
          answer: answer.value ?? "unanswered", publishes, rollbacks, inspections, witness: f.controller.adoptionWitness() })
        expect(outcome?.status).toBe(proof === "published" ? "adopted" : "failed")
        expect(answer.value).toEqual(proof === "published" ? { state: "applied" } : { state: "refused", reason: "native-refused" })
        expect(publishes).toBe(1)
        expect(inspections).toBe(proof === "published" ? 1 : 2)
        expect(rollbacks).toBe(proof === "published" ? 0 : 1)
        expect(f.controller.liveScheduleCandidates()).toBe(0)
        expect(f.controller.adoptionWitness()).toMatchObject({ running: undefined, retained: undefined })
      } finally {
        f.fixture.emitLoss("finish W56")
        if (adoption) await adoption
        await f.controller.dispose()
      }
    })

  for (const guard of ["matching", "future-lifetime", "different-content", "foreign-node", "incarnation"]) {
    test(`W50 absolute publication proves content, not its floor: ${guard}`, async () => {
      const sampled: TrackInstrumentParams = { kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() }
      const f = setup(guard === "incarnation" ? synth() : sampled)
      const gate = Promise.withResolvers<void>()
      try {
        await f.controller.start(f.base.transport)
        const edited = synth({ ...createDefaultSynthParams(), polyphony: 4 })
        if (guard === "incarnation") f.set(edited)
        const key = await f.key()
        const first = guard === "incarnation" ? watch(f.controller.deliverProcessor(f.edit(edited, 10)).settled)
          : watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
            contentKey: key, lifetime: 51 }).settled)
        acknowledgeStagedPublication(f.fixture)
        const prepare = f.fixture.bridge.session.revisions.prepare
        let captured = false
        f.fixture.bridge.session.revisions.prepare = async request => {
          captured = true
          await gate.promise
          return prepare(request)
        }
        const adoption = f.controller.adoptSchedule(step6Intent("W50-" + guard))
        await turns()
        expect(captured).toBe(true)
        if (guard === "different-content") f.set({ ...sampled, params: { ...createDefaultGranularParams(), densityHz: 7 } })
        if (guard === "incarnation") f.nextIncarnation()
        const next = guard === "incarnation" ? watch(f.controller.deliverProcessor(f.edit(edited, 11)).settled)
          : watch(f.controller.joinPublication({
            target: { nodeId: guard === "foreign-node" ? "foreign" : "instrument", instanceId: "sampled" },
            contentKey: await f.key(), lifetime: guard === "future-lifetime" ? 52 : 51,
          }).settled)
        gate.resolve()
        expect(await adoption).toEqual({ status: "adopted" })
        await turns()
        step7Evidence(`W50-${guard}`, { first, next })
        expect(next.value).toEqual(guard === "matching" ? { state: "applied" } : undefined)
        if (guard !== "incarnation") expect(first.value).toEqual({ state: "applied" })
      } finally { gate.resolve(); await f.controller.dispose() }
    })
  }

  test("W30 follower recovery never sends content older than newest desired", () => {
    const owner = createNativeProcessorStateOwner()
    const installed = compilePortableSynthState(createDefaultSynthParams())
    const structural = compilePortableSynthState({ ...createDefaultSynthParams(), polyphony: 4 })
    const stale = synth({ ...createDefaultSynthParams(), gain: 0.25 })
    const newest = compilePortableSynthState({ ...createDefaultSynthParams(), gain: 0.75 })
    owner.configured(1, new Map([["synth:1", { kindId: 18, incarnation: 1, instrument: installed,
      values: liveValues(installed), contentKey: nativeInstrumentContentKey(installed) }]]))
    const fields = { host: "host", epoch: 1, structural: 1, capacity: 0, settled: 0 }
    owner.deliver({ key: "synth:1", editId: "structural", order: 10, kindId: 18, incarnation: 1,
      epoch: 1, instrument: structural, preparedInstrument: true, values: liveValues(structural) })
    const submitted = owner.submitAdoption(step6Intent("W30"), false, fields)
    if (!submitted.start) throw new Error("W30 requires an admitted structural attempt")
    const record = owner.capturePublication(submitted.start.attempt, new Map([["synth:1", {
      nodeId: "instrument", kindId: 18, incarnation: 1, instrument: structural,
      values: liveValues(structural), contentKey: nativeInstrumentContentKey(structural),
    }]]))
    const follower = owner.deliver({ key: "synth:1", editId: "follower", order: 11, kindId: 18, incarnation: 1,
      epoch: 1, instrument: compilePortableSynthState(stale.params), preparedInstrument: true,
      values: liveValues(compilePortableSynthState(stale.params)), edit: {
        id: "follower", order: 11, target: { nodeId: "instrument", instanceId: "synth:1", kindId: 18, incarnation: 1 },
        content: { params: stale },
      } })
    owner.submit({ id: "newest-projection", order: 12,
      target: { nodeId: "instrument", instanceId: "synth:1", kindId: 18, incarnation: 1 },
      content: { state: new Uint8Array(), instrument: { state: newest, incarnation: 1 }, values: liveValues(newest) },
      bypassed: false, tailFrames: 0 })
    owner.finishPublication(record, { status: "failed", reason: "typed refusal" }, "failed")
    const recovery = owner.reoffer()
    expect(recovery).toHaveLength(1)
    expect(recovery.flatMap(item => "resend" in item ? [...item.resend.values] : [])).toEqual(Object.entries(liveValues(newest)))
    expect(follower.receipt.answered).toBeUndefined()
  })

  test("W22 late old proof cannot clear a newer desired incident", () => {
    const notices: string[] = []
    const owner = createNativeProcessorStateOwner({ reportIncident: category => { notices.push(category) } })
    const old = compilePortableSynthState(createDefaultSynthParams())
    const next = compilePortableSynthState({ ...createDefaultSynthParams(), gain: 0.25 })
    owner.configured(1, new Map([["synth", { kindId: 18, incarnation: 1, instrument: old,
      values: liveValues(old), contentKey: nativeInstrumentContentKey(old) }]]))
    const fail = (order: number) => {
      const delivery = owner.deliver({ key: "synth", editId: `incident-${order}`, order, kindId: 18, incarnation: 1,
        epoch: 1, instrument: next, preparedInstrument: true, values: liveValues(next) })
      const execution = owner.register({ key: "synth", editId: `incident-${order}`, order, kindId: 18, sequence: order,
        strategy: { kind: "urgent", sequence: order }, values: new Map(Object.entries(liveValues(next))),
        receipts: [delivery.receipt] }, { revision: 1, epoch: 1 })
      owner.send(execution, order, order)
      expect(owner.refuse(execution, "definite")).toBe("retry")
      owner.rebind(execution, { revision: 1, epoch: 1 }, order + 100)
      owner.send(execution, order + 100, order + 100)
      owner.refuse(execution, "definite")
      expect(delivery.receipt.answered?.state).toBe("refused")
    }
    fail(10)
    owner.adopted(new Map([["synth", 18]]), new Set(), new Set(), 1, () => false,
      new Map([["synth", { kindId: 18, incarnation: 1, instrument: old, values: liveValues(old),
        contentKey: nativeInstrumentContentKey(old) }]]))
    fail(11)
    expect(notices).toEqual(["refused"])
  })

  test("W23 loss answers receipt unavailable while lifecycle is superseded", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    try {
      await f.controller.start(f.base.transport)
      const answer = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
        contentKey: await f.key(), lifetime: 45 }).settled)
      acknowledgeStagedPublication(f.fixture)
      f.fixture.bridge.session.revisions.publish = async () => {
        f.fixture.emitLoss("W23 loss")
        return { ok: false, error: "session ended", kind: "unavailable" }
      }
      expect(await f.controller.adoptSchedule(step6Intent("W23"))).toEqual({ status: "superseded" })
      await turns()
      expect(answer.value).toEqual({ state: "unavailable" })
    } finally { await f.controller.dispose() }
  })

  test("sampled-superseded-content", async () => {
    const f = setup({ kind: "granular", instanceId: "sampled", params: createDefaultGranularParams() })
    await f.controller.start(f.base.transport)
    const old = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
      contentKey: await f.key(), lifetime: 1 }).settled)
    f.set({ kind: "granular", instanceId: "sampled", params: { ...createDefaultGranularParams(), densityHz: 7 } })
    const next = watch(f.controller.joinPublication({ target: { nodeId: "instrument", instanceId: "sampled" },
      contentKey: await f.key(), lifetime: 2 }).settled)
    await f.publish()
    await turns()
    expect(old.value).toEqual({ state: "unavailable" })
    expect(next.value?.state).toBe("applied")
    await f.controller.dispose()
  })
  const panelProjection = (instrument: TrackInstrumentParams) => ({
    replaceAudioEffectTargets: [], upsertDeviceRows: [{ targetId: "instrument", effect: "instrument", params: instrument }],
    clearInstrumentTargets: [],
  } satisfies NonNullable<Parameters<typeof compileDesiredNativeProcessorState>[3]>)
  const snapshotOf = (base: LivePlaybackSnapshotInput) => {
    const result = compileLivePlaybackSnapshot(base)
    if (!result.supported) throw new Error(result.reasons.join("; "))
    return result.snapshot
  }
  test("r3 equal-order mismatching synth adoption stays unanswered", () => {
    const owner = createNativeProcessorStateOwner()
    const installed = compilePortableSynthState({ ...createDefaultSynthParams(), polyphony: 4 })
    const requested = compilePortableSynthState({ ...createDefaultSynthParams(), polyphony: 8 })
    const content = new Map([["synth", { kindId: 18, incarnation: 1, instrument: installed,
      contentKey: nativeInstrumentContentKey(installed), values: liveValues(installed) }]])
    owner.configured(1, content)
    const delivery = owner.deliver({ key: "synth", editId: "order-11", order: 11, kindId: 18, incarnation: 1,
      epoch: 1, instrument: requested, preparedInstrument: true, values: liveValues(requested) })
    owner.adopted(new Map([["synth", 18]]), new Set(), new Set(), 11, () => false, content)
    expect(delivery.receipt.answered).toBeUndefined()
  })
  test("r3 incarnation guard keeps raised-floor request unanswered", async () => {
    const fixture = createBridge()
    const base = nativeInstrumentInput()
    let instrument = synth()
    let order = 1
    let incarnation = 1
    const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
      getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, order, panelProjection(instrument)),
      getProcessorTarget: () => ({ kindId: 18, incarnation, latest: { id: `edit-${order}`, order,
        target: { nodeId: "instrument", instanceId: instrument.instanceId, kindId: 18, incarnation }, content: { params: instrument } } }),
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport, processorStateSequence: order,
        renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { instrument: { instances: [], instrument } } } } }) })
    expect(await controller.start(base.transport)).toBe("started")
    instrument = synth({ ...instrument.params, polyphony: 4 }); order = 10
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-4")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

    instrument = synth({ ...instrument.params, polyphony: 8 }); order = 11; incarnation = 2
    const answer = watch(controller.deliverProcessor({ id: "edit-11", order, target: {
      nodeId: "instrument", instanceId: instrument.instanceId, kindId: 18, incarnation }, content: { params: instrument } }).settled)
    let sentCapturedInstrument = false
    const configure = fixture.bridge.session.configureInstrumentStates
    fixture.bridge.session.configureInstrumentStates = async bytes => {
      const expected = serializeNativeInstrumentStates([{ nodeId: "instrument",
        state: compilePortableSynthState({ ...instrument.params, polyphony: 4 }) }], [])
      sentCapturedInstrument = Buffer.from(bytes).equals(Buffer.from(expected))
      return configure(bytes)
    }
    acknowledgeStagedPublication(fixture)
    expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
    await turns()
    const result = answer.value
    await controller.dispose()
    expect(sentCapturedInstrument).toBe(true)
    expect(result).toBeUndefined()
  })
  for (const change of ["sample", "region"]) test(`r3 retained buffer rejects changed ${change}`, () => {
    const base = sampledNativeInput("sampler", 0.1)
    const entry = base.renderState.fx.trackFx?.instrument
    if (entry?.instrument?.kind !== "sampler") throw new Error("Missing sampler")
    const raw = entry.instrument
    const zone = raw.params.zones[0]!
    const retained = entry.samplerBuffers?.get(zone.id)
    if (!retained) throw new Error("Missing retained buffer")
    const sourceIdentity = sampledInstrumentRegionIdentity(zone.sample, { sourceStartFrame: 0, sourceEndFrame: 4800 })
    entry.samplerBuffers = new Map([[zone.id, { ...retained, sourceIdentity }]])
    const snapshot = snapshotOf({ ...base, tracks: [...base.tracks, { ...base.tracks[0]!, id: "other", clips: [] }],
      renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { instrument: entry, other: entry } } } })
    const instrument: TrackInstrumentParams = { ...raw, params: { ...raw.params, zones: [{
      ...zone, ...(change === "sample"
        ? { sample: { ...zone.sample, assetKey: "replacement", url: "/replacement.wav" } }
        : { startSec: 0.02, endSec: 0.08 }),
    }] } }
    const desired = compileDesiredNativeProcessorState(snapshot, 48000, 20, panelProjection(instrument))
    const sentBoundary = compileLivePlaybackSnapshot({ ...base, renderState: { ...base.renderState,
      fx: { ...base.renderState.fx, trackFx: { instrument: { ...entry, instrument } } } } })
    expect(sentBoundary.supported).toBe(false)
    if (sentBoundary.supported) throw new Error("Expected stale buffer rejection")
    expect(desired.instruments.has("instrument")).toBe(false)
    expect(desired.instrumentReasons).toEqual(sentBoundary.reasons.map(reason => `instrument: ${reason}`))
    expect(desired.instruments.get("other")).toEqual(compileDesiredNativeProcessorState(snapshot, 48000, 20).instruments.get("other"))
    expect(desired.instruments.get("other")?.kind).toBe("sampled")
  })
  for (const kind of ["sampler", "granular", "drum-rack"] satisfies readonly ("sampler" | "granular" | "drum-rack")[]) {
    test(`r3 known unavailable ${kind} keeps matching desired content`, async () => {
      const base = sampledNativeInput(kind, 0.1)
      const entry = base.renderState.fx.trackFx?.instrument
      if (!entry?.instrument) throw new Error("Missing instrument")
      entry.unavailableSampleAssetKeys = ["missing"]
      const instrument = entry.instrument
      if (instrument.kind === "sampler") {
        const zone = instrument.params.zones[0]!
        instrument.params.zones = [...instrument.params.zones,
          { ...zone, id: "missing-zone", sample: { ...zone.sample, assetKey: "missing", url: "/missing.wav" } }]
      } else if (instrument.kind === "drum-rack") {
        const pad = instrument.params.pads[0]!
        if (!pad.sample) throw new Error("Missing pad sample")
        instrument.params.pads.push({ ...pad, id: "missing-pad", note: 38, sample: { ...pad.sample, assetKey: "missing", url: "/missing.wav" } })
      } else if (instrument.kind === "granular" && instrument.params.zone) {
        instrument.params.zone.sample = { ...instrument.params.zone.sample, assetKey: "missing", url: "/missing.wav" }
        entry.granularBuffer = undefined
      }
      const snapshot = snapshotOf(base)
      const sent = compileLiveNativeProjection({ tracks: snapshot.tracks, fx: snapshot.mixer.fx, bpm: snapshot.bpm,
        sampleRateHz: 48000, revision: 1, epoch: 1, firstSequence: 1 })
      if (!sent.supported) throw new Error(sent.reasons.join("; "))
      const installed = sent.graph.nodes.find(node => node.id === "instrument")?.instrument
      if (!installed) throw new Error("Missing sent instrument")
      const desired = compileDesiredNativeProcessorState(snapshot, 48000, 20)
      const state = desired.instruments.get("instrument")
      expect(state?.kind === "sampled" ? state.contentKey : undefined).toBe(nativeInstrumentContentKey(installed))
      expect(desired.instrumentReasons).toEqual([])
      const fixture = createBridge()
      const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
        getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 20),
        compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport }) })
      expect(await controller.start(base.transport)).toBe("started")
      const answer = watch(controller.joinPublication({ target: { nodeId: "instrument", instanceId: instrument.instanceId },
        contentKey: nativeInstrumentContentKey(installed), lifetime: 987 }).settled)
      const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-5")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

      acknowledgeStagedPublication(fixture)
      expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
      await turns()
      expect(answer.value).toEqual({ state: "applied" })
      await controller.dispose()
    })
  }
  for (const kind of ["sampler", "granular", "drum-rack"] satisfies readonly ("sampler" | "granular" | "drum-rack")[]) {
    for (const trimmed of [false, true]) test(`r2 desired-sent ${trimmed ? "trimmed" : "loaded"} ${kind}`, async () => {
      const base = sampledNativeInput(kind, trimmed ? 1 : 0.1)
      const entry = base.renderState.fx.trackFx?.instrument
      if (!entry?.instrument) throw new Error("Missing instrument fixture")
      const buffer = new TestAudioBuffer([new Float32Array(24000), new Float32Array(24000)])
      const instrument = entry.instrument
      if (trimmed && instrument.kind === "sampler") {
        instrument.params.zones = instrument.params.zones.map(zone => ({ ...zone, startSec: 0.25, endSec: 0.75 }))
        entry.samplerBuffers = new Map([["zone", { buffer, sourceStartFrame: 12000 }]])
      } else if (trimmed && instrument.kind === "drum-rack") {
        instrument.params.pads = instrument.params.pads.map(pad => ({ ...pad, startSec: 0.25, endSec: 0.75 }))
        entry.drumRackBuffers = new Map([[instrument.params.pads[0]!.id, { buffer, sourceStartFrame: 12000 }]])
      } else if (trimmed && instrument.kind === "granular" && instrument.params.zone) {
        instrument.params.zone = { ...instrument.params.zone, startSec: 0.25, endSec: 0.75 }
        entry.granularBuffer = { buffer, sourceStartFrame: 12000, assetKey: sampledInstrumentRegionIdentity(
          instrument.params.zone.sample, { sourceStartFrame: 12000, sourceEndFrame: 36000 }) }
      }
      const snapshot = snapshotOf(base)
      const desired = compileDesiredNativeProcessorState(snapshot, 48000, 20, panelProjection(instrument))
      const state = desired.instruments.get("instrument")
      const sent = compileLiveNativeProjection({ tracks: snapshot.tracks, fx: snapshot.mixer.fx,
        bpm: snapshot.bpm, sampleRateHz: 48000, revision: 1, epoch: 1, firstSequence: 1 })
      if (!sent.supported) throw new Error(sent.reasons.join("; "))
      const installed = sent.graph.nodes.find(node => node.id === "instrument")?.instrument
      expect(state?.kind).toBe("sampled")
      if (state?.kind !== "sampled" || !installed) throw new Error("Missing desired/sent sampled configuration")
      expect(state.contentKey).toBe(nativeInstrumentContentKey(installed))
      // No panel overlay must retain the already-localized snapshot, not localize it twice.
      expect(compileDesiredNativeProcessorState(snapshot, 48000, 20).instruments.get("instrument")).toEqual(state)
      const fixture = createBridge()
      const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
        getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 20, panelProjection(instrument)),
        compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport }) })
      expect(await controller.start(base.transport)).toBe("started")
      const answer = watch(controller.joinPublication({ target: { nodeId: "instrument", instanceId: instrument.instanceId },
        contentKey: state.contentKey, lifetime: 456 }).settled)
      const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-6")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

      acknowledgeStagedPublication(fixture)
      expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
      await turns()
      expect(answer.value).toEqual({ state: "applied" })
      await controller.dispose()
    })
  }
  test("r2 Stretch elsewhere keeps sampled entries", () => {
    const base = sampledNativeInput("sampler", 0.1)
    const audio = sourceTrack()
    audio.clips[0]!.audioWarp = { enabled: true, mode: "stretch", sourceBpm: 120 }
    const snapshot = snapshotOf({ ...base, tracks: [...base.tracks, audio] })
    const desired = compileDesiredNativeProcessorState(snapshot, 48000, 20).instruments.get("instrument")
    expect(desired?.kind).toBe("sampled")
    const asset: AudioAssetRef = { version: audioCoreContractVersion, assetId: "prepared:stretch", frameCount: 1, sampleRateHz: 48000, channelCount: 2 }
    const planes = [new Float32Array(1), new Float32Array(1)]
    const sent = compileLiveNativeProjection({ tracks: snapshot.tracks, fx: snapshot.mixer.fx, bpm: snapshot.bpm,
      sampleRateHz: 48000, revision: 1, epoch: 1, firstSequence: 1, preparedStretchAssets: [{
        clipId: "clip", projectGeneration: 1, sourceAssetKey: "source", sourceDurationSec: 1 / 48000,
        timelineStartSec: 0, timelineDurationSec: 1 / 48000, sourceStartSec: 0,
        projectAssetId: asset.assetId, portableAssetId: asset.assetId, asset,
        pcm: { frameCount: 1, planes }, transferables: planes.map(plane => plane.buffer),
      }] })
    if (!sent.supported) throw new Error(sent.reasons.join("; "))
    const installed = sent.graph.nodes.find(node => node.id === "instrument")?.instrument
    if (!installed || desired?.kind !== "sampled") throw new Error("Missing sampled content")
    expect(desired.contentKey).toBe(nativeInstrumentContentKey(installed))
  })
  test("r2 unlocalizable node drops only itself with reason", () => {
    const base = sampledNativeInput("sampler", 0.1)
    const instrument = base.renderState.fx.trackFx?.instrument?.instrument
    if (!instrument || instrument.kind !== "sampler") throw new Error("Missing sampler")
    const snapshot = snapshotOf(base)
    const bad: TrackInstrumentParams = { ...instrument, instanceId: "missing", params: {
      ...instrument.params, zones: instrument.params.zones.map(zone => ({ ...zone, id: "unloaded" })) } }
    const result = compileDesiredNativeProcessorState(snapshot, 48000, 20, { replaceAudioEffectTargets: [], clearInstrumentTargets: [],
      upsertDeviceRows: [{ targetId: "missing", effect: "instrument", params: bad }] })
    expect(result.instruments.get("instrument")?.kind).toBe("sampled")
    expect(result.instruments.has("missing")).toBeFalse()
    expect(result.instrumentReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("missing")]))
  })
  for (const desiredCallback of [false, true]) test(`r2 older publication desiredCallback=${desiredCallback}`, async () => {
    const fixture = createBridge()
    const base = nativeInstrumentInput()
    let instrument = synth()
    let order = 1
    const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
      ...(desiredCallback && { getDesiredProcessorState: (snapshot, rate) =>
        compileDesiredNativeProcessorState(snapshot, rate, order, panelProjection(instrument)) }),
      getProcessorTarget: () => ({ kindId: 18, incarnation: 1, latest: { id: `edit-${order}`, order,
        target: { nodeId: "instrument", instanceId: instrument.instanceId, kindId: 18, incarnation: 1 }, content: { params: instrument } } }),
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport, processorStateSequence: order,
        renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { instrument: { instances: [], instrument } } } } }) })
    expect(await controller.start(base.transport)).toBe("started")
    instrument = synth({ ...instrument.params, polyphony: 4 }); order = 10
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-7")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const candidateSnapshot = candidateCompilation.snapshot

    expect(capturedGraph(candidateSnapshot).nodes.find(node => node.id === "instrument")?.instrument?.voiceCapacity).toBe(4)
    instrument = synth({ ...instrument.params, polyphony: 8 }); order = 11
    const answer = watch(controller.deliverProcessor({ id: "edit-11", order, target: {
      nodeId: "instrument", instanceId: instrument.instanceId, kindId: 18, incarnation: 1 }, content: { params: instrument } }).settled)
    let sentVoices: number | undefined
    const configure = fixture.bridge.session.configureInstrumentStates
    fixture.bridge.session.configureInstrumentStates = async bytes => {
      // The wire configuration is checked against the encoder's exact expected synth state.
      const expected = serializeNativeInstrumentStates([{ nodeId: "instrument",
        state: compilePortableSynthState(instrument.params) }], [])
      if (Buffer.from(bytes).equals(Buffer.from(expected))) sentVoices = 8
      return configure(bytes)
    }
    acknowledgeStagedPublication(fixture)
    expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
    await turns()
    expect(answer.value).toEqual(desiredCallback ? { state: "applied" } : undefined)
    if (desiredCallback) expect(sentVoices).toBe(8)
    await controller.dispose()
  })
  for (const pending of [false, true]) test(`r2 unchanged rebase allocates zero receipts pending=${pending}`, async () => {
    const fixture = createBridge()
    const base = nativeInstrumentInput()
    let instrument = synth()
    const edit = (order: number): LiveProcessorEditIdentity => ({ id: `bracket-${order}`, order,
      target: { nodeId: "instrument", instanceId: instrument.instanceId, kindId: 18, incarnation: 1 }, content: { params: instrument } })
    const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
      fingerprintSnapshot: () => "same", getProcessorTarget: () => ({ kindId: 18, incarnation: 1, latest: edit(20) }),
      getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 20, panelProjection(instrument)),
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...base, transport }) })
    expect(await controller.start(base.transport)).toBe("started")
    if (pending) instrument = synth({ ...instrument.params, polyphony: 4 })
    const first = controller.deliverProcessor(edit(20))
    const answer = watch(first.settled)
    const batches = fixture.instrumentPayloads.length
    for (let i = 0; i < 20; i++) expect(await controller.adoptSchedule({ key: `same-${i}`, schedule: "same", context: {},
      loop: { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 } }, true)).toEqual({ status: "unchanged" })
    const last = controller.deliverProcessor(edit(21))
    expect(last.receipt.serial - first.receipt.serial).toBe(1)
    expect(fixture.instrumentPayloads.length).toBe(batches)
    expect(fixture.calls.filter(call => call === "stage-prepare")).toHaveLength(0)
    if (pending) expect(answer.value).toBeUndefined()
    await controller.dispose()
  })

})

if (!globalThis.navigator?.locks) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      ...globalThis.navigator,
      locks: {
        request: async <Value>(
          name: string,
          ...args: [callback: (lock: { name: string } | null) => Promise<Value>]
            | [options: { ifAvailable?: boolean; mode?: 'shared' | 'exclusive' }, callback: (lock: { name: string } | null) => Promise<Value>]
        ) => {
          const callback = args.length === 1 ? args[0] : args[1]
          return callback({ name })
        },
      },
    },
  })
}

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  constructor(
    private readonly channels: Float32Array<ArrayBuffer>[] = [
      new Float32Array(1),
      new Float32Array(1),
    ],
    sampleRate = 48_000,
  ) {
    this.length = channels[0]?.length ?? 0
    this.numberOfChannels = channels.length
    this.sampleRate = sampleRate
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, offset = 0) {
    const source = this.channels[channel]
    if (!source) throw new Error(`Missing channel ${channel}.`)
    destination.set(source.subarray(offset, offset + destination.length))
  }

  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, offset = 0) {
    const destination = this.channels[channel]
    if (!destination) throw new Error(`Missing channel ${channel}.`)
    destination.set(source, offset)
  }

  getChannelData(channel: number) {
    const samples = this.channels[channel]
    if (!samples) throw new Error(`Missing channel ${channel}.`)
    return samples
  }
}

const silenceWavDataUrl = (frameCount: number, channelCount = 1) => {
  const bytes = new Uint8Array(44 + frameCount * channelCount * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset)
  write(0, "RIFF")
  view.setUint32(4, bytes.byteLength - 8, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, 48_000, true)
  view.setUint32(28, 48_000 * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, bytes.byteLength - 44, true)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return `data:audio/wav;base64,${btoa(binary)}`
}

const sourceTrack = (volume = 0.8): RuntimeTrack => ({
  id: "track",
  name: "Track",
  volume,
  clips: [{
    id: "clip",
    name: "Clip",
    color: "#fff",
    startSec: 0,
    duration: 1 / 48_000,
    sourceAssetKey: "source",
    sourceKind: "url" as const,
    sampleUrl: silenceWavDataUrl(1),
    buffer: new TestAudioBuffer(),
  }],
})

const longSourceTrack = (): RuntimeTrack => ({
  ...sourceTrack(),
  clips: [{
    ...sourceTrack().clips[0]!,
    buffer: null,
    duration: 7_200,
    sourceDurationSec: 7_200,
    sourceSampleRate: 48_000,
    sourceChannelCount: 2,
  }],
})

const longSourceDescriptor = (): AudioPcmSourceDescriptor => ({
  identity: "test:long-source",
  durationSec: 7_200,
  frameCount: 7_200 * 48_000,
  sampleRate: 48_000,
  channelCount: 2,
  readPages: async function* ({ startFrame = 0, endFrame = 7_200 * 48_000, signal } = {}) {
    signal?.throwIfAborted()
    const frameCount = endFrame - startFrame
    yield {
      startFrame,
      frameCount,
      sampleRate: 48_000,
      channelCount: 2,
      planes: [new Float32Array(frameCount), new Float32Array(frameCount)],
    }
  },
})

const input = (track = sourceTrack()): LivePlaybackSnapshotInput => ({
  revision: 1,
  bpm: 120,
  transport: { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
  tracks: [track],
  renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
  sidechainRoutes: [],
})

const inputWithRawAssetsAndStretch = (rawAssetCount: number): LivePlaybackSnapshotInput => ({
  ...input({
    ...sourceTrack(),
    clips: [
      ...Array.from({ length: rawAssetCount }, (_, index) => ({
        ...sourceTrack().clips[0]!,
        id: `raw-clip-${index}`,
        sourceAssetKey: `raw-source-${index}`,
        buffer: new TestAudioBuffer(),
      })),
      {
        ...sourceTrack().clips[0]!,
        id: "stretch-clip",
        sourceAssetKey: "stretch-source",
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
        buffer: new TestAudioBuffer(),
      },
    ],
  }),
})

const instrumentTrack: RuntimeTrack = {
  id: "instrument",
  kind: "instrument",
  name: "Instrument",
  volume: 0.8,
  channelRole: "track",
  clips: [{
    id: "midi",
    name: "MIDI",
    color: "#fff",
    startSec: 0,
    duration: 1,
    midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 0.5, velocity: 0.8 }] },
  }],
}

const nativeInstrumentInput = (): LivePlaybackSnapshotInput => ({
  ...input(instrumentTrack),
  renderState: {
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: {
        instrument: {
          instances: [],
          instrument: {
            kind: "synth",
            instanceId: "synth:1",
            params: createDefaultSynthParams(),
          },
        },
      },
    },
    automationEnvelopes: [],
  },
})

const liveMidiInput = (): LivePlaybackSnapshotInput => {
  const base = nativeInstrumentInput()
  return {
    ...base,
    renderState: {
      ...base.renderState,
      fx: {
        ...base.renderState.fx,
        trackFx: {
          instrument: {
            instances: [],
            synth: createDefaultSynthParams(),
          },
        },
      },
    },
  }
}

const nativeAttachmentPlan: NativeExternalAttachmentPlan = {
  version: 1,
  attachments: [{
    instanceId: "11111111-1111-4111-8111-111111111111",
    graphNodeId: "track",
    nativeGraphNodeId: "123",
    stageIndex: 0,
    catalogIdentity: {
      format: "vst3",
      classId: "class",
      vendorId: "vendor",
      architecture: "arm64",
      scannerCatalogVersion: 2,
    },
    bundleFingerprint: "a".repeat(64),
    binaryFingerprint: "b".repeat(64),
    role: "effect",
    inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
    outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
    workerTransport: {
      slotCount: 2,
      maximumFrames: 512,
      maximumEventsPerBlock: 128,
      inputChannels: 2,
      outputChannels: 2,
    },
    declaredLatencyFrames: 0,
    declaredTailFrames: null,
    bypassed: false,
    stateRevision: 0,
    parameters: [{
      id: 7,
      title: "Mix",
      unit: "%",
      minimum: 0,
      maximum: 1,
      defaultValue: 0.25,
      stepCount: 100,
      readOnly: false,
      hidden: false,
    }],
    parameterOverrides: { "7": 0.4 },
  }],
}

const insertedExternalProcessor = (): ExternalProcessor => externalProcessorSchema.parse({
  instanceId: "11111111-1111-4111-8111-111111111111",
  targetId: "track",
  index: 0,
  manifest: {
    identity: {
      format: "vst3",
      classId: "example",
      vendor: "Example",
      name: "Example",
      version: "1",
      architecture: "arm64",
      binaryFingerprint: "b".repeat(64),
    },
    role: "effect",
    audioInputs: [{ name: "Input", channels: 2, enabled: true }],
    audioOutputs: [{ name: "Output", channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: false,
    supportsEditor: false,
    supportsState: false,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  launchReference: {
    version: 1,
    classId: "example",
    vendorId: "Example",
    architecture: "arm64",
    bundleFingerprint: "a".repeat(64),
    binaryFingerprint: "b".repeat(64),
    scannerCatalogVersion: 2,
  },
  health: { state: "ready", updatedAt: 1 },
  updatedAt: 1,
})

type BridgeReply = { ok: true } | { ok: false; error: string }
const appliedPatch: NativeProcessorPatchReply = { ok: true, outcome: "applied" }
type BridgeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }

const createBridge = (
  failure?: string,
  serializeInstrumentRequests = false,
  requireStartedForSchedule = false,
  failureMessage = "failed",
  sampleRateHz = 48_000,
  suppressRedundantPausedTransition = false,
  maximumFrames = 512,
) => {
  const calls: string[] = []
  const coordinations: string[] = []
  const parameterPayloads: Uint8Array[] = []
  const builtInParameterPayloads: Uint8Array[] = []
  const statePatchPayloads: Uint8Array[] = []
  const instrumentPayloads: Uint8Array[] = []
  const schedulePayloads: Uint8Array[] = []
  const reenablePayloads: Uint8Array[] = []
  const graphPayloads: Uint8Array[] = []
  let runtimeRevision = 1
  const revisionReply = (status: NativeGraphRevisionStatus["status"]): NativeRevisionReply => ({
    ok: true, hostPid: 123, hostGeneration: 7,
    revision: { status, continuity: "accepted", requestedRevision: runtimeRevision,
      activeRevision: runtimeRevision, preparedRevision: runtimeRevision,
      retiredRevision: runtimeRevision - 1, publicationFrame: 1024n, renderEpoch: 10n },
  })
  const revisions: NativeRevisionSession = {
    prepare: async ({ bytes }) => {
      calls.push("revision-prepare")
      graphPayloads.push(bytes)
      runtimeRevision++
      return revisionReply("prepared")
    },
    publish: async () => { calls.push("revision-publish"); return revisionReply("published") },
    inspect: async () => revisionReply("published"),
    rollback: async () => { calls.push("revision-rollback"); return revisionReply("rolled-back") },
    retire: async () => { calls.push("revision-retire"); return revisionReply("retired") },
  }
  const installedAssets: NativeHostPcmAsset[] = []
  const releasedAssetIds: number[] = []
  const mappedPages: NativeHostMappedAssetPage[] = []
  const preparedRanges: { startFrame: number; frameCount: number }[] = []
  let legacyInstallCount = 0
  let mappedAssetCreateCount = 0
  const transports: Array<{
    epoch: number
    frame: number
    running: boolean
    hasCycleStart: boolean
    hasCycleEnd: boolean
  }> = []
  const spectrumNodeIds: Array<bigint | null> = []
  const transportContexts: NativeHostTransport[] = []
  const spectrumSelections: Array<{ nodeId: bigint | null; sessionStarted: boolean }> = []
  let spectrumReply: (nodeId: bigint | null) => Promise<BridgeReply> = async () => ({ ok: true })
  const instrumentRequests: Array<{
    bytes: Uint8Array
    resolve: (reply: NativeDeliveryReply) => void
  }> = []
  const deviceId: `coreaudio:${string}` = "coreaudio:default"
  let instrumentRequestPending = false
  let loss = (_error?: string) => {}
  const lossListeners = new Set<(error?: string) => void>()
  let recordingStatus = (_status: NativeHostRecordingStatus) => {}
  let recordingFailure = (_failure: NativeRecordingFailure) => {}
  let meterBatch = (_batch: NativeHostMeterBatch) => {}
  let spectrumFrame = (_frame: NativeHostSpectrumFrame) => {}
  const scheduleProgressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  const recordingTargets: bigint[] = []
  const scheduleProgress = (progress: NativeScheduleProgress) => {
    for (const listener of scheduleProgressListeners) listener(progress)
  }
  const vstInstanceListeners = new Set<(event: DesktopVstInstanceEvent) => void>()
  let progressSequence = 0n
  // Native carries the last reported claim resolution on every frame after it.
  let resolvedPatch: { token: string; result: number } | undefined
  let transportEpoch = 1
  let appliedTransitionId = 0n
  let appliedUrgentSequence = 0n
  let appliedProcessorSequence = 0n
  let sessionStarted = false
  let lastTransport: { frame: number; running: boolean } | undefined
  let rejectScheduleWindows = false
  const emitProgress = (frame: number) => {
    progressSequence += 1n
    const currentWindows = schedulePayloads.filter((payload) => {
      const view = new DataView(payload.buffer)
      return view.getUint32(4, true) === transportEpoch
    })
    const acceptedThroughFrame = currentWindows.reduce(
      (maximum, payload) => Math.max(maximum, Number(new DataView(payload.buffer).getBigUint64(24, true))),
      frame,
    )
    scheduleProgress({
      revision: failure === "runtime-revision-progress" ? runtimeRevision : 1,
      epoch: transportEpoch,
      progressSequence,
      renderedThroughFrame: BigInt(frame),
      acceptedThroughFrame: BigInt(acceptedThroughFrame),
      lastAcceptedWindowId: BigInt(currentWindows.length),
      appliedTransportTransitionId: appliedTransitionId,
      appliedUrgentSequence,
      appliedProcessorSequence,
      running: false,
      scheduleComplete: currentWindows.some((payload) => new DataView(payload.buffer).getUint32(40, true) === 1),
      instrumentCredits: 256,
      sourceCredits: 256,
      automationCredits: 256,
      processorPatchResolved: resolvedPatch,
    })
  }
  const reply = (name: string) => async () => {
    calls.push(name)
    return name === failure ? { ok: false as const, error: failureMessage } : { ok: true as const }
  }
  return {
    calls,
    coordinations,
    parameterPayloads,
    builtInParameterPayloads,
    statePatchPayloads,
    instrumentPayloads,
    schedulePayloads,
    reenablePayloads,
    graphPayloads,
    revisionReply,
    setRuntimeRevision: (revision: number) => { runtimeRevision = revision },
    emitProgress,
    recordingTargets,
    listenerCounts: () => ({ progress: scheduleProgressListeners.size, loss: lossListeners.size }),
    installedAssets,
    releasedAssetIds,
    mappedPages,
    preparedRanges,
    get legacyInstallCount() { return legacyInstallCount },
    get mappedAssetCreateCount() { return mappedAssetCreateCount },
    transports,
    spectrumNodeIds,
    transportContexts,
    spectrumSelections,
    setSpectrumReply: (reply: (nodeId: bigint | null) => Promise<BridgeReply>) => { spectrumReply = reply },
    instrumentRequests,
    captureLoss: () => loss,
    emitLoss: (error?: string) => {
      for (const listener of lossListeners) listener(error)
    },
    emitRecordingStatus: (status: NativeHostRecordingStatus) => recordingStatus(status),
    emitRecordingFailure: (failure: NativeRecordingFailure) => recordingFailure(failure),
    emitMeterBatch: (batch: NativeHostMeterBatch) => meterBatch(batch),
    emitSpectrumFrame: (frame: NativeHostSpectrumFrame) => spectrumFrame(frame),
    emitScheduleProgress: (progress: NativeScheduleProgress) => scheduleProgress(progress),
    emitVstInstanceEvent: (event: DesktopVstInstanceEvent) => { for (const listener of vstInstanceListeners) listener(event) },
    vstInstanceListenerCount: () => vstInstanceListeners.size,
    emitPatchResolution: (token: string, result = 0) => {
      resolvedPatch = { token, result }
      emitProgress(0)
    },
    setScheduleFailure: (rejected: boolean) => {
      rejectScheduleWindows = rejected
    },
    bridge: {
      instrumentBudgetPolicy: { deviceDecodedBytes: 1024 ** 3, aggregateBytes: 2 * 1024 ** 3 },
      recordingSpool: {
        list: async (): Promise<{ takes: NativeRecordingTake[]; nextCursor: string | null }> => ({ takes: [{ takeId: "retained-take", state: "complete", sampleRateHz: 48000,
          channelCount: 1, frames: 128, bytes: 516, blocks: 1 }], nextCursor: null }),
        read: async () => new Uint8Array(), release: async () => undefined,
      },
      resolveOutputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: "Default",
          nominalSampleRateHz: sampleRateHz,
          outputChannelCount: 2,
          maximumFramesPerBlock: maximumFrames,
          available: true,
        },
      }),
      resolveInputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: "Default Input",
          nominalSampleRateHz: sampleRateHz,
          inputChannelCount: 2,
          maximumFramesPerBlock: maximumFrames,
          available: true,
        },
      }),
      session: {
        revisions,
        configure: async (): Promise<
          | { ok: true; hostIdentity: { pid: number; generation: number; configurationGeneration: number } }
          | { ok: false; error: string }
        > => {
          const result = await reply("configure")()
          return result.ok ? { ok: true, hostIdentity: { pid: 123, generation: 7, configurationGeneration: 1 } } : result
        },
        configureInstrumentStates: async (_bytes: Uint8Array): Promise<BridgeReply> => failure === 'instrument-state'
          ? { ok: false, error: failureMessage }
          : { ok: true },
        beginTransaction: async (): Promise<BridgeTransactionReply> => {
          calls.push("begin")
          return failure === "begin" ? { ok: false as const, error: failureMessage } : { ok: true as const, transactionToken: "transaction-token" }
        },
        commitTransaction: reply("commit"),
        rollbackTransaction: reply("rollback"),
        installAsset: async (asset: NativeHostPcmAsset) => {
          calls.push("install")
          legacyInstallCount += 1
          installedAssets.push(asset)
          return failure === "install"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        createMappedAsset: async (asset: NativeHostMappedAsset) => {
          calls.push("install")
          mappedAssetCreateCount += 1
          installedAssets.push({
            sessionAssetId: asset.sessionAssetId,
            frameCount: asset.frameCount,
            sampleRateHz: asset.sampleRateHz,
            channelCount: asset.channelCount,
            planarPcm: new Uint8Array(),
          })
          return failure === "install"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        writeMappedAssetPage: async (page: NativeHostMappedAssetPage): Promise<BridgeReply> => {
          mappedPages.push(page)
          return { ok: true }
        },
        prepareMappedAssetRange: async (_assetId: number, startFrame: number, frameCount: number): Promise<BridgeReply> => {
          preparedRanges.push({ startFrame, frameCount })
          return { ok: true }
        },
        releaseAsset: async (sessionAssetId: number): Promise<BridgeReply> => {
          calls.push("release")
          releasedAssetIds.push(sessionAssetId)
          return failure === "release" ? { ok: false, error: failureMessage } : { ok: true }
        },
        publishGraph: async (bytes: Uint8Array) => {
          calls.push("graph")
          graphPayloads.push(bytes)
          return failure === "graph"
            ? { ok: false as const, error: "failed" }
            : { ok: true as const }
        },
        queueInstrumentEvents: (bytes: Uint8Array) => {
          calls.push("instrument")
          instrumentPayloads.push(bytes)
          const view = new DataView(bytes.buffer)
          const count = view.getUint32(0, true)
          for (let index = 0; index < count; index += 1) {
            const sequence = view.getBigUint64(20 + index * 48, true)
            if (sequence > appliedUrgentSequence) appliedUrgentSequence = sequence
          }
          queueMicrotask(() => emitProgress(0))
          if (!serializeInstrumentRequests) {
            return Promise.resolve<NativeDeliveryReply>(failure === "instrument"
              ? { ok: false, error: "failed", kind: "refused" }
              : { ok: true })
          }
          if (instrumentRequestPending) {
            return Promise.reject(new Error("The native audio host is unavailable."))
          }
          instrumentRequestPending = true
          const request = Promise.withResolvers<NativeDeliveryReply>()
          instrumentRequests.push({ bytes, resolve: request.resolve })
          return request.promise.finally(() => {
            instrumentRequestPending = false
          })
        },
        queueParameterEvents: async (bytes: Uint8Array): Promise<NativeDeliveryReply> => {
          calls.push("built-in-parameter")
          builtInParameterPayloads.push(bytes)
          // A batch native refused is never applied, so no frame reports it.
          if (bytes.byteLength >= 20 && failure !== "built-in-parameter") {
            appliedProcessorSequence = new DataView(bytes.buffer).getBigUint64(12, true)
            queueMicrotask(() => emitProgress(0))
          }
          return failure === "built-in-parameter"
            ? { ok: false, error: failureMessage, kind: "refused" }
            : { ok: true }
        },
        queueProcessorStatePatch: async (bytes: Uint8Array): Promise<NativeProcessorPatchReply> => {
          calls.push("processor-state-patch")
          statePatchPayloads.push(bytes)
          return failure === "processor-state-patch"
            ? { ok: false, error: failureMessage, kind: "refused" }
            : appliedPatch
        },
        queueSourceEvents: reply("source"),
        queueScheduleWindow: async (bytes: Uint8Array) => {
          calls.push("schedule")
          if (requireStartedForSchedule && !sessionStarted) {
            return { ok: false as const, error: "session is not started" }
          }
          schedulePayloads.push(bytes)
          queueMicrotask(() => emitProgress(0))
          return failure === "schedule" || rejectScheduleWindows
            ? { ok: false as const, error: "failed" }
            : { ok: true as const }
        },
        reenableVstScheduleAutomation: async (bytes: Uint8Array) => {
          calls.push("reenable-automation")
          reenablePayloads.push(bytes)
          return failure === "reenable-automation"
            ? { ok: false as const, error: failureMessage }
            : { ok: true as const }
        },
        queueVstParameterEvents: async (bytes: Uint8Array) => {
          calls.push("parameter")
          parameterPayloads.push(bytes)
          return failure === "parameter" ? { ok: false as const, error: "failed" } : { ok: true as const }
        },
        coordinateVstAttachments: async (request: { serializedPlan: string }) => {
          calls.push("coordinate")
          coordinations.push(request.serializedPlan)
          return failure === "coordinate" ? { ok: false as const, error: "failed" } : { ok: true as const }
        },
        setTransport: async (transport: NativeHostTransport) => {
          calls.push("transport")
          transportContexts.push(transport)
          transports.push({
            epoch: transport.epoch,
            frame: transport.frame,
            running: transport.running,
            hasCycleStart: Object.hasOwn(transport, "cycleStartSec"),
            hasCycleEnd: Object.hasOwn(transport, "cycleEndSec"),
          })
          transportEpoch = transport.epoch
          appliedTransitionId = transport.transitionId ?? (appliedTransitionId + 1n)
          const redundantPausedTransition = suppressRedundantPausedTransition
            && lastTransport !== undefined
            && !transport.running
            && !lastTransport.running
            && transport.frame === lastTransport.frame
          lastTransport = { frame: transport.frame, running: transport.running }
          if (redundantPausedTransition) return { ok: true as const }
          if (requireStartedForSchedule && !sessionStarted) return { ok: true as const }
          queueMicrotask(() => {
            emitProgress(transport.frame)
            const currentWindows = schedulePayloads.filter((payload) => {
              const view = new DataView(payload.buffer)
              return view.getUint32(4, true) === transportEpoch
            })
            const acceptedThroughFrame = currentWindows.reduce(
              (maximum, payload) => Math.max(maximum, Number(new DataView(payload.buffer).getBigUint64(24, true))),
              transport.frame,
            )
            progressSequence += 1n
            scheduleProgress({
              ...({
                revision: failure === "runtime-revision-progress" ? runtimeRevision : 1,
                epoch: transportEpoch,
                progressSequence,
                renderedThroughFrame: BigInt(transport.frame),
                acceptedThroughFrame: BigInt(acceptedThroughFrame),
                lastAcceptedWindowId: BigInt(currentWindows.length),
                appliedTransportTransitionId: appliedTransitionId,
                appliedUrgentSequence,
                appliedProcessorSequence,
                running: transport.running,
                scheduleComplete: currentWindows.some((payload) => new DataView(payload.buffer).getUint32(40, true) === 1),
                instrumentCredits: 256,
                sourceCredits: 256,
                automationCredits: 256,
              } satisfies NativeScheduleProgress),
            })
          })
          return failure === "transport" ? { ok: false as const, error: "failed" } : { ok: true as const }
        },
        configureRecording: async (configuration: { targetNodeId: bigint }): Promise<{ ok: true; takeId: string; sampleRateHz: number; channelCount: number }> => {
          recordingTargets.push(configuration.targetNodeId)
          return { ok: true, takeId: "retained-take", sampleRateHz: 48000, channelCount: 1 }
        },
        startRecording: async () => {
          calls.push("recording-start")
          queueMicrotask(() => recordingStatus({
            generation: 1,
            sessionId: 1n,
            timelineFrame: 120,
            capturedFrames: 0,
            droppedFrames: 0,
            droppedBlocks: 0,
            availableBlocks: 32,
            queuedBlocks: 0,
            rms: 0,
            peak: 0,
            fatal: false,
            active: true,
            configured: true,
          }))
          return { ok: true as const }
        },
        stopRecording: async () => {
          calls.push("recording-stop")
          queueMicrotask(() => recordingStatus({
            generation: 1,
            sessionId: 1n,
            timelineFrame: 248,
            capturedFrames: 128,
            droppedFrames: 0,
            droppedBlocks: 0,
            availableBlocks: 32,
            queuedBlocks: 0,
            rms: 0.25,
            peak: 0.5,
            fatal: false,
            active: false,
            configured: true,
            spool: { state: 2, error: 0, systemError: 0, writtenFrames: 128, writtenBytes: 516,
              writtenBlocks: 1, published: true, partialRetained: false, sampleRateHz: 48000, channelCount: 1 },
          }))
          return { ok: true as const }
        },
        cancelRecording: reply("recording-cancel"),
        start: async () => {
          calls.push("start")
          sessionStarted = true
          if (requireStartedForSchedule) queueMicrotask(() => emitProgress(0))
          return { ok: true as const }
        },
        stop: async (): Promise<BridgeReply> => {
          calls.push("stop")
          sessionStarted = false
          return { ok: true as const }
        },
        teardown: reply("teardown"),
        onLoss: (listener: () => void) => {
          loss = listener
          lossListeners.add(listener)
          return () => {
            lossListeners.delete(listener)
            if (loss === listener) loss = () => {}
          }
        },
        onRecordingFailure: (listener: (failure: NativeRecordingFailure) => void) => {
          recordingFailure = listener; return () => { recordingFailure = () => {} }
        },
        onRecordingStatus: (listener: (status: NativeHostRecordingStatus) => void) => {
          recordingStatus = listener
          return () => { recordingStatus = () => {} }
        },
        onMeterBatch: (listener: (batch: NativeHostMeterBatch) => void) => {
          meterBatch = listener
          return () => { meterBatch = () => {} }
        },
        setSpectrumNode: async (nodeId: bigint | null) => {
          spectrumNodeIds.push(nodeId)
          spectrumSelections.push({ nodeId, sessionStarted })
          if (nodeId !== null && !sessionStarted) {
            return { ok: false as const, error: "session is not started" }
          }
          return spectrumReply(nodeId)
        },
        onSpectrumFrame: (listener: (frame: NativeHostSpectrumFrame) => void) => {
          spectrumFrame = listener
          return () => { spectrumFrame = () => {} }
        },
        onScheduleProgress: (listener: typeof scheduleProgress) => {
          scheduleProgressListeners.add(listener)
          return () => { scheduleProgressListeners.delete(listener) }
        },
        onVstInstanceEvent: (listener: (event: DesktopVstInstanceEvent) => void) => {
          vstInstanceListeners.add(listener)
          return () => { vstInstanceListeners.delete(listener) }
        },
      },
    },
  }
}

const decodeNativeInstrumentEvents = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  const count = view.getUint32(0, true)
  return Array.from({ length: count }, (_, index) => ({
    nodeId: view.getBigUint64(4 + index * 48, true),
    type: view.getUint32(36 + index * 48, true),
  }))
})

const nativeInstrumentEventTypes = (payload: Uint8Array) =>
  decodeNativeInstrumentEvents([payload]).map(({ type }) => type)

const nativeLiveInstrumentEvents = (payloads: readonly Uint8Array[]) =>
  decodeNativeInstrumentEvents(payloads).filter(({ type }) => type === 101 || type === 102)

const nativeTransportReleaseEvents = (payloads: readonly Uint8Array[]) =>
  decodeNativeInstrumentEvents(payloads).filter(({ type }) => type === 103)

const sampledNativeInput = (kind: 'sampler' | 'granular' | 'drum-rack', seconds = 8, suppliedBuffer?: AudioBuffer): LivePlaybackSnapshotInput => {
  const buffer = suppliedBuffer ?? new TestAudioBuffer([
    new Float32Array(seconds * 48_000).fill(0.25),
    new Float32Array(seconds * 48_000).fill(-0.5),
  ])
  const sample: SamplerZone['sample'] = { assetKey: 'instrument-only', url: '/sample.wav', sourceKind: 'upload',
    source: { durationSec: seconds, sampleRate: 48_000, channelCount: 2 } }
  const zone: SamplerZone = { id: 'zone', sample, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127,
    rootNote: 60, tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0,
    playbackMode: 'one-shot', startSec: 0, endSec: seconds, crossfadeSec: 0, chokeGroup: 0 }
  const instrument: TrackInstrumentParams = kind === 'sampler'
    ? { kind, instanceId: 'sampled', params: { ...createDefaultSamplerParams(), zones: [zone] } }
    : kind === 'granular'
      ? { kind, instanceId: 'sampled', params: { ...createDefaultGranularParams(), zone } }
      : { kind, instanceId: 'sampled', params: { ...createDefaultDrumRackParams(),
        pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample, endSec: seconds }] } }
  return {
    ...input(instrumentTrack),
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {
      instrument: { instances: [], instrument,
        samplerBuffers: kind === 'sampler' ? new Map([['zone', { buffer, sourceStartFrame: 0 }]]) : undefined,
        granularBuffer: kind === 'granular' ? { buffer, sourceStartFrame: 0,
          assetKey: sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 0, sourceEndFrame: buffer.length }) } : undefined,
        drumRackBuffers: kind === 'drum-rack'
          ? new Map([[instrument.kind === 'drum-rack' ? instrument.params.pads[0]!.id : '', { buffer, sourceStartFrame: 0 }]])
          : undefined,
      },
    } }, automationEnvelopes: [] },
  }
}

const acknowledgeStagedPublication = (fixture: ReturnType<typeof createBridge>, revision = 2) => {
  let seam = 0n
  let published = false
  const reply = (): NativeRevisionReply => ({ ok: true, hostPid: 123, hostGeneration: 7,
    revision: { status: published ? "published" : "prepared", continuity: "accepted",
      requestedRevision: revision, activeRevision: published ? revision : revision - 1, preparedRevision: published ? 0 : revision,
      retiredRevision: 0, renderEpoch: 1n, transportEpoch: fixture.transports.at(-1)?.epoch ?? 1, publicationFrame: published ? seam : 0n,
      progressFrame: published ? seam : 0n } })
  fixture.bridge.session.revisions.prepare = async (request) => {
    seam = request.requestedPublicationFrame ?? 0n
    fixture.calls.push("stage-prepare")
    return reply()
  }
  fixture.bridge.session.revisions.publish = async () => {
    published = true
    fixture.setRuntimeRevision(revision)
    return reply()
  }
  fixture.bridge.session.revisions.inspect = async () => reply()
}

// AE-08 6i: a playing native session adopts a sampled instrument's zone edit through the staged instrument-state
// configuration of the same session; none of them begins, stops or rebuilds a session.
const editedSampledInput = (kind: 'sampler' | 'granular' | 'drum-rack'): LivePlaybackSnapshotInput => {
  const base = sampledNativeInput(kind, 0.1)
  const entry = base.renderState?.fx.trackFx?.instrument
  if (!entry?.instrument) throw new Error('The sampled fixture has no instrument.')
  const { instrument } = entry
  const edited: TrackInstrumentParams = instrument.kind === 'sampler'
    ? { ...instrument, params: { ...instrument.params, zones: instrument.params.zones.map(zone => ({ ...zone, tuneCents: 200 })) } }
    : instrument.kind === 'granular'
      ? { ...instrument, params: { ...instrument.params, grainSizeMs: 90 } }
      : instrument.kind === 'drum-rack'
        ? { ...instrument, params: { ...instrument.params, pads: instrument.params.pads.map((pad, index) => index === 0 ? { ...pad, tuneCents: 200 } : pad) } }
        : instrument
  return { ...base, revision: 2, renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { instrument: { ...entry, instrument: edited } } } } }
}

for (const kind of ['sampler', 'granular', 'drum-rack'] satisfies readonly ('sampler' | 'granular' | 'drum-rack')[]) {
  test(`a ${kind} zone edit while playing is adopted through the instrument-state configuration, with no new session`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    let desired = sampledNativeInput(kind, 0.1)
    const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }) })
    try {
      expect(await controller.start(desired.transport)).toBe("started")
      const before = fixture.calls.length
      desired = editedSampledInput(kind)
      let configurations = 0
      const configure = fixture.bridge.session.configureInstrumentStates
      fixture.bridge.session.configureInstrumentStates = async (bytes) => { configurations++; return configure(bytes) }
      acknowledgeStagedPublication(fixture)
      expect(await controller.adoptSchedule(migrationIntent(`zone-edit-${kind}`), true)).toEqual({ status: "adopted" })
      expect(configurations).toBe(1)
      expect(fixture.calls.slice(before).filter((call) => ["graph", "stop", "teardown", "begin"].includes(call))).toEqual([])
    } finally { await controller.dispose() }
  })

  test(`same-key ${kind} PCM replacement stages a fresh configured handle`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    let desired = sampledNativeInput(kind, 0.1)
    const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }) })
    expect(await controller.start(desired.transport)).toBe("started")
    const before = fixture.calls.length
    const originalAssets = fixture.installedAssets.map((asset) => asset.sessionAssetId)
    desired = { ...sampledNativeInput(kind, 0.1), revision: 2 }
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-8")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

    let configured = false
    fixture.bridge.session.configureInstrumentStates = async (bytes) => {
      configured = new DataView(bytes.buffer).getUint32(0, true) === 1
      expect(fixture.installedAssets.at(-1)?.sessionAssetId).not.toBe(originalAssets[0])
      return { ok: true }
    }
    acknowledgeStagedPublication(fixture)
    expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
    expect(configured).toBe(true)
    const stagedEvents = fixture.schedulePayloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
    expect(stagedEvents.some((bytes) => {
      const view = new DataView(bytes.buffer)
      return Array.from({ length: view.getUint32(44, true) }, (_, index) =>
        view.getUint32(72 + index * 48 + 32, true)).includes(1)
    })).toBe(true)
    expect(fixture.releasedAssetIds).toEqual(originalAssets)
    expect(fixture.calls.slice(before).filter((call) => ["graph", "stop", "teardown", "begin"].includes(call))).toEqual([])
    await controller.dispose()
  })

  test(`fully prepares instrument-only eight-second ${kind} before configuration without installs`, async () => {
    const fixture = createBridge()
    const snapshotInput = sampledNativeInput(kind)
    fixture.bridge.session.configureInstrumentStates = async () => {
      expect(fixture.preparedRanges).toContainEqual({ startFrame: 0, frameCount: 384_000 })
      fixture.calls.push('instrument-state')
      return { ok: true }
    }
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    })
    expect(await controller.ensureLivePreview(0)).toBe('started')
    expect(controller.isPrepared()).toBe(true)
    expect(fixture.legacyInstallCount).toBe(0)
    expect(fixture.mappedAssetCreateCount).toBe(1)
    expect(fixture.preparedRanges).toContainEqual({ startFrame: 0, frameCount: 384_000 })
    expect(fixture.mappedPages.reduce((total, page) => total + page.frameCount, 0)).toBe(384_000)
    expect(fixture.mappedPages.every((page) => page.planarPcm.byteLength + 24 <= 1024 ** 2)).toBe(true)
    expect(fixture.calls.indexOf('instrument-state')).toBeLessThan(fixture.calls.indexOf('commit'))
    await controller.destroy()
  })
}

test('keeps native lock failures unready and preserves the actionable reason', async () => {
  const fixture = createBridge('instrument-state', false, false, 'Sample memory locking unavailable. Free memory and retry.')
  const faults: string[] = []
  const paneErrors: string[] = []
  const snapshotInput = sampledNativeInput('granular')
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    onInstrumentPreparation: (_trackIds, preparation) => {
      if (preparation.state === 'error' && preparation.error) paneErrors.push(preparation.error)
    },
  })
  expect(await controller.ensureLivePreview(0)).not.toBe('started')
  expect(controller.isPrepared()).toBe(false)
  expect(fixture.calls).toContain('rollback')
  expect(fixture.calls).not.toContain('commit')
  expect(faults.join(' ')).toContain('memory locking unavailable')
  expect(paneErrors).toContain('Sample memory locking unavailable. Free memory and retry.')
  await controller.destroy()
})

test('native instrument Retry reaches ready only after preparation ACK and Commit', async () => {
  const fixture = createBridge()
  const prepareStates = fixture.bridge.session.configureInstrumentStates
  const commitTransaction = fixture.bridge.session.commitTransaction
  const preparationEntered = Promise.withResolvers<void>()
  const releasePreparation = Promise.withResolvers<void>()
  const commitEntered = Promise.withResolvers<void>()
  const releaseCommit = Promise.withResolvers<void>()
  const sample = {
    assetKey: 'instrument-only',
    url: '/sample.wav',
    sourceKind: 'upload' as const,
    source: { durationSec: 8, sampleRate: 48_000, channelCount: 2 },
  }
  const retryZone = {
    ...createDefaultSamplerParams().zones[0]!,
    id: 'zone',
    sample,
    startSec: 0,
    endSec: 8,
  }
  const buffer = new TestAudioBuffer([new Float32Array(8 * 48_000), new Float32Array(8 * 48_000)])
  const sync = createSamplerBufferSync({
    nativeAudio: () => true,
    decodePages: async function* (_source, options) {
      const startFrame = Math.round((options?.startSec ?? 0) * 48_000)
      const endFrame = Math.round((options?.endSec ?? 8) * 48_000)
      const frameCount = endFrame - startFrame
      yield {
        startFrame,
        frameCount,
        sampleRate: 48_000,
        channelCount: 2,
        planes: [new Float32Array(frameCount), new Float32Array(frameCount)],
      }
    },
    createBuffer: () => buffer,
  })
  const engine = new AudioEngine()
  const samplerParams = { ...createDefaultSamplerParams(), zones: [retryZone] }
  let failFirstPreparation = true
  fixture.bridge.session.configureInstrumentStates = async (...args) => {
    fixture.calls.push('instrument-state')
    if (failFirstPreparation) {
      failFirstPreparation = false
      return { ok: false, error: 'Sample memory locking unavailable. Retry.' }
    }
    preparationEntered.resolve()
    await releasePreparation.promise
    return prepareStates(...args)
  }
  fixture.bridge.session.commitTransaction = async (...args) => {
    commitEntered.resolve()
    await releaseCommit.promise
    return commitTransaction(...args)
  }
  const statuses: string[] = []
  const snapshotInput = sampledNativeInput('sampler')
  await sync.syncTrack(engine, 'instrument', samplerParams, 'sampler-instance')
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    onInstrumentPreparation: (_trackIds, status) => {
      statuses.push(status.state)
      sync.setNativePreparation('instrument', status)
    },
  })

  await expect(controller.ensureLivePreview(0)).resolves.not.toBe('started')
  expect(statuses).toContain('error')
  const retry = sync.retryZone(engine, 'instrument', retryZone.id, async () => {
    await controller.ensureLivePreview(0, {})
  })
  await preparationEntered.promise
  expect(statuses.at(-1)).toBe('loading')
  expect(sync.getStatus('instrument').zones.get(retryZone.id)).toBe('loading')
  releasePreparation.resolve()
  await commitEntered.promise
  expect(statuses.at(-1)).toBe('loading')
  expect(sync.getStatus('instrument').zones.get(retryZone.id)).toBe('loading')
  releaseCommit.resolve()
  await retry

  const latestCommit = fixture.calls.lastIndexOf('commit')
  expect(fixture.calls.lastIndexOf('instrument-state')).toBeLessThan(latestCommit)
  expect(statuses.at(-1)).toBe('ready')
  expect(sync.getStatus('instrument').zones.get(retryZone.id)).toBe('ready')
  await controller.destroy()
  sync.dispose()
})

test('rejects combined native memory before creating mappings and keeps all reservations balanced', async () => {
  const fixture = createBridge()
  fixture.bridge.instrumentBudgetPolicy.aggregateBytes = 4 * 1024 ** 2
  const snapshotInput = sampledNativeInput('sampler')
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })
  expect(await controller.ensureLivePreview(0)).not.toBe('started')
  expect(fixture.mappedAssetCreateCount).toBe(0)
  expect(controller.isPrepared()).toBe(false)
  expect(faults.join(' ')).toContain('aggregate')
  await controller.destroy()
})

test('prepares the full three-minute 48 kHz granular region under the native policy', async () => {
  const fixture = createBridge()
  const snapshotInput = sampledNativeInput('granular', 180)
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  expect(await controller.ensureLivePreview(0)).toBe('started')
  expect(fixture.preparedRanges).toContainEqual({ startFrame: 0, frameCount: 8_640_000 })
  expect(fixture.legacyInstallCount).toBe(0)
  expect(fixture.mappedPages.every((page) => page.planarPcm.byteLength + 24 <= 1024 ** 2)).toBe(true)
  await controller.destroy()
})

test('rejects regions above the native per-device ceiling without reading or installing PCM', async () => {
  const seconds = 3_000
  const sparse: AudioBuffer = {
    duration: seconds, length: seconds * 48_000, numberOfChannels: 2, sampleRate: 48_000,
    copyFromChannel: () => { throw new Error('must not read rejected PCM') },
    copyToChannel: () => { throw new Error('must not write rejected PCM') },
    getChannelData: () => { throw new Error('must not materialize rejected PCM') },
  }
  const fixture = createBridge()
  const snapshotInput = sampledNativeInput('sampler', seconds, sparse)
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })
  expect(await controller.ensureLivePreview(0)).not.toBe('started')
  expect(fixture.mappedAssetCreateCount).toBe(0)
  expect(fixture.legacyInstallCount).toBe(0)
  expect(faults.join(' ')).toContain('1 GiB per device')
  await controller.destroy()
})

test('cancels a late instrument-state ACK without publishing or retaining native memory leases', async () => {
  const fixture = createBridge()
  const budget = createSampledInstrumentRegionBudget(128 * 1024 ** 2)
  const entered = Promise.withResolvers<void>()
  const ack = Promise.withResolvers<void>()
  fixture.bridge.session.configureInstrumentStates = async () => {
    entered.resolve()
    await ack.promise
    return { ok: true }
  }
  const snapshotInput = sampledNativeInput('sampler')
  const controller = createObservedController({
    bridge: fixture.bridge, instrumentBudget: budget,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  const pending = controller.ensureLivePreview(0)
  await entered.promise
  const cancelled = controller.cancelPendingStart()
  ack.resolve()
  await pending
  await cancelled
  expect(controller.isPrepared()).toBe(false)
  expect(fixture.calls).not.toContain('commit')
  expect(fixture.calls).toContain('rollback')
  expect(fixture.calls).toContain('teardown')
  expect(budget.totalBytes()).toBe(0)
  expect(budget.reservedBytes()).toBe(0)
  await controller.destroy()
})

test('releases instrument budget after a cancelled late Commit and successful teardown', async () => {
  const fixture = createBridge()
  const budget = createSampledInstrumentRegionBudget(128 * 1024 ** 2)
  const entered = Promise.withResolvers<void>()
  const commit = Promise.withResolvers<BridgeReply>()
  fixture.bridge.session.commitTransaction = async () => {
    fixture.calls.push('commit')
    entered.resolve()
    return commit.promise
  }
  const snapshotInput = sampledNativeInput('sampler')
  const controller = createObservedController({
    bridge: fixture.bridge,
    instrumentBudget: budget,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })

  const pending = controller.start({ ...snapshotInput.transport, state: 'playing' })
  await entered.promise
  expect(budget.totalBytes()).toBeGreaterThan(0)
  const cancelled = controller.cancelPendingStart()
  commit.resolve({ ok: true })
  await pending
  await cancelled

  expect(fixture.calls.filter((call) => call === 'teardown')).toHaveLength(1)
  expect(budget.totalBytes()).toBe(0)
  expect(budget.reservedBytes()).toBe(0)
  await controller.destroy()
})

test('does not publish a preparation error after project identity changes during cleanup', async () => {
  const fixture = createBridge('commit', false, false, 'old project failure')
  const teardownEntered = Promise.withResolvers<void>()
  const teardownReply = Promise.withResolvers<BridgeReply>()
  fixture.bridge.session.teardown = async () => {
    fixture.calls.push('teardown')
    teardownEntered.resolve()
    return teardownReply.promise
  }
  let projectId = 'project:old'
  const statuses: Array<{ trackIds: readonly string[]; state: string }> = []
  const snapshotInput = sampledNativeInput('sampler')
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => projectId,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    onInstrumentPreparation: (trackIds, status) => statuses.push({ trackIds, state: status.state }),
  })

  const pending = controller.ensureLivePreview(0)
  await teardownEntered.promise
  projectId = 'project:new'
  teardownReply.resolve({ ok: true })
  await pending

  expect(statuses.some(({ state }) => state === 'error')).toBe(false)
  await controller.destroy()
})

test('does not publish an old preparation error after a same-project replacement during teardown', async () => {
  const fixture = createBridge()
  const originalCommit = fixture.bridge.session.commitTransaction
  let shouldFailCommit = true
  fixture.bridge.session.commitTransaction = async (...args) => {
    if (shouldFailCommit) {
      shouldFailCommit = false
      return { ok: false, error: 'old attempt failed' }
    }
    return originalCommit(...args)
  }
  const teardownEntered = Promise.withResolvers<void>()
  const teardownReply = Promise.withResolvers<BridgeReply>()
  fixture.bridge.session.teardown = async () => {
    fixture.calls.push('teardown')
    teardownEntered.resolve()
    return teardownReply.promise
  }
  const statuses: string[] = []
  const snapshotInput = sampledNativeInput('sampler')
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => 'project:same',
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    onInstrumentPreparation: (_trackIds, status) => statuses.push(status.state),
  })

  const oldAttempt = controller.ensureLivePreview(0)
  await teardownEntered.promise
  const replacement = controller.ensureLivePreview(0, {})
  teardownReply.resolve({ ok: true })
  await expect(oldAttempt).resolves.toBe('unavailable')
  await expect(replacement).resolves.toBe('started')

  expect(statuses).not.toContain('error')
  expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(2)
  await controller.destroy()
})

test('shows ready for the instrument track when a seek lands during the preview session start and Play resumes it', async () => {
  const fixture = createBridge()
  const startGate = Promise.withResolvers<void>()
  const originalStart = fixture.bridge.session.start
  fixture.bridge.session.start = async () => {
    fixture.calls.push('start-gate')
    await startGate.promise
    return originalStart()
  }
  const statuses: string[] = []
  const snapshotInput = sampledNativeInput('granular')
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => 'project:same',
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
    onInstrumentPreparation: (_trackIds, status) => statuses.push(status.state),
  })

  const preview = controller.ensureLivePreview(0)
  for (let index = 0; index < 200 && !fixture.calls.includes('start-gate'); index += 1) await Promise.resolve()
  expect(fixture.calls).toContain('start-gate')
  const seek = controller.seekPrepared(0.5)
  const play = controller.start({ ...snapshotInput.transport, state: 'playing', playheadSec: 0.5 })
  startGate.resolve()
  await Promise.allSettled([preview, seek])

  await expect(play).resolves.toBe('started')
  expect(statuses.at(-1)).toBe('ready')
  await controller.destroy()
})

const preparationLog = () => {
  const entries: Array<{ trackIds: readonly string[]; state: string }> = []
  return { entries, record: (trackIds: readonly string[], status: { state: string }) => { entries.push({ trackIds, state: status.state }) } }
}

test('a live publication that adds a sampler reports its track ready without a pause', async () => {
  const fixture = createBridge('runtime-revision-progress')
  let desired: LivePlaybackSnapshotInput = input(longSourceTrack())
  const preparations = preparationLog()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => 'local_project', resolveSource: async () => longSourceDescriptor(),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
    onInstrumentPreparation: preparations.record,
  })
  try {
    expect(await controller.start(desired.transport)).toBe('started')
    acknowledgeStagedPublication(fixture)
    const mark = preparations.entries.length
    desired = { ...sampledNativeInput('sampler', 0.1), revision: 2, tracks: [longSourceTrack(), instrumentTrack] }
    expect(await controller.adoptSchedule(migrationIntent('sampled-add-ready'), true)).toEqual({ status: 'adopted' })
    expect(preparations.entries.slice(mark)).toEqual([{ trackIds: ['instrument'], state: 'ready' }])
  } finally { await controller.dispose() }
})

// Resume reports the sampled tracks of the graph it resumes, not those of the graph the session started with.
test('resume after a live publication adds a sampler reports the added track ready at the same frame', async () => {
  const fixture = createBridge('runtime-revision-progress')
  let desired: LivePlaybackSnapshotInput = input(longSourceTrack())
  const preparations = preparationLog()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => 'local_project', resolveSource: async () => longSourceDescriptor(),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
    onInstrumentPreparation: preparations.record,
  })
  try {
    expect(await controller.start(desired.transport)).toBe('started')
    acknowledgeStagedPublication(fixture)
    desired = { ...sampledNativeInput('sampler', 0.1), revision: 2, tracks: [longSourceTrack(), instrumentTrack] }
    expect(await controller.adoptSchedule(migrationIntent('sampled-add-resume-same'), true)).toEqual({ status: 'adopted' })
    await controller.pause(1)
    const mark = preparations.entries.length
    const epoch = fixture.transports.at(-1)?.epoch
    expect(await controller.start({ ...desired.transport, playheadSec: 1 })).toBe('started')
    expect(fixture.transports.at(-1)?.epoch).toBe(epoch)
    expect(preparations.entries.slice(mark)).toEqual([{ trackIds: ['instrument'], state: 'ready' }])
  } finally { await controller.dispose() }
})

test('resume after a live publication adds a sampler reports the added track ready at a new frame', async () => {
  const fixture = createBridge('runtime-revision-progress')
  let desired: LivePlaybackSnapshotInput = input(longSourceTrack())
  const preparations = preparationLog()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => 'local_project', resolveSource: async () => longSourceDescriptor(),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
    onInstrumentPreparation: preparations.record,
  })
  try {
    expect(await controller.start(desired.transport)).toBe('started')
    acknowledgeStagedPublication(fixture)
    desired = { ...sampledNativeInput('sampler', 0.1), revision: 2, tracks: [longSourceTrack(), instrumentTrack] }
    expect(await controller.adoptSchedule(migrationIntent('sampled-add-resume-new'), true)).toEqual({ status: 'adopted' })
    await controller.pause(1)
    const mark = preparations.entries.length
    const epoch = fixture.transports.at(-1)?.epoch
    expect(await controller.start({ ...desired.transport, playheadSec: 2 })).toBe('started')
    expect(fixture.transports.at(-1)?.epoch).not.toBe(epoch)
    expect(preparations.entries.slice(mark)).toEqual([{ trackIds: ['instrument'], state: 'ready' }])
  } finally { await controller.dispose() }
})

test('resume after a live publication removes a sampler does not report the removed track', async () => {
  const fixture = createBridge('runtime-revision-progress')
  let desired: LivePlaybackSnapshotInput = { ...sampledNativeInput('sampler', 0.1), tracks: [instrumentTrack, longSourceTrack()] }
  const preparations = preparationLog()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => 'local_project', resolveSource: async () => longSourceDescriptor(),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
    onInstrumentPreparation: preparations.record,
  })
  try {
    expect(await controller.start(desired.transport)).toBe('started')
    acknowledgeStagedPublication(fixture)
    desired = { ...input(longSourceTrack()), revision: 2 }
    expect(await controller.adoptSchedule(migrationIntent('sampled-remove-resume'), true)).toEqual({ status: 'adopted' })
    await controller.pause(1)
    const mark = preparations.entries.length
    expect(await controller.start({ ...desired.transport, playheadSec: 1 })).toBe('started')
    expect(preparations.entries.slice(mark)).toEqual([{ trackIds: [], state: 'ready' }])
  } finally { await controller.dispose() }
})

// AE-08 phase 8 step 8 (UD 7, D7): a paused prepared native session adopts an edit through its own host session. The
// graph is prepared and published with seam 0 (native applies it at the next block, a stopped transport included), then
// the schedule is re-primed by an epoch bump at the same frame.
const pausedNativeSession = async () => {
  const fixture = createBridge("runtime-revision-progress")
  let desired = nativeInstrumentInput()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => {
      const compiled = compileLivePlaybackSnapshot({ ...desired, transport })
      return compiled.supported
        ? { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } } : compiled
    },
  })
  expect(await controller.ensureLivePreview(0)).toBe("started")
  expect(controller.isPrepared()).toBe(true)
  expect(controller.isActive()).toBe(false)
  acknowledgeStagedPublication(fixture)
  const requestedFrames: bigint[] = []
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    requestedFrames.push(request.requestedPublicationFrame ?? 0n)
    return prepare(request)
  }
  return {
    fixture, controller, requestedFrames,
    edit: (next: LivePlaybackSnapshotInput) => { desired = next },
    base: nativeInstrumentInput(),
    mark: () => ({ calls: fixture.calls.length, transports: fixture.transports.length, coordinations: fixture.coordinations.length }),
  }
}
const hostLifecycleCalls = ["configure", "start", "stop", "teardown", "begin", "graph"]
// The adoption answers when native holds the bank; the priming epoch follows on later turns.
const primed = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
const scheduledNotes = (fixture: ReturnType<typeof createBridge>, epoch: number) => fixture.schedulePayloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  if (view.getUint32(4, true) !== epoch) return []
  return Array.from({ length: view.getUint32(44, true) }, (_, index) => ({
    type: view.getUint32(72 + index * 48 + 32, true), note: view.getUint32(72 + index * 48 + 40, true),
  })).filter(({ type }) => type === 1).map(({ note }) => note)
})
const editedMidi = (base: LivePlaybackSnapshotInput, notes: readonly { pitch: number; beat: number }[]): LivePlaybackSnapshotInput => ({
  ...base, revision: 2,
  tracks: base.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip,
    midi: clip.midi && { ...clip.midi, notes: notes.map(({ pitch, beat }) => ({ pitch, beat, length: 0.5, velocity: 0.8 })) } })) })),
})

describe("AE-08 phase 8 UD 7 paused native adoption", () => {
  test("W-UD7n-1 a paused note edit is adopted on the same host with seam 0, and Play resumes it with the new content", async () => {
    const s = await pausedNativeSession()
    try {
      const before = s.mark()
      const epoch = s.fixture.transports.at(-1)?.epoch ?? 0
      s.edit(editedMidi(s.base, [{ pitch: 60, beat: 0 }, { pitch: 64, beat: 1 }]))
      expect(await s.controller.adoptSchedule(migrationIntent("ud7n-note"), true)).toEqual({ status: "adopted" })
      await primed()
      const calls = s.fixture.calls.slice(before.calls)
      expect(calls.filter((call) => hostLifecycleCalls.includes(call))).toEqual([])
      expect(s.requestedFrames).toEqual([0n])
      expect(s.fixture.coordinations.length).toBe(before.coordinations)
      expect(s.fixture.calls.filter((call) => call === "start")).toHaveLength(1)
      expect(s.fixture.calls.filter((call) => call === "configure")).toHaveLength(1)
      expect(s.controller.isPrepared()).toBe(true)
      expect(s.controller.isActive()).toBe(false)
      const transports = s.fixture.transports.slice(before.transports)
      expect(transports.every((transport) => !transport.running && transport.frame === 0)).toBe(true)
      expect(transports.at(-1)?.epoch).toBe(epoch + 1)
      expect(scheduledNotes(s.fixture, epoch + 1)).toContain(64)
      expect(await s.controller.start({ ...s.base.transport, playheadSec: 0 })).toBe("started")
      expect(s.fixture.calls.filter((call) => call === "start")).toHaveLength(1)
      expect(s.fixture.calls.filter((call) => call === "configure")).toHaveLength(1)
      expect(s.fixture.transports.at(-1)).toMatchObject({ running: true, epoch: epoch + 1 })
      expect(s.controller.isActive()).toBe(true)
    } finally { await s.controller.dispose() }
  })

  // An undo is the previous state submitted as its own adoption once the edit's has settled and its epoch re-primed.
  test("W-UD7n-6 an undo applied after the edit settled is adopted in place on the same host, and its schedule is the original one", async () => {
    const s = await pausedNativeSession()
    try {
      const before = s.mark()
      const epoch = s.fixture.transports.at(-1)?.epoch ?? 0
      const original = scheduledNotes(s.fixture, epoch)
      s.edit(editedMidi(s.base, [{ pitch: 60, beat: 0 }, { pitch: 64, beat: 1 }]))
      expect(await s.controller.adoptSchedule(migrationIntent("ud7n-edit"), true)).toEqual({ status: "adopted" })
      await primed()
      expect(scheduledNotes(s.fixture, epoch + 1)).toContain(64)
      // The host accepts the next revision; the recorder is wrapped around its prepare again.
      acknowledgeStagedPublication(s.fixture, 3)
      const prepare = s.fixture.bridge.session.revisions.prepare
      s.fixture.bridge.session.revisions.prepare = async (request) => {
        s.requestedFrames.push(request.requestedPublicationFrame ?? 0n)
        return prepare(request)
      }
      s.edit({ ...s.base, revision: 3 })
      expect(await s.controller.adoptSchedule(migrationIntent("ud7n-undo"), true)).toEqual({ status: "adopted" })
      await primed()
      expect(s.fixture.calls.slice(before.calls).filter((call) => hostLifecycleCalls.includes(call))).toEqual([])
      expect(s.requestedFrames).toEqual([0n, 0n])
      expect(s.fixture.coordinations.length).toBe(before.coordinations)
      expect(s.fixture.calls.filter((call) => call === "start")).toHaveLength(1)
      expect(s.fixture.calls.filter((call) => call === "configure")).toHaveLength(1)
      expect(s.controller.isPrepared()).toBe(true)
      expect(s.controller.isActive()).toBe(false)
      expect(s.fixture.transports.at(-1)?.epoch).toBe(epoch + 2)
      expect(original.length).toBeGreaterThan(0)
      expect(scheduledNotes(s.fixture, epoch + 2)).toEqual(original)
    } finally { await s.controller.dispose() }
  })

  test("W-UD7n-2 a paused tempo edit is adopted with the new bpm on the re-primed epoch, never a running transport", async () => {
    const s = await pausedNativeSession()
    try {
      const before = s.mark()
      s.edit({ ...s.base, revision: 2, bpm: 90 })
      expect(await s.controller.adoptSchedule(migrationIntent("ud7n-tempo"), true)).toEqual({ status: "adopted" })
      await primed()
      expect(s.fixture.calls.slice(before.calls).filter((call) => hostLifecycleCalls.includes(call))).toEqual([])
      expect(s.requestedFrames).toEqual([0n])
      const transports = s.fixture.transportContexts.slice(before.transports)
      expect(transports.length).toBeGreaterThan(0)
      expect(transports.every((transport) => !transport.running)).toBe(true)
      expect(transports.at(-1)?.bpm).toBe(90)
      expect(s.controller.isActive()).toBe(false)
    } finally { await s.controller.dispose() }
  })

  // UD 8 / M5: a refused publication keeps the session and the old graph; the next submission of the intent adopts.
  test("W-UD7n-3 a refused paused publication keeps the session, and the resubmitted intent adopts", async () => {
    const s = await pausedNativeSession()
    try {
      const prepare = s.fixture.bridge.session.revisions.prepare
      let refuse = true
      s.fixture.bridge.session.revisions.prepare = async (request) => refuse
        ? { ok: false, kind: "refused", error: "prepare refused" } : prepare(request)
      const before = s.mark()
      s.edit(editedMidi(s.base, [{ pitch: 60, beat: 0 }, { pitch: 64, beat: 1 }]))
      expect(await s.controller.adoptSchedule(migrationIntent("ud7n-refused"), true)).toMatchObject({ status: "failed" })
      expect(s.controller.isPrepared()).toBe(true)
      expect(s.controller.isActive()).toBe(false)
      expect(s.fixture.calls.slice(before.calls).filter((call) => hostLifecycleCalls.includes(call))).toEqual([])
      refuse = false
      expect(await s.controller.adoptSchedule(migrationIntent("ud7n-refused"), true)).toEqual({ status: "adopted" })
      expect(s.fixture.calls.filter((call) => call === "start")).toHaveLength(1)
    } finally { await s.controller.dispose() }
  })

  // E6 (f30dda48): a limitation is no fault. While paused it settles the same way: nothing is prepared, the session stays.
  test("W-UD7n-4 a paused edit that hits an E6 limitation settles as unsupported, with no fault and the device notice", async () => {
    const s = await pausedNativeSession()
    try {
      const before = s.mark()
      const base = s.base
      s.edit({ ...base, revision: 2, tracks: base.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip,
        midi: clip.midi && { ...clip.midi, mappings: [{ id: "mapping", source: { kind: "cc", controller: 1, channel: 1 },
          target: { parameterId: "gain" }, outputMin: 0, outputMax: 1 }] } })) })) })
      const warned: unknown[][] = []
      const warn = console.warn
      console.warn = (...args: unknown[]) => { warned.push(args) }
      try {
        expect(await s.controller.adoptSchedule(migrationIntent("ud7n-e6"), true)).toMatchObject({ status: "unsupported" })
      } finally { console.warn = warn }
      // A deterministic limitation is logged once for the edit and is never retried.
      expect(warned.map(([message, detail]) => [message, detail])).toEqual([[
        "[native-live-edit] adoption not carried by the native graph yet; the playing graph is unchanged",
        { reason: "Native VST3 playback does not support MIDI expression automation yet." }]])
      expect(s.requestedFrames).toEqual([])
      expect(s.controller.isPrepared()).toBe(true)
      expect(s.fixture.calls.slice(before.calls).filter((call) => hostLifecycleCalls.includes(call))).toEqual([])
      // The mapping targets no device, so the track it sits on carries the notice.
      expect(instanceLimit(base.tracks[0]!.id)).toBe("Native VST3 playback does not support MIDI expression automation yet.")
    } finally { await s.controller.dispose() }
  })
})

const decodeNativeSourceEvents = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  const sourceOffset = 72 + instrumentCount * 48
  return Array.from({ length: sourceCount }, (_, index) => {
    const offset = sourceOffset + index * 112
    return {
      epoch: view.getUint32(4, true),
      assetId: view.getUint32(offset + 20, true),
      sequence: Number(view.getBigUint64(offset + 4, true)),
      startFrame: Number(view.getBigInt64(offset + 24, true)),
      stopFrame: Number(view.getBigInt64(offset + 32, true)),
      sourceOffsetFrame: Number(view.getBigUint64(offset + 40, true)),
    }
  })
})

const decodeNativeProcessorEvents = (payloads: readonly Uint8Array[]) => payloads.flatMap((payload) => {
  const view = new DataView(payload.buffer)
  const instrumentCount = view.getUint32(44, true)
  const sourceCount = view.getUint32(48, true)
  const processorCount = view.getUint32(56, true)
  const processorOffset = 72 + instrumentCount * 48 + sourceCount * 112
  return Array.from({ length: processorCount }, (_, index) => {
    const offset = processorOffset + index * 40
    return {
      epoch: view.getUint32(4, true),
      frame: Number(view.getBigUint64(offset + 16, true)),
      value: view.getFloat32(offset + 32, true),
    }
  })
})

test("commits a supported native session before starting and tears it down deterministically", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.legacyInstallCount).toBe(0)
  expect(fixture.mappedAssetCreateCount).toBe(1)
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport"])
  expect(fixture.transports.every(({ hasCycleStart, hasCycleEnd }) => !hasCycleStart && !hasCycleEnd)).toBe(true)
  await controller.dispose()
  expect(fixture.calls).toEqual([
    "begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport",
    "stop", "release", "teardown",
  ])
})

test("scheduler diagnostics are absent without playback and reset across sessions", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  expect(controller.schedulerDiagnostics()).toBeUndefined()
  expect(await controller.start(input().transport)).toBe("started")
  const first = controller.schedulerDiagnostics()
  expect(first).toBeDefined()
  expect(first?.compileCount).toBeGreaterThan(0)
  expect(first?.compileTotalMs).toBeGreaterThanOrEqual(first?.compileMaxMs ?? 0)
  await controller.dispose()
  expect(controller.schedulerDiagnostics()).toBeUndefined()
  expect(await controller.start(input().transport)).toBe("started")
  const second = controller.schedulerDiagnostics()
  expect(second).toBeDefined()
  expect(second).not.toBe(first)
  expect(second?.compileCount).toBeGreaterThan(0)
  await controller.dispose()
})

test("reports the bounded native start stage and sanitized failure", async () => {
  const fixture = createBridge("begin", false, false, "native failure /Users/secret/plugin.vst3")
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    reportUnavailable: true,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.start(input().transport)).resolves.toBe("unavailable")
  expect(faults).toEqual([
    "Native playback failed during begin-transaction: native failure <path>",
  ])
})

test("reports an abort-like compile failure unless playback ownership was cancelled", async () => {
  const fixture = createBridge()
  const compileEntered = Promise.withResolvers<void>()
  const compileAbortController = new AbortController()
  const faults: string[] = []
  const statuses: string[] = []
  const snapshotInput = sampledNativeInput("granular")
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => {
      compileEntered.resolve()
      return new Promise((resolve, reject) => {
        compileAbortController.signal.addEventListener("abort", () => {
          try {
            compileAbortController.signal.throwIfAborted()
          } catch (error) {
            reject(error)
          }
        }, { once: true })
      })
    },
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    onInstrumentPreparation: (_trackIds, status) => statuses.push(status.state),
  })

  const start = controller.start(snapshotInput.transport)
  await compileEntered.promise
  compileAbortController.abort()
  await expect(start).resolves.toBe("unavailable")

  expect(faults.some((message) => message.includes("Native playback failed during compile"))).toBe(true)
  expect(statuses).toEqual(["loading", "error"])
  await controller.destroy()
})

test("one play request waits for superseding sampled-instrument buffers before compiling", async () => {
  await createRoot(async (dispose) => {
    const fixture = createBridge()
    const firstApply = Promise.withResolvers<void>()
    const faults: string[] = []
    const statuses: string[] = []
    const paneErrors: string[] = []
    let replacementBuffers: string | undefined
    const state = createPersistedEffectState<undefined, string>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: (params) => params,
      applyToEngine: (_targetId, params) => {
        if (params === "superseded") return firstApply.promise.then(() => "applied")
        replacementBuffers = params
        return "applied";
      },
      persistParams: () => ({ kind: "committed-unordered" }),
    })
    state.setForTarget("track-1", "superseded")
    const snapshotInput = sampledNativeInput("granular")
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async (transport) => {
        await state.flushPending()
        if (replacementBuffers !== "replacement") {
          throw new Error("The replacement sampled-instrument buffers were not applied.")
        }
        return compileLivePlaybackSnapshot({ ...snapshotInput, transport })
      },
      reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      onInstrumentPreparation: (_trackIds, status) => {
        statuses.push(status.state)
        if (status.state === "error") paneErrors.push(status.error ?? "")
      },
    })

    const play = controller.start(snapshotInput.transport)
    state.setForTarget("track-1", "replacement")
    firstApply.reject(new SampledInstrumentSyncSupersededError(Promise.resolve("applied")))
    await expect(play).resolves.toBe("started")

    expect(replacementBuffers).toBe("replacement")
    expect(faults).toEqual([])
    expect(statuses).toEqual(["loading", "ready"])
    expect(paneErrors).toEqual([])
    await controller.destroy()
    dispose()
  })
})

test("reports a genuine sampled-instrument replacement failure during playback compile", async () => {
  await createRoot(async (dispose) => {
    const fixture = createBridge()
    const firstApply = Promise.withResolvers<void>()
    const replacementSync = Promise.withResolvers<void>()
    const faults: string[] = []
    const applyErrors: unknown[] = []
    const state = createPersistedEffectState<undefined, string>({
      targetId: () => "track-1",
      row: () => undefined,
      readQueryParams: () => undefined,
      createInitialParams: () => undefined,
      serializeParams: (params) => params,
      applyToEngine: (_targetId, params) => {
        if (params === "superseded") return firstApply.promise.then(() => "applied")
        throw new Error("Replacement buffer decode failed.")
      },
      persistParams: () => ({ kind: "committed-unordered" }),
      onReleaseFailed: (cause) => applyErrors.push(cause),
    })
    state.setForTarget("track-1", "superseded")
    const snapshotInput = sampledNativeInput("granular")
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async () => {
        await state.flushPending()
        return compileLivePlaybackSnapshot(snapshotInput)
      },
      reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      reportUnavailable: true,
    })

    const play = controller.start(snapshotInput.transport)
    state.setForTarget("track-1", "replacement")
    firstApply.reject(new SampledInstrumentSyncSupersededError(replacementSync.promise.then(() => "applied")))
    replacementSync.reject(new Error("Replacement buffer decode failed."))
    await expect(play).resolves.toBe("unavailable")

    expect(faults.some((message) => message.includes("Replacement buffer decode failed."))).toBe(true)
    // The superseded release follows the replacement to its failure, and the replacement release fails on its own.
    expect(applyErrors).toHaveLength(2)
    await controller.destroy()
    dispose()
  })
})

test("starts a mapped session from persisted ordinary metadata without an eager buffer", async () => {
  const fixture = createBridge()
  const track = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      buffer: null,
      sourceDurationSec: 1 / 48_000,
      sourceSampleRate: 48_000,
      sourceChannelCount: 1,
    }],
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input(track)),
    resolveSource: async () => createAudioPcmSourceDescriptor({
      identity: "test:ordinary-source",
      durationSec: 1 / 48_000,
      frameCount: 1,
      sampleRate: 48_000,
      channelCount: 1,
      source: new TestAudioBuffer([new Float32Array(1)]),
    }),
  })

  await expect(controller.start(input(track).transport)).resolves.toBe("started")
  expect(fixture.legacyInstallCount).toBe(0)
  expect(fixture.mappedAssetCreateCount).toBe(1)
  await controller.dispose()
})

test("forwards compile context when promoting a pending preview to play", async () => {
  const fixture = createBridge()
  const previewGate = Promise.withResolvers<void>()
  const contexts: unknown[] = []
  let compilation = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport, context) => {
      contexts.push(context)
      compilation += 1
      if (compilation === 1) await previewGate.promise
      return compileLivePlaybackSnapshot({ ...input(), transport })
    },
  })
  const compileContext = {
    instrumentOverride: {
      targetId: "track-1",
      instrument: {
        kind: "drum-rack",
        instanceId: "drum-rack:replacement",
        params: createDefaultDrumRackParams(),
      },
    },
  } satisfies LivePlaybackCompileContext

  const preview = controller.ensureLivePreview(0)
  const play = controller.start(input().transport, compileContext)
  previewGate.resolve()
  await expect(preview).resolves.toBe("started")
  await expect(play).resolves.toBe("started")
  expect(contexts).toEqual([undefined, compileContext])
})

test("starts play after a pending preview fails", async () => {
  const fixture = createBridge()
  const previewGate = Promise.withResolvers<void>()
  let compilation = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => {
      compilation += 1
      if (compilation === 1) {
        await previewGate.promise
        throw new Error("preview compilation failed")
      }
      return compileLivePlaybackSnapshot({ ...input(), transport })
    },
  })

  const preview = controller.ensureLivePreview(0)
  const play = controller.start(input().transport)
  previewGate.resolve()
  await expect(preview).resolves.toBe("unavailable")
  await expect(play).resolves.toBe("started")
  expect(compilation).toBe(2)
  await controller.dispose()
})

test("B6d5 a Play chained on a pending preview never runs once the pending start is cancelled", async () => {
  const fixture = createBridge()
  const previewGate = Promise.withResolvers<void>()
  let compilation = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => {
      compilation += 1
      if (compilation === 1) await previewGate.promise
      return compileLivePlaybackSnapshot({ ...input(), transport })
    },
  })

  const preview = controller.ensureLivePreview(0)
  const play = controller.start({ ...input().transport, playheadSec: 1 })
  const cancelled = controller.cancelPendingStart()
  previewGate.resolve()
  await cancelled
  const answers = { preview: await preview, play: await play }
  console.log("B6D5-CANCELLED-CHAINED-PLAY", JSON.stringify({ answers, compilation, active: controller.isActive(),
    transports: fixture.transports }))
  expect(answers.play).toBe("unavailable")
  expect(fixture.transports.filter(transport => transport.running)).toEqual([])
  expect(controller.isActive()).toBeFalse()
  expect(compilation).toBe(1)
  await controller.dispose()
})
test("supersedes an in-flight contextless preview for an inserted native processor", async () => {
  const fixture = createBridge()
  const previewGate = Promise.withResolvers<void>()
  const contexts: Array<LivePlaybackCompileContext | undefined> = []
  let compilation = 0
  const inserted = insertedExternalProcessor()
  const compileContext = {
    externalProcessor: {
      projectId: "project",
      processor: inserted,
    },
  } satisfies LivePlaybackCompileContext
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "project",
    resolveSource: async () => longSourceDescriptor(),
    compileSnapshot: async (transport, context) => {
      contexts.push(context)
      compilation += 1
      if (compilation === 1) await previewGate.promise
      const result = compileLivePlaybackSnapshot({
        ...input(longSourceTrack()),
        transport,
      })
      if (!result.supported) return result
      return context?.externalProcessor
        ? {
          supported: true as const,
          snapshot: {
            ...result.snapshot,
            nativeExternalAttachmentPlan: nativeAttachmentPlan,
            requiresNativePlayback: true,
          },
        }
        : result
    },
  })

  const stalePreview = controller.ensureLivePreview(0)
  await Bun.sleep(0)
  const insertedPreview = controller.ensureLivePreview(0, compileContext)
  previewGate.resolve()

  await expect(stalePreview).resolves.toBe("unavailable")
  await expect(insertedPreview).resolves.toBe("started")
  expect(contexts).toEqual([undefined, compileContext])
  expect(fixture.calls.filter((call) => call === "coordinate")).toHaveLength(1)
  await controller.dispose()
})

test("re-enables canonical external automation against the prepared attachment", async () => {
  const fixture = createBridge()
  const inserted = insertedExternalProcessor()
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "project",
    resolveSource: async () => longSourceDescriptor(),
    compileSnapshot: async (transport) => {
      const result = compileLivePlaybackSnapshot({
        ...input(longSourceTrack()),
        transport,
      })
      if (!result.supported) return result
      return {
        supported: true as const,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          requiresNativePlayback: true,
        },
      }
    },
  })

  await expect(controller.ensureLivePreview(0, {
    externalProcessor: {
      projectId: "project",
      processor: inserted,
    },
  })).resolves.toBe("started")
  await expect(controller.reenableProcessorAutomation(
    inserted.instanceId,
    [externalAutomationParameterId(inserted.instanceId, 7)],
  )).resolves.toMatchObject({ accepted: true })

  expect(fixture.reenablePayloads).toHaveLength(1)
  const payload = fixture.reenablePayloads[0]!
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const instanceByteLength = view.getUint32(0, true)
  expect(new TextDecoder().decode(payload.subarray(4, 4 + instanceByteLength))).toBe(inserted.instanceId)
  expect(view.getUint32(4 + instanceByteLength, true)).toBe(1)
  expect(view.getUint32(8 + instanceByteLength, true)).toBe(7)
  await expect(controller.reenableProcessorAutomation(
    inserted.instanceId,
    [externalAutomationParameterId(inserted.instanceId, 8)],
  )).resolves.toEqual({ accepted: false, reason: "unsupported" })
  await expect(controller.reenableProcessorAutomation(
    inserted.instanceId,
    [externalAutomationParameterId("22222222-2222-4222-8222-222222222222", 7)],
  )).resolves.toEqual({ accepted: false, reason: "unsupported" })
  expect(fixture.reenablePayloads).toHaveLength(1)
  await controller.dispose()
})

test("deduplicates identical contextless preview requests", async () => {
  const fixture = createBridge()
  const previewGate = Promise.withResolvers<void>()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => {
      await previewGate.promise
      return compileLivePlaybackSnapshot({ ...input(), transport })
    },
  })

  const first = controller.ensureLivePreview(0)
  const second = controller.ensureLivePreview(0)
  expect(second).toBe(first)
  previewGate.resolve()
  await expect(Promise.all([first, second])).resolves.toEqual(["started", "started"])
  await controller.dispose()
})

test("prepares enabled Stretch clips before publishing the native graph", async () => {
  const fixture = createBridge(undefined, false, false, "failed", 48_000)
  const faults: string[] = []
  const stretchBuffer = new TestAudioBuffer([
    new Float32Array(108_600),
    new Float32Array(108_600),
  ], 44_100)
  const stretchTrack: RuntimeTrack = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      duration: 2.462585,
      buffer: stretchBuffer,
      sourceDurationSec: 2.462585,
      sourceSampleRate: 44_100,
      sourceChannelCount: 2,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 200 },
    }],
  }
  const stretchInput = {
    ...input(stretchTrack),
    tracks: [
      stretchTrack,
      { id: "empty", name: "Empty", volume: 1, clips: [] },
    ],
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectGeneration: () => 0,
    createBuffer: (channels, frames, sampleRate) => new TestAudioBuffer(
      Array.from({ length: channels }, () => new Float32Array(frames)),
      sampleRate,
    ),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    reportUnavailable: true,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...stretchInput,
      transport,
    }),
  })

  const result = await controller.start(stretchInput.transport)
  expect(result).toBe("started")
  expect(faults).toEqual([])
  expect(fixture.calls).toContain("install")
  expect(fixture.calls).toContain("graph")
  expect(fixture.installedAssets).toHaveLength(1)
  expect(fixture.installedAssets[0]).toMatchObject({
    frameCount: stretchBuffer.length,
    sampleRateHz: stretchBuffer.sampleRate,
    channelCount: 2,
  })
  expect(fixture.installedAssets[0]?.planarPcm.byteLength).toBe(0)
  await controller.dispose()
})

test("fails closed before opening a native transaction when bounded storage is unavailable", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  // Restore the exact descriptors: a non-writable restored global would block later
  // test files from installing their own IndexedDB fake.
  const previousIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { ...globalThis.navigator, locks: undefined },
  })
  try {
    const controller = createObservedController({
      bridge: fixture.bridge,
      createBuffer: () => new TestAudioBuffer(),
      reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      reportUnavailable: true,
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
        ...inputWithRawAssetsAndStretch(0),
        transport,
      }),
    })

    expect(await controller.start(input().transport)).toBe("unavailable")
    expect(fixture.calls).not.toContain("begin")
    expect(faults[0]).toContain("requires IndexedDB and cross-realm Web Locks")
    await controller.destroy()
  } finally {
    if (previousIndexedDb) Object.defineProperty(globalThis, "indexedDB", previousIndexedDb)
    else Reflect.deleteProperty(globalThis, "indexedDB")
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})

test("does not begin a native transaction when Stretch preparation fails", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const stretchTrack: RuntimeTrack = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 120 },
      buffer: new TestAudioBuffer([
        new Float32Array(48_000),
        new Float32Array(48_000),
        new Float32Array(48_000),
      ]),
    }],
  }
  const compiled = compileLivePlaybackSnapshot(input(stretchTrack))
  if (!compiled.supported) throw new Error(compiled.reasons.join(" "))
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectGeneration: () => 1,
    createBuffer: () => {
      throw new Error("buffer creation unavailable")
    },
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    compileSnapshot: async () => ({
      supported: true as const,
      snapshot: {
        ...compiled.snapshot,
        nativeExternalAttachmentPlan: nativeAttachmentPlan,
        requiresNativePlayback: true,
      },
    }),
  })

  expect(await controller.start(compiled.snapshot.transport)).toBe("blocked")
  expect(fixture.calls).toEqual([])
  expect(faults[0]).toContain("only mono and stereo assets are supported")
})

test("rejects the 65th native asset after final projection", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const snapshotInput = inputWithRawAssetsAndStretch(64)
  let createBufferCalls = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    createBuffer: () => {
      createBufferCalls += 1
      return new TestAudioBuffer()
    },
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    reportUnavailable: true,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...snapshotInput,
      transport,
    }),
  })

  expect(await controller.start(snapshotInput.transport)).toBe("unavailable")
  expect(createBufferCalls).toBe(0)
  expect(fixture.calls).toEqual([])
  expect(faults[0]).toContain("installed audio asset capacity")
})

test("accepts an expanded session at the 64-asset native boundary", async () => {
  const fixture = createBridge()
  let snapshotInput = inputWithRawAssetsAndStretch(63)
  const controller = createObservedController({
    bridge: fixture.bridge,
    createBuffer: (channels, frames, sampleRate) => new TestAudioBuffer(
      Array.from({ length: channels }, () => new Float32Array(frames)),
      sampleRate,
    ),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...snapshotInput,
      transport,
    }),
  })

  expect(await controller.start(snapshotInput.transport)).toBe("started")
  expect(fixture.installedAssets).toHaveLength(64)
  const before = fixture.calls.length
  snapshotInput = inputWithRawAssetsAndStretch(64)
  expect(await controller.adoptSchedule(migrationIntent("asset-boundary"), true)).toMatchObject({
    status: "failed", reason: "Native snapshot exceeds installed audio asset capacity.",
  })
  expect(controller.isActive()).toBe(true)
  expect(fixture.calls.slice(before).filter((call) => ["begin", "stop", "graph"].includes(call))).toEqual([])
  await controller.dispose()
})

// AE-08 phase 8 step 10: an edit the native graph cannot carry is a failed adoption, never a stop or a dialog: the playing
// graph stays, nothing reaches the host and no fault is reported (UD 8).
test("W-FB-4 a support error and a capacity overflow answer failed and keep the session with no fault", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  let mode: "carried" | "capacity" | "missing-plan" = "carried"
  const controller = createObservedController({
    bridge: fixture.bridge,
    createBuffer: (channels, frames, sampleRate) => new TestAudioBuffer(Array.from({ length: channels }, () => new Float32Array(frames)), sampleRate),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    compileSnapshot: async (transport) => {
      const compiled = compileLivePlaybackSnapshot({ ...inputWithRawAssetsAndStretch(mode === "capacity" ? 64 : 63), transport })
      return compiled.supported && mode === "missing-plan"
        ? { ...compiled, snapshot: { ...compiled.snapshot, requiresNativePlayback: true } } : compiled
    },
  })
  try {
    expect(await controller.start(inputWithRawAssetsAndStretch(63).transport)).toBe("started")
    const before = fixture.calls.length
    mode = "capacity"
    const capacity = await controller.adoptSchedule(migrationIntent("fb4-capacity"), true)
    mode = "missing-plan"
    const missingPlan = await controller.adoptSchedule(migrationIntent("fb4-missing-plan"), true)
    const outcomes = { capacity, "missing-plan": missingPlan }
    expect({ outcomes, active: controller.isActive(), faults,
      host: fixture.calls.slice(before).filter((call) => ["begin", "stop", "graph", "teardown", "revision-prepare"].includes(call)) })
      .toMatchObject({ outcomes: { capacity: { status: "failed" }, "missing-plan": { status: "failed", reason: "The active VST3 attachment plan is unavailable." } },
        active: true, faults: [], host: [] })
  } finally { await controller.dispose() }
})

test("uses native prepared Stretch playback without an output buffer factory", async () => {
  const fixture = createBridge("runtime-revision-progress")
  const faults: string[] = []
  const stretchTrack: RuntimeTrack = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      buffer: new TestAudioBuffer([new Float32Array(48_000), new Float32Array(48_000)]),
      duration: 1,
      sourceDurationSec: 1,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 200 },
    }],
  }
  let desiredInput = input(stretchTrack)
  const compiled = compileLivePlaybackSnapshot(desiredInput)
  if (!compiled.supported) throw new Error(compiled.reasons.join(" "))
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "local_project",
    getProjectGeneration: () => 0,
    createBuffer: () => {
      throw new Error("buffer creation unavailable")
    },
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    reportUnavailable: true,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desiredInput, transport }),
  })

  expect(await controller.start(compiled.snapshot.transport)).toBe("started")
  expect(fixture.calls).toContain("install")
  expect(faults).toEqual([])
  const originalAssetId = fixture.installedAssets[0]?.sessionAssetId
  const before = fixture.calls.length
  desiredInput = { ...desiredInput, revision: 2, bpm: 130 }
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-9")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

  acknowledgeStagedPublication(fixture)
  expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
  expect(fixture.installedAssets.at(-1)?.sessionAssetId).not.toBe(originalAssetId)
  expect(fixture.calls.slice(before).filter((call) => ["graph", "stop", "teardown", "begin"].includes(call))).toEqual([])
  expect(controller.isActive()).toBe(true)
  expect(faults).toEqual([])
  await controller.dispose()
})

test("candidate cancellation retires outstanding Stretch page reads before releasing leases", async () => {
  const fixture = createBridge("runtime-revision-progress")
  let desired = input()
  const entered = Promise.withResolvers<void>()
  const finishRead = Promise.withResolvers<void>()
  let hold = false
  let readRetired = false
  let released = false
  const repository = createPreparedStretchArtifactRepository()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    createPreparedStretchRepository: () => ({
      ...repository,
      read: async function* (...args) {
        if (hold) { entered.resolve(); await finishRead.promise }
        try { yield* repository.read(...args) } finally { readRetired = true }
      },
      acquireLease: async (manifest) => {
        const lease = await repository.acquireLease(manifest)
        return { ...lease, release: async () => {
          released = true
          expect(readRetired).toBe(true)
          await lease.release()
        } }
      },
    }),
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
  })
  try {
    expect(await controller.start(desired.transport)).toBe("started")
    desired = input({ ...sourceTrack(), clips: [{ ...sourceTrack().clips[0]!,
      buffer: new TestAudioBuffer([new Float32Array(48_000), new Float32Array(48_000)]),
      duration: 1, sourceDurationSec: 1,
      audioWarp: { enabled: true, mode: "stretch", sourceBpm: 200 } }] })
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-10")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    acknowledgeStagedPublication(fixture)
    hold = true
    const publication = (candidateCompile.release(), candidateAdoption)
    await entered.promise
    const pause = controller.pause(0)
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
    expect(released).toBe(false)
    finishRead.resolve()
    expect((await publication).status).not.toBe("adopted")
    await pause
    expect(readRetired).toBe(true)
    expect(released).toBe(true)
  } finally { finishRead.resolve(); await controller.destroy() }
})

for (const intent of ["drop", "seek", "pause", "project"]) {
  test(`candidate Stretch ${intent} aborts held rendering and releases acquired leases`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    let desired = input()
    const entered = Promise.withResolvers<void>()
    let renderSignal: AbortSignal | undefined
    let leases = 0
    let releases = 0
    const leaseReleased = Promise.withResolvers<void>()
    const repository = createPreparedStretchArtifactRepository()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      createPreparedStretchRepository: () => ({
        ...repository,
        acquireLease: async (manifest) => {
          const lease = await repository.acquireLease(manifest)
          leases++
          return { ...lease, release: async () => {
            releases++; await lease.release(); leaseReleased.resolve()
          } }
        },
      }),
      createStretchCache: (options) => {
        const cache = createAudioStretchCache(options)
        return { ...cache, renderArtifactNow: async (clip, bpm, signal) => {
          if (clip.id !== "held") return cache.renderArtifactNow(clip, bpm, signal)
          renderSignal = signal
          entered.resolve()
          return new Promise<never>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        } }
      },
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
    })
    try {
      expect(await controller.start(desired.transport)).toBe("started")
      const clip = { ...sourceTrack().clips[0]!,
        buffer: new TestAudioBuffer([new Float32Array(48_000), new Float32Array(48_000)]),
        duration: 1, sourceDurationSec: 1,
        audioWarp: { enabled: true, mode: "stretch", sourceBpm: 200 } satisfies NonNullable<RuntimeTrack["clips"][number]["audioWarp"]> }
      desired = input({ ...sourceTrack(), clips: [{ ...clip, id: "leased" }, { ...clip, id: "held", startSec: 2 }] })
      const pending = controller.adoptSchedule(migrationIntent(`stretch-${intent}`), true)
      await entered.promise
      expect(leases).toBe(1)
      // A public schedule remains desired after seek. Its retry must compile the
      // new empty model, not restart the abandoned held Stretch render.
      if (intent === "seek") {
        desired = input()
        acknowledgeStagedPublication(fixture)
      }
      if (intent === "seek") await controller.seekPrepared(0.25)
      else if (intent === "pause") {
        await controller.pause(0.25)
        // A paused session adopts the intent the pause interrupted, as it adopts any paused edit. The hook drops the
        // playing intents when playback stops; the retry in the paused domain is not the subject here.
        controller.dropAdoptionIntents()
      } else if (intent === "project") await controller.dispose()
      else controller.dropAdoptionIntents()
      expect(renderSignal?.aborted).toBe(true)
      expect(await pending).toMatchObject({ status: intent === "seek" ? "adopted" : "superseded" })
      await leaseReleased.promise
      expect(releases).toBe(leases)
      if (intent !== "project") {
        desired = input()
        if (intent === "pause") await controller.start(desired.transport)
        acknowledgeStagedPublication(fixture)
        expect(await controller.adoptSchedule(migrationIntent(`stretch-${intent}-next`), true)).toEqual({ status: "adopted" })
        expect(controller.isActive()).toBe(true)
      }
    } finally { await controller.destroy() }
  })
}

test("rebuilds a fresh paused native session with a new transport epoch", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.ensureLivePreview(2)).resolves.toBe("started")
  await controller.dispose()
  await expect(controller.ensureLivePreview(2)).resolves.toBe("started")

  expect(fixture.transports.map((transport) => ({
    epoch: transport.epoch,
    frame: transport.frame,
    running: transport.running,
  }))).toEqual([
    { epoch: 1, frame: 0, running: false },
    { epoch: 2, frame: 0, running: false },
  ])
  expect(controller.isActive()).toBeFalse()
  await controller.dispose()
})

// B6 failure inventory: obsolete-epoch send/proof, forgotten second retarget,
// duplicate dispatch/answer, replacement lineage, stale seek reactivation,
// timer rescue, and resources/subscriptions left behind.
test("B6 unsent parameter record follows overlapping paused seek and start into the second domain", async () => {
  const events: unknown[] = []
  const hostFailures: string[] = []
  const h = createFuzzHost(event => events.push(event), undefined, false,
    (invariant, detail) => hostFailures.push(`${invariant}: ${detail}`), () => {})
  const base = utilityPlaybackInput()
  const registry = createProcessorEditRegistry(() => 120)
  registry.observe(base.renderState.fx)
  let compiles = 0
  const dispatches: { editId: string; sequence: bigint }[] = []
  const answers: ProcessorDeliveryOutcome[] = []
  const receipts: { phase: string; answers: number; sends: number; epoch: number }[] = []
  const batches: Uint8Array[] = []
  const transports: NativeHostTransport[] = []
  const sendTransport = h.bridge.session.setTransport
  h.bridge.session.setTransport = transport => {
    transports.push(transport)
    return sendTransport(transport)
  }
  const queueParameters = h.bridge.session.queueParameterEvents
  h.bridge.session.queueParameterEvents = bytes => {
    batches.push(bytes.slice())
    return queueParameters(bytes)
  }
  let observeProgress: ((progress: NativeScheduleProgress) => void) | undefined
  const subscriptions = { progress: 0, loss: 0 }
  const subscribe = h.bridge.session.onScheduleProgress
  h.bridge.session.onScheduleProgress = listener => {
    observeProgress = listener
    subscriptions.progress++
    const unsubscribe = subscribe(listener)
    return () => { subscriptions.progress--; unsubscribe() }
  }
  const subscribeLoss = h.bridge.session.onLoss
  h.bridge.session.onLoss = listener => {
    subscriptions.loss++
    const unsubscribe = subscribeLoss(listener)
    return () => { subscriptions.loss--; unsubscribe() }
  }
  const controller = createNativePlaybackController({
    bridge: h.bridge, getProjectId: () => "fixture-project", getProjectGeneration: () => 1,
    getProcessorTarget: registry.target,
    compileSnapshot: async transport => {
      compiles++
      return compileLivePlaybackSnapshot({ ...base, transport })
    },
    onProcessorDispatch: event => dispatches.push(event),
  })
  const turns = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
  const act = async (action: Parameters<typeof h.act>[0]) => {
    h.act(action, [], h.lose, () => {})
    await turns()
  }
  // A finite native scheduler, not a wall-clock wait or a product rescue.
  const drive = async () => {
    let callbacks = 0
    for (let step = 0; step < 600; step++) {
      const enabled = h.enabled([])
      const control = enabled.find(action => action.kind === "control-wake" || action.kind === "deliver-reply")
      if (control) { callbacks = 0; await act(control) }
      else if (!h.started) return
      else if (callbacks++ < 4 || h.transport || h.controls.length || h.progressSequence > h.deliveredProgressSequence) {
        await act({ kind: "render-block" })
        await act({ kind: "deliver-progress" })
      } else return
    }
    throw new Error("B6 native scheduler exhausted its finite action budget")
  }
  const nativeControl = async (name: string) => {
    const command = h.commands.find(command => command.name === name)
    if (!command) throw new Error(`B6 missing native ${name} command`)
    await act({ kind: "control-wake", id: command.id })
  }
  const nativeReply = async (name: string) => {
    const reply = h.replies.find(reply => reply.name === name)
    if (!reply) throw new Error(`B6 missing native ${name} reply`)
    await act({ kind: "deliver-reply", id: reply.id })
  }
  const pending = () => {
    expect(dispatches).toHaveLength(0)
    expect(h.counts.get("parameters") ?? 0).toBe(0)
    expect(answers).toHaveLength(0)
  }
  const mark = (phase: string) => receipts.push({ phase, answers: answers.length,
    sends: dispatches.length, epoch: h.epoch })
  try {
    const preview = controller.ensureLivePreview(0)
    await turns(); await drive()
    expect(await preview).toBe("started")
    expect(transports.at(-1)?.frame).toBe(0)
    expect(controller.isActive()).toBe(false)
    const seek = controller.seekPrepared(0.25)
    await turns()
    expect(h.commands.find(command => command.name === "transport")).toBeDefined()
    const from = createDefaultUtilityParams()
    const edit = registry.allocate(utilityCommit("utility:1", from, { ...from, gainDb: -9 }))
    if (!edit) throw new Error("B6 missing Utility registry edit")
    const delivery = controller.deliverProcessor(edit)
    void delivery.settled.then(answer => answers.push(answer))
    await turns(); pending(); mark("first-domain-held")
    const play = controller.start({ ...base.transport, playheadSec: 0.5 })
    await turns()
    // The first transport is already in IPC. The second is queued by start,
    // proving the second public transition ran before the older seek answered.
    await nativeControl("transport")
    expect(h.transport).toMatchObject({ epoch: 2, frame: 12_000, running: false })
    await act({ kind: "render-block" })
    const firstProgress = h.progress
    if (!firstProgress || !observeProgress) throw new Error("B6 missing first-domain progress observer")
    expect(firstProgress.epoch).toBe(2)
    // A foreign urgent floor has no relationship to this unsent Utility batch.
    observeProgress({ ...firstProgress, appliedUrgentSequence: 999n, appliedProcessorSequence: 999n })
    await turns(); pending(); mark("old-progress-high-foreign-floor")
    await nativeReply("transport")
    await turns(); pending(); mark("old-seek-ack")
    await nativeControl("transport")
    expect(h.transport).toMatchObject({ epoch: 3, frame: 24_000, running: false })
    pending()
    await nativeReply("transport")
    await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
    await drive()
    expect(await seek).toBe("unavailable")
    expect(await play).toBe("started")
    expect(await delivery.settled).toEqual({ state: "applied" })
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]?.editId).toBe(edit.id)
    expect(registry.target("track", "utility:1")?.latest).toMatchObject({ id: edit.id, order: edit.order })
    expect(h.appliedBatches.size).toBe(1)
    expect(h.applications.filter(application => application.strategy === "parameters")).toMatchObject([{ epoch: 3 }])
    expect(h.nativeFields(h.active).gain).toBe(-9)
    expect(answers).toEqual([{ state: "applied" }])
    mark("second-domain-applied")
    // Decode the actual bytes at the bridge separately from the receipt.
    expect(batches).toHaveLength(1)
    const bytes = batches[0]
    if (!bytes) throw new Error("B6 missing parameter dispatch bytes")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(8, true)).toBe(3)
    expect(view.getBigUint64(12, true)).toBe(dispatches[0]?.sequence)
    expect(view.getFloat32(36, true)).toBe(-9)
    const frozen = { compiles, counts: Object.fromEntries(h.counts) }
    observeProgress(firstProgress)
    await turns()
    await act({ kind: "deliver-progress" })
    await turns()
    expect({ compiles, counts: Object.fromEntries(h.counts) }).toEqual(frozen)
    expect(answers).toHaveLength(1)
    expect(hostFailures).toEqual([])
    const stop = controller.dispose()
    await turns(); await drive(); await stop
    const leases = [...h.leases.values()].map(lease => ({ acquired: lease.acquisitions,
      released: lease.releases, owners: lease.owners.size, reclaimed: lease.reclaimed }))
    expect(leases).toEqual([{ acquired: 1, released: 1, owners: 0, reclaimed: true }])
    expect(h.pendingControl).toBeUndefined()
    expect(h.queuedSends).toHaveLength(0)
    expect(subscriptions).toEqual({ progress: 0, loss: 0 })
    console.log("B6-UNSENT-SECOND-DOMAIN", JSON.stringify({ epochs: [1, 2, 3],
      frames: [0, 12_000, 24_000], sends: dispatches.length, edit: { id: edit.id, order: edit.order },
      receipts, gain: -9, leases, subscriptions, compiles, counts: Object.fromEntries(h.counts) }))
  } finally {
    h.lose()
    await controller.dispose()
  }
})

// B6b refusal discriminator: a compile-held paused domain must not strand its
// refused parameter carrier, answer from an unrelated floor, or leak its compile.
test("B6 refused parameter record follows the paused domain into a differently positioned start", async () => {
  const hostFailures: string[] = []
  const h = createFuzzHost(() => {}, undefined, false,
    (invariant, detail) => hostFailures.push(`${invariant}: ${detail}`), () => {})
  const base = utilityPlaybackInput()
  const registry = createProcessorEditRegistry(() => 121)
  registry.observe(base.renderState.fx)
  const heldCompilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const dispatches: { editId: string; sequence: bigint }[] = []
  const batches: Uint8Array[] = []
  const queueParameters = h.bridge.session.queueParameterEvents
  h.bridge.session.queueParameterEvents = bytes => {
    batches.push(bytes.slice())
    return queueParameters(bytes)
  }
  const controller = createNativePlaybackController({
    bridge: h.bridge, getProjectId: () => "fixture-project", getProjectGeneration: () => 1,
    getProcessorTarget: registry.target,
    compileSnapshot: async (transport, context) => context?.liveAdoption
      ? heldCompilation.promise : compileLivePlaybackSnapshot({ ...base, transport }),
    onProcessorDispatch: event => dispatches.push(event),
  })
  const turns = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
  const act = async (action: Parameters<typeof h.act>[0]) => {
    h.act(action, [], h.lose, () => {})
    await turns()
  }
  // Finite explicit native callbacks, with no wall-clock rescue or compile release.
  const drive = async () => {
    for (let step = 0; step < 100; step++) {
      const control = h.enabled([]).find(action => action.kind === "control-wake"
        || action.kind === "deliver-reply" || action.kind === "publication-acknowledge")
      if (control) await act(control)
      else if (h.started) {
        await act({ kind: "render-block" })
        await act({ kind: "deliver-progress" })
      } else return
    }
  }
  try {
    const play = controller.start(base.transport)
    await turns(); await drive()
    expect(await play).toBe("started")
    const pause = controller.pause(0.25)
    await turns()
    let adoptionAnswer: unknown
    const adoption = controller.adoptSchedule(migrationIntent("b6-refused-paused-domain"), true)
    void adoption.then(answer => { adoptionAnswer = answer })
    await turns(); await drive(); await pause
    const pausedEpoch = h.epoch
    expect(controller.isActive()).toBe(false)
    h.refuseParameters = 1
    const from = createDefaultUtilityParams()
    const edit = registry.allocate(utilityCommit("utility:1", from, { ...from, gainDb: -6 }))
    if (!edit) throw new Error("B6 missing refused Utility edit")
    const answers: ProcessorDeliveryOutcome[] = []
    const delivery = controller.deliverProcessor(edit)
    void delivery.settled.then(answer => answers.push(answer))
    await turns(); await drive()
    expect(h.refuseParameters).toBe(0)
    expect(batches).toHaveLength(1)
    const refusedBytes = batches[0]
    if (!refusedBytes) throw new Error("B6 missing native-refused parameter bytes")
    expect(new DataView(refusedBytes.buffer, refusedBytes.byteOffset, refusedBytes.byteLength).getUint32(8, true)).toBe(pausedEpoch)
    expect(h.nativeFields(h.active).gain).toBe(0)
    expect(answers).toEqual([])
    expect(adoptionAnswer).toBeUndefined()
    const resumed = controller.start({ ...base.transport, playheadSec: 0.75 })
    await turns(); await drive()
    expect(await resumed).toBe("started")
    expect(h.epoch).toBe(pausedEpoch + 1)
    expect(h.nativeFields(h.active).gain).toBe(-6)
    expect(answers).toEqual([{ state: "applied" }])
    expect(batches).toHaveLength(2)
    const bytes = batches[1]
    if (!bytes) throw new Error("B6 refused carrier was not dispatched in the start domain")
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true)).toBe(h.epoch)
    expect(dispatches.map(event => event.editId)).toEqual([edit.id, edit.id])
    expect(registry.target("track", "utility:1")?.latest).toMatchObject({ id: edit.id, order: edit.order })
    expect(h.applications.filter(application => application.strategy === "parameters")).toMatchObject([{ epoch: h.epoch }])
    expect(adoptionAnswer).toBeUndefined()
    controller.dropAdoptionIntents()
    heldCompilation.resolve(compileLivePlaybackSnapshot(base))
    await turns(); await drive()
    expect(answers).toHaveLength(1)
    expect(batches).toHaveLength(2)
    console.log("B6-REFUSED-SECOND-DOMAIN", JSON.stringify({ epochs: [pausedEpoch, h.epoch],
      edit: { id: edit.id, order: edit.order }, dispatches: dispatches.length,
      answers, adoptionAnswer, gain: h.nativeFields(h.active).gain }))
    const stop = controller.dispose()
    await turns(); await drive(); await stop
    expect([...h.leases.values()].every(lease => lease.acquisitions === lease.releases && lease.owners.size === 0)).toBe(true)
    expect(h.pendingControl).toBeUndefined()
    expect(h.queuedSends).toHaveLength(0)
    expect(hostFailures).toEqual([])
  } finally {
    heldCompilation.resolve(compileLivePlaybackSnapshot(base))
    h.lose()
    await controller.dispose()
  }
})

// AE-08 phase 8 step 11d (D, UD 8): a paused adoption whose re-prime fails keeps the session and its graph. The failure is
// logged, the edit stays in the project, and the Play that follows primes it.
test("P8 a re-prime that fails after a paused adoption keeps the session and the next Play carries the edit", async () => {
  const h = createFuzzHost(() => {}, undefined, false, () => {}, () => {})
  const base = utilityPlaybackInput()
  let current = base
  let failTransport = false
  const bridge = { ...h.bridge, session: { ...h.bridge.session, setTransport: (value: Parameters<typeof h.bridge.session.setTransport>[0]) => {
    if (!failTransport) return h.bridge.session.setTransport(value)
    failTransport = false
    return Promise.resolve({ ok: false as const, error: "transport lost" })
  } } }
  const controller = createNativePlaybackController({
    bridge, getProjectId: () => "fixture-project", getProjectGeneration: () => 1,
    compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...current, transport }),
  })
  const warn = spyOn(console, "warn").mockImplementation(() => undefined)
  const turns = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
  const act = async (action: Parameters<typeof h.act>[0]) => {
    h.act(action, [], h.lose, () => {})
    await turns()
  }
  const drive = async () => {
    for (let step = 0; step < 200; step++) {
      const control = h.enabled([]).find(action => action.kind === "control-wake"
        || action.kind === "deliver-reply" || action.kind === "publication-acknowledge")
      if (control) await act(control)
      else if (h.started) {
        await act({ kind: "render-block" })
        await act({ kind: "deliver-progress" })
      } else return
    }
  }
  const count = (name: string) => h.counts.get(name) ?? 0
  try {
    const play = controller.start(base.transport)
    await turns(); await drive()
    expect(await play).toBe("started")
    const pause = controller.pause(0.25)
    await turns(); await drive(); await pause
    const before = { nodes: h.active?.nodes.size ?? 0, spawns: count("begin") + count("configure") + count("start"), teardowns: count("teardown") }
    current = { ...base, tracks: [...base.tracks, { ...base.tracks[0]!, id: "routed", clips: [] }] }
    failTransport = true
    const adopted = controller.adoptSchedule({ ...migrationIntent("d-reprime-failure"), schedule: "d-reprime-failure" })
    await turns(); await drive(); await adopted
    await turns(); await drive()
    expect({ prepared: controller.isPrepared(), teardowns: count("teardown") - before.teardowns, retried: failTransport,
      logged: warn.mock.calls.some(call => String(call[0]).includes("paused adoption")) })
      .toEqual({ prepared: true, teardowns: 0, retried: false, logged: true })
    const resumed = controller.start({ ...base.transport, playheadSec: 0.25 })
    await turns(); await drive()
    expect(await resumed).toBe("started")
    expect({ active: controller.isActive(), nodes: h.active?.nodes.size, spawns: count("begin") + count("configure") + count("start") })
      .toEqual({ active: true, nodes: before.nodes + 1, spawns: before.spawns })
  } finally {
    warn.mockRestore()
    h.lose()
    await controller.dispose()
  }
})

for (const submitted of [false, true]) {
  test(`P8 a routed track added while paused is adopted in place by the Play that resumes (edit ${submitted ? "submitted" : "not submitted"})`, async () => {
    const h = createFuzzHost(() => {}, undefined, false, () => {}, () => {})
    const base = utilityPlaybackInput()
    let current = base
    const controller = createNativePlaybackController({
      bridge: h.bridge, getProjectId: () => "fixture-project", getProjectGeneration: () => 1,
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...current, transport }),
    })
    const turns = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
    const act = async (action: Parameters<typeof h.act>[0]) => {
      h.act(action, [], h.lose, () => {})
      await turns()
    }
    const drive = async () => {
      for (let step = 0; step < 200; step++) {
        const control = h.enabled([]).find(action => action.kind === "control-wake"
          || action.kind === "deliver-reply" || action.kind === "publication-acknowledge")
        if (control) await act(control)
        else if (h.started) {
          await act({ kind: "render-block" })
          await act({ kind: "deliver-progress" })
        } else return
      }
    }
    const spawns = () => ["begin", "configure", "start"].reduce((sum, name) => sum + (h.counts.get(name) ?? 0), 0)
    try {
      const play = controller.start(base.transport)
      await turns(); await drive()
      expect(await play).toBe("started")
      const pause = controller.pause(0.25)
      await turns(); await drive(); await pause
      const before = { nodes: h.active?.nodes.size, spawns: spawns() }
      current = { ...base, tracks: [...base.tracks, { ...base.tracks[0]!, id: "routed", clips: [] }] }
      if (submitted) void controller.adoptSchedule({ ...migrationIntent("p8-routed-add"), schedule: "p8-routed-add" })
      const resumed = controller.start({ ...base.transport, playheadSec: 0.25 })
      await turns(); await drive()
      expect(await resumed).toBe("started")
      expect(controller.isActive()).toBe(true)
      expect(h.active?.nodes.size).toBe((before.nodes ?? 0) + 1)
      expect(spawns()).toBe(before.spawns)
    } finally {
      h.lose()
      await controller.dispose()
    }
  })
}

type B6dOwner = ReturnType<typeof createNativeProcessorStateOwner>
const b6dProgress = (revision: number, epoch: number, sequence: number, appliedProcessorSequence: number): NativeScheduleProgress => ({
  revision, epoch, progressSequence: BigInt(sequence), renderedThroughFrame: 512n, acceptedThroughFrame: 96_512n,
  lastAcceptedWindowId: 1n, appliedTransportTransitionId: BigInt(epoch), appliedUrgentSequence: 0n,
  appliedProcessorSequence: BigInt(appliedProcessorSequence), running: true, scheduleComplete: false,
  instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
})
const b6dInstalled = (gainDb: number) => ({ kindId: 1, state: new Uint8Array([0]), values: { gainDb } })
const b6dDeliver = (owner: B6dOwner, key: string, order: number, gainDb: number, epoch: number) => owner.deliver({
  key, editId: `${key}-${order}`, order, kindId: 1, incarnation: 1, epoch, values: { gainDb },
  desired: { id: `${key}-${order}`, order, target: { nodeId: "track", instanceId: key, kindId: 1, incarnation: 1 },
    content: { state: new Uint8Array([order]), values: { gainDb } }, bypassed: false, tailFrames: 0 },
})
// The controller's dispatch of one parameter delivery; a parked batch stays unsent until its epoch applies.
const b6dDispatch = (owner: B6dOwner, key: string, order: number, gainDb: number,
  binding: { epoch: number; revision: number }, sequence: number, parked = false) => {
  const { receipt, plan } = b6dDeliver(owner, key, order, gainDb, binding.epoch)
  if (plan.carrier !== "parameters") throw new Error(`B6d ${key} order ${order} planned ${plan.carrier}`)
  const execution = owner.register({ key, editId: `${key}-${order}`, order, kindId: 1, sequence,
    strategy: { kind: "parameters" }, values: plan.values, receipts: [receipt], spec: receipt.spec }, binding)
  if (!parked) owner.send(execution, sequence)
  return { execution, receipt }
}
const b6dResent = (reconciles: ReturnType<B6dOwner["observe"]>) => reconciles.flatMap(item => "resend" in item ? [item.resend] : [])

test("B6d restated adoption does not resend a batch a newer edit carries", () => {
  const owner = createNativeProcessorStateOwner()
  owner.configured(1, new Map([["fx", b6dInstalled(0)]]))
  const older = b6dDispatch(owner, "fx", 10, -6, { epoch: 1, revision: 1 }, 1)
  const newer = b6dDispatch(owner, "fx", 11, -12, { epoch: 1, revision: 1 }, 2)
  expect(older.receipt.answered).toEqual({ state: "superseded", by: 11 })
  const reconciles = owner.adopted(new Map([["fx", 1]]), new Set(), new Set(["fx"]), 1, () => false,
    new Map([["fx", { kindId: 1, state: new Uint8Array([9]), values: { gainDb: 0 } }]]))
  const resent = b6dResent(reconciles)
  expect(resent).toEqual([newer.execution])
  expect([...newer.execution.values]).toEqual([["gainDb", -12]])
  expect(older.execution.state).toBe("cancelled")
  // Cancelled once and never offered again: not by a recovery, not by a later frame.
  expect(b6dResent(owner.reoffer())).toEqual([])
  owner.rebind(newer.execution, { epoch: 1, revision: 2 }, 3)
  owner.send(newer.execution, 3)
  expect(b6dResent(owner.observe(b6dProgress(2, 1, 1, 3)))).toEqual([])
  expect(newer.execution.state).toBe("applied")
  expect(older.execution.state).toBe("cancelled")
  expect(newer.receipt.answered).toEqual({ state: "applied" })
})

test("B6d2 a restated adoption resends only the parameter a newer carrier left to an older batch", () => {
  const owner = createNativeProcessorStateOwner()
  owner.configured(1, new Map([["fx", { kindId: 1, state: new Uint8Array([0]), values: { gainDb: 0, pan: 0 } }]]))
  const both = owner.deliver({ key: "fx", editId: "fx-10", order: 10, kindId: 1, incarnation: 1, epoch: 1, values: { gainDb: -6, pan: 0.25 },
    desired: { id: "fx-10", order: 10, target: { nodeId: "track", instanceId: "fx", kindId: 1, incarnation: 1 },
      content: { state: new Uint8Array([10]), values: { gainDb: -6, pan: 0.25 } }, bypassed: false, tailFrames: 0 } })
  if (both.plan.carrier !== "parameters") throw new Error("B6d2 batch planned " + both.plan.carrier)
  const older = owner.register({ key: "fx", editId: "fx-10", order: 10, kindId: 1, sequence: 1, strategy: { kind: "parameters" },
    values: both.plan.values, receipts: [both.receipt], spec: both.receipt.spec }, { epoch: 1, revision: 1 })
  owner.send(older, 1)
  const newer = b6dDispatch(owner, "fx", 11, -12, { epoch: 1, revision: 1 }, 2)
  const resent = b6dResent(owner.adopted(new Map([["fx", 1]]), new Set(), new Set(["fx"]), 1, () => false,
    new Map([["fx", { kindId: 1, state: new Uint8Array([9]), values: { gainDb: 0, pan: 0 } }]])))
  expect(resent).toEqual([older, newer.execution])
  expect([...older.values]).toEqual([["pan", 0.25]])
  expect([...newer.execution.values]).toEqual([["gainDb", -12]])
  owner.rebind(older, { epoch: 1, revision: 2 }, 3)
  owner.send(older, 3)
  owner.observe(b6dProgress(2, 1, 1, 3))
  // The narrowed resend proves only what it carried: the dropped value is never answered as applied.
  expect(older.state).toBe("applied")
  expect(both.receipt.answered).not.toEqual({ state: "applied" })
  owner.rebind(newer.execution, { epoch: 1, revision: 2 }, 4)
  owner.send(newer.execution, 4)
  owner.observe(b6dProgress(2, 1, 2, 4))
  expect(newer.receipt.answered).toEqual({ state: "applied" })
})

test("B6d a batch sent before a latency publication is re-offered on the published revision", () => {
  const owner = createNativeProcessorStateOwner()
  owner.configured(1, new Map([["fx", b6dInstalled(0)], ["fy", b6dInstalled(0)]]))
  const applied = b6dDispatch(owner, "fx", 9, -3, { epoch: 1, revision: 1 }, 1)
  owner.observe(b6dProgress(1, 1, 1, 1))
  expect(applied.execution.state).toBe("applied")
  owner.prepared(2, () => true)
  // A frame of the successor settles its decision before Inspect proves it published.
  owner.observe(b6dProgress(2, 1, 2, 1))
  // The controller still stamps the revision it has adopted.
  const stranded = b6dDispatch(owner, "fx", 10, -6, { epoch: 1, revision: 1 }, 2)
  const restated = b6dDispatch(owner, "fy", 10, -6, { epoch: 1, revision: 1 }, 3)
  owner.published(2)
  const resent = b6dResent(owner.adopted(new Map([["fx", 1], ["fy", 1]]), new Set(), new Set(["fy"]), 1, () => false,
    new Map([["fy", { kindId: 1, state: new Uint8Array([2]), values: { gainDb: 0 } }]])))
  // Each stale batch exactly once, whichever recovery carries it; the applied one never.
  expect(resent.map(execution => execution.key).sort()).toEqual(["fx", "fy"])
  expect(new Set(resent).size).toBe(2)
  expect(resent).not.toContain(applied.execution)
  owner.rebind(stranded.execution, { epoch: 1, revision: 2 }, 4)
  owner.send(stranded.execution, 4)
  owner.rebind(restated.execution, { epoch: 1, revision: 2 }, 5)
  owner.send(restated.execution, 5)
  owner.observe(b6dProgress(2, 1, 3, 5))
  expect([stranded.execution.state, restated.execution.state]).toEqual(["applied", "applied"])
  expect([stranded.receipt.answered, restated.receipt.answered]).toEqual([{ state: "applied" }, { state: "applied" }])
})

test("B6d an adoption answers a request of an ended incarnation unavailable, never applied", () => {
  const owner = createNativeProcessorStateOwner()
  owner.configured(1, new Map([["fx", b6dInstalled(3)]]))
  // Submitted for incarnation 1; the published bank carries the target at incarnation 2, whose desired edit the owner has not seen.
  const ended = owner.deliver({ key: "fx", editId: "fx-6", order: 6, kindId: 1, incarnation: 1, epoch: 1, values: { gainDb: 0 } })
  expect(ended.receipt.answered).toBeUndefined()
  owner.adopted(new Map([["fx", 1]]), new Set(), new Set(), 5, () => true,
    new Map([["fx", { kindId: 1, state: new Uint8Array([0]), values: { gainDb: 0 }, incarnation: 2 }]]))
  expect(ended.receipt.answered).toEqual({ state: "unavailable" })
})

test("B6d a same-value release joining a parked unsent batch reaches native after the epoch applies", () => {
  const owner = createNativeProcessorStateOwner()
  owner.configured(1, new Map([["fx", b6dInstalled(-11)]]))
  const drag = b6dDispatch(owner, "fx", 71, -19, { epoch: 13, revision: 1 }, 1, true)
  const release = b6dDeliver(owner, "fx", 73, -19, 13)
  expect(release.plan).toEqual({ carrier: "none" })
  expect(release.receipt.carrier).toBe(drag.execution)
  const offered = b6dResent(owner.observe(b6dProgress(1, 13, 1, 0)))
  expect(offered).toEqual([drag.execution])
  expect([...drag.execution.values]).toEqual([["gainDb", -19]])
  owner.rebind(drag.execution, { epoch: 13, revision: 1 }, 2)
  owner.send(drag.execution, 2)
  owner.observe(b6dProgress(1, 13, 2, 2))
  expect(drag.execution.state).toBe("applied")
  expect([drag.receipt.answered, release.receipt.answered]).toEqual([{ state: "applied" }, { state: "applied" }])

  // A newer equal value with its own carrier still cancels the older parked batch.
  const control = createNativeProcessorStateOwner()
  control.configured(1, new Map([["fx", b6dInstalled(-11)]]))
  const parked = b6dDispatch(control, "fx", 71, -19, { epoch: 13, revision: 1 }, 1, true)
  const carried = b6dDispatch(control, "fx", 73, -19, { epoch: 14, revision: 1 }, 2, true)
  expect(b6dResent(control.observe(b6dProgress(1, 13, 1, 0)))).toEqual([])
  expect(parked.execution.state).toBe("cancelled")
  expect(carried.execution.state).toBe("queued")
})

test("B6d2 a receipt is not proven while an older sent batch with another value can still apply", () => {
  const owner = createNativeProcessorStateOwner()
  owner.configured(1, new Map([["fx", b6dInstalled(-11)]]))
  const restored = b6dDispatch(owner, "fx", 59, 0, { epoch: 13, revision: 1 }, 1)
  const dragged = b6dDispatch(owner, "fx", 60, -8, { epoch: 13, revision: 1 }, 2)
  // A pause moved the domain; the failed save's restore parks behind it.
  const repair = b6dDispatch(owner, "fx", 61, 0, { epoch: 14, revision: 1 }, 3, true)
  owner.observe(b6dProgress(1, 13, 1, 1))
  expect(restored.execution.state).toBe("applied")
  expect(dragged.execution.state).toBe("queued")
  expect(repair.receipt.answered).toBeUndefined()
  owner.observe(b6dProgress(1, 13, 2, 2))
  expect(dragged.execution.state).toBe("applied")
  expect(repair.receipt.answered).toBeUndefined()
})

test("seeks a paused native preview without rebuilding its prepared session", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })
  let resetCount = 0
  const unsubscribeReset = controller.subscribeNativeLiveMidiReset(() => { resetCount += 1 })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)
  expect(controller.hasLiveMidiTails()).toBeTrue()

  const beforeCounts = {
    begin: fixture.calls.filter((call) => call === "begin").length,
    graph: fixture.calls.filter((call) => call === "graph").length,
    install: fixture.calls.filter((call) => call === "install").length,
    coordinate: fixture.calls.filter((call) => call === "coordinate").length,
    release: fixture.calls.filter((call) => call === "release").length,
    stop: fixture.calls.filter((call) => call === "stop").length,
    teardown: fixture.calls.filter((call) => call === "teardown").length,
  }

  await expect(controller.seekPrepared(0.5)).resolves.toBe("started")

  expect(controller.isPrepared()).toBeTrue()
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(controller.hasLiveMidiTails()).toBeTrue()
  expect(resetCount).toBe(0)
  expect(fixture.transports.at(-1)).toEqual({
    epoch: 2,
    frame: 24_000,
    running: false,
    hasCycleStart: false,
    hasCycleEnd: false,
  })
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(beforeCounts.begin)
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(beforeCounts.graph)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(beforeCounts.install)
  expect(fixture.calls.filter((call) => call === "coordinate")).toHaveLength(beforeCounts.coordinate)
  expect(fixture.calls.filter((call) => call === "release")).toHaveLength(beforeCounts.release)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(beforeCounts.stop)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(beforeCounts.teardown)

  await controller.dispose()
  unsubscribeReset()
})

test("keeps released live-note ownership separate across focused instrument targets", async () => {
  const firstTrack: RuntimeTrack = { ...instrumentTrack, id: "instrument-a" }
  const secondTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "instrument-b",
    clips: instrumentTrack.clips.map((clip) => ({ ...clip, id: "midi-b" })),
  }
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...input(),
      transport,
      tracks: [firstTrack, secondTrack],
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            "instrument-a": {
              instances: [],
              instrument: { kind: "synth", instanceId: "synth:a", params: createDefaultSynthParams() },
            },
            "instrument-b": {
              instances: [],
              instrument: { kind: "synth", instanceId: "synth:b", params: createDefaultSynthParams() },
            },
          },
        },
        automationEnvelopes: [],
      },
      sidechainRoutes: [],
    }),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const first = controller.startLiveMidiNote({ trackId: "instrument-a", pitch: 60, velocity: 0.8 })
  if (!first) throw new Error("First native live note did not start.")
  controller.releaseLiveMidiNote(first)
  await Bun.sleep(0)
  await expect(controller.seekPrepared(0.5)).resolves.toBe("started")
  const second = controller.startLiveMidiNote({ trackId: "instrument-b", pitch: 60, velocity: 0.8 })
  if (!second) throw new Error("Second native live note did not start.")
  await Bun.sleep(0)

  const liveEvents = nativeLiveInstrumentEvents(fixture.instrumentPayloads)
  expect(liveEvents.filter(({ nodeId }) => nodeId === nativeGraphNodeId("instrument-a"))).toHaveLength(2)
  expect(liveEvents.filter(({ nodeId }) => nodeId === nativeGraphNodeId("instrument-b"))).toHaveLength(1)
  expect(controller.hasLiveMidiTails()).toBeTrue()

  await controller.dispose()
})

const utilityPlaybackInput = (): LivePlaybackSnapshotInput => {
  const utility = createDefaultUtilityParams()
  return {
    ...input(),
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: {
          track: {
            instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: utility } }],
          },
        },
      },
      automationEnvelopes: [],
    },
  }
}

const utilityCommit = (
  instanceId: string,
  fromState: ReturnType<typeof createDefaultUtilityParams>,
  toState: ReturnType<typeof createDefaultUtilityParams>,
) => ({
  targetId: "track",
  effect: "utility" as const,
  instanceId,
  from: { version: 1 as const, state: fromState },
  to: { version: 1 as const, state: toState },
} satisfies EffectParamsCommitPayload<"utility">)

// B6a2 failure inventory: projection without a current edit must not dispatch;
// a retired edit must not be rebound to a new target; retries retain lineage.
for (const kind of ["utility", "synth"]) {
  for (const gap of ["missing-target", "missing-edit", "retired-edit"]) {
    test(`B6a2 ${kind} projection rejects ${gap} without changing the installed baseline`, async () => {
      const fixture = createBridge()
      const base = kind === "utility" ? utilityPlaybackInput() : nativeInstrumentInput()
      const nodeId = kind === "utility" ? "track" : "instrument"
      const instanceId = kind === "utility" ? "utility:1" : "synth:1"
      const edited: LivePlaybackSnapshotInput = { ...base, renderState: { ...base.renderState, fx: {
        ...base.renderState.fx, trackFx: { [nodeId]: kind === "utility"
          ? { instances: [{ id: instanceId, kind: "utility", params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: -6 } } }] }
          : { instances: [], instrument: { kind: "synth", instanceId, params: { ...createDefaultSynthParams(), gain: 0.25 } } },
        },
      } } }
      const registry = createProcessorEditRegistry(() => 120)
      registry.observe(edited.renderState.fx)
      const member = registry.target(nodeId, instanceId)
      if (!member?.latest) throw new Error("B6a2 needs a renderer-allocated edit")
      let configuredParameters = 0
      const controller = createObservedController({
        bridge: fixture.bridge, getProjectId: () => "local_project",
        getProcessorTarget: () => gap === "missing-target" ? undefined : {
          ...member, incarnation: gap === "retired-edit" ? member.incarnation + 1 : member.incarnation,
          latest: gap === "missing-edit" ? undefined : member.latest,
        },
        compileSnapshot: async () => compileLivePlaybackSnapshot(base),
        getDesiredProcessorState: (_snapshot, rate) => {
          configuredParameters = decodeNativeInstrumentEvents(fixture.instrumentPayloads).filter(event => event.type === 5).length
          const compiled = compileLivePlaybackSnapshot(edited)
          if (!compiled.supported) throw new Error(compiled.reasons.join("; "))
          return compileDesiredNativeProcessorState(compiled.snapshot, rate, 900)
        },
      })
      try {
        expect(await controller.ensureLivePreview(0)).toBe("started")
        for (let turn = 0; turn < 60; turn++) await Promise.resolve()
        expect(fixture.statePatchPayloads).toHaveLength(0)
        expect(fixture.builtInParameterPayloads).toHaveLength(0)
        expect(decodeNativeInstrumentEvents(fixture.instrumentPayloads).filter(event => event.type === 5)).toHaveLength(configuredParameters)
        if (gap !== "missing-edit") expect(await controller.deliverProcessor(member.latest).settled).toEqual({ state: "unavailable" })
      } finally { await controller.dispose() }
    })
  }
}

test("B6a2 first parameter dispatch and refusal resend retain the allocated edit identity", async () => {
  const fixture = createBridge()
  const dispatches: { editId: string; sequence: bigint }[] = []
  const registry = createProcessorEditRegistry(() => 120)
  const allocated = registry.allocate(utilityCommit("utility:1", createDefaultUtilityParams(),
    { ...createDefaultUtilityParams(), gainDb: -6 }))
  if (!allocated) throw new Error("B6a2 needs an allocated utility edit")
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(utilityPlaybackInput()),
    onProcessorDispatch: event => dispatches.push(event),
  })
  try {
    expect(await controller.ensureLivePreview(0)).toBe("started")
    const queue = fixture.bridge.session.queueParameterEvents
    let sends = 0
    fixture.bridge.session.queueParameterEvents = bytes => ++sends === 1
      ? Promise.resolve({ ok: false, kind: "refused", error: "B6a2 first send refused" })
      : queue(bytes)
    // A parameter-only edit exercises the real first-send and existing-record resend paths.
    const edit = { ...allocated, content: { params: allocated.content.params, values: { "utility.gainDb": -6 } } }
    expect(await controller.deliverProcessor(edit).settled).toEqual({ state: "applied" })
    expect(sends).toBe(2)
    expect(dispatches.map(event => event.editId)).toEqual([allocated.id, allocated.id])
    expect(new Set(dispatches.map(event => event.sequence)).size).toBe(2)
  } finally { await controller.dispose() }
})

test("B6d2 a prepare does not learn installed values from a registry edit its projection does not hold", async () => {
  const fixture = createBridge()
  const base = utilityPlaybackInput()
  const registry = createProcessorEditRegistry(() => 120)
  registry.observe(base.renderState.fx)
  const from = createDefaultUtilityParams()
  // Allocated before its value reaches the projection, as a failed save's restore is.
  const pending = registry.allocate(utilityCommit("utility:1", from, { ...from, gainDb: -23 }))
  if (!pending) throw new Error("Missing allocated edit")
  const controller = createObservedController({
    bridge: fixture.bridge, getProcessorTarget: registry.target,
    compileSnapshot: async () => compileLivePlaybackSnapshot(base),
    getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 900),
  })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    expect(fixture.builtInParameterPayloads).toHaveLength(0)
    expect(await controller.deliverProcessor(pending).settled).toEqual({ state: "applied" })
    const bytes = fixture.builtInParameterPayloads.at(-1)
    if (!bytes) throw new Error("An edit native does not hold was answered without a send")
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(36, true)).toBe(-23)
  } finally { await controller.dispose() }
})

test("B6a2 projected reconciliation retains registry identity rather than the projection floor", async () => {
  const fixture = createBridge()
  const base = utilityPlaybackInput()
  const registry = createProcessorEditRegistry(() => 120)
  registry.observe(base.renderState.fx)
  const dispatches: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    fingerprintSnapshot: () => "same", getProcessorTarget: registry.target,
    compileSnapshot: async () => compileLivePlaybackSnapshot(base),
    getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 900),
    onProcessorDispatch: event => dispatches.push(event.editId),
  })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    const from = createDefaultUtilityParams(), changed = { ...from, gainDb: -6 }
    const earlier = registry.allocate(utilityCommit("utility:1", from, changed))
    if (!earlier) throw new Error("Missing first allocated edit")
    expect(await controller.deliverProcessor({ ...earlier, content: {
      params: earlier.content.params, values: { "utility.gainDb": -6 },
    } }).settled).toEqual({ state: "applied" })
    const latest = registry.allocate(utilityCommit("utility:1", changed, from))
    if (!latest) throw new Error("Missing projected allocated edit")
    expect(await controller.adoptSchedule(migrationIntent("B6a2-equal"), true)).toEqual({ status: "unchanged" })
    for (let turn = 0; turn < 60; turn++) await Promise.resolve()
    expect(dispatches).toEqual([earlier.id, latest.id])
    expect(await controller.deliverProcessor(latest).settled).toEqual({ state: "applied" })
  } finally { await controller.dispose() }
})

test("B6a2 projected order below its floor does not supersede a newer explicit edit", async () => {
  const fixture = createBridge()
  const base = utilityPlaybackInput()
  const registry = createProcessorEditRegistry(() => 120)
  registry.observe(base.renderState.fx)
  const projected = registry.target("track", "utility:1")?.latest
  if (!projected) throw new Error("Missing projected allocated edit")
  const floor = 900
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProcessorTarget: registry.target,
    compileSnapshot: async () => compileLivePlaybackSnapshot(base),
    getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, floor),
  })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    const from = createDefaultUtilityParams()
    const newer = registry.allocate(utilityCommit("utility:1", from, { ...from, gainDb: -6 }))
    if (!newer) throw new Error("Missing newer allocated edit")
    // Contract witness; Timeline's monotonic allocator cannot allocate below a previously captured floor.
    expect(projected.order).toBeLessThan(newer.order)
    expect(newer.order).toBeLessThan(floor)
    expect(await controller.deliverProcessor(newer).settled).toEqual({ state: "applied" })
    expect(fixture.builtInParameterPayloads).toHaveLength(1)
    const bytes = fixture.builtInParameterPayloads[0]
    if (!bytes) throw new Error("Missing newer native parameter batch")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(0, true)).toBe(1)
    expect(view.getFloat32(36, true)).toBe(-6)
  } finally { await controller.dispose() }
})

test("mapped live parameter edits reject an older edit order", async () => {
  const fixture = createBridge()
  const snapshotInput = { ...utilityPlaybackInput(), processorStateSequence: 10 }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -3 }],
    edit: processorEdit(12),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -3 }],
    edit: processorEdit(12),
  }, true)).settled).resolves.toMatchObject({ state: "applied" })
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -3 }],
    edit: processorEdit(12),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -3 }],
    edit: processorEdit(12),
  }, false)).settled).resolves.toMatchObject({ state: "applied" })
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -6 }],
    edit: processorEdit(11),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -6 }],
    edit: processorEdit(11),
  }, true)).settled).resolves.toMatchObject({ state: "superseded", by: 12 })
  await controller.dispose()
})

test("changed terminal content allocates a new edit and supersedes older orders", async () => {
  const fixture = createBridge()
  const snapshotInput = { ...utilityPlaybackInput(), processorStateSequence: 10 }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")

  const from = createDefaultUtilityParams()
  const to = { ...from, gainDb: -3 }
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: to.gainDb }],
    edit: processorEdit(12),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: to.gainDb }],
    edit: processorEdit(12),
  }, true)).settled).resolves.toMatchObject({ state: "applied" })
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -4 }],
    edit: processorEdit(13),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -4 }],
    edit: processorEdit(13),
  }, false)).settled).resolves.toMatchObject({ state: "applied" })
  expect(fixture.calls.filter((call) => call === "built-in-parameter")).toHaveLength(2)
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -6 }],
    edit: processorEdit(14),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -6 }],
    edit: processorEdit(14),
  }, false)).settled).resolves.toMatchObject({ state: "applied" })
  expect(fixture.calls.filter((call) => call === "built-in-parameter")).toHaveLength(3)
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -8 }],
    edit: processorEdit(11),
  }), fixtureGesture({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -8 }],
    edit: processorEdit(11),
  }, false)).settled).resolves.toMatchObject({ state: "superseded", by: 14 })
  expect(fixture.calls.filter((call) => call === "built-in-parameter")).toHaveLength(3)
  await controller.dispose()
})

// The persisted row reaches the panel through a Solid effect, which only runs under the browser export condition.
const stampBrowserChild = process.env.CONTROLLER_STAMP_BROWSER_CHILD === "1"
test.skipIf(stampBrowserChild)("the effects panel stamp regression runs with Solid's browser runtime", () => {
  const result = Bun.spawnSync([
    "perl", "-e", "alarm shift; exec @ARGV", "120",
    "bun", "--conditions=browser", "test", "--timeout", "30000", import.meta.path,
    "--test-name-pattern", "the effects panel confirms its latest mapped stamp",
  ], { env: { ...process.env, CONTROLLER_STAMP_BROWSER_CHILD: "1" } })
  expect(result.exitCode).toBe(0)
})

test.skipIf(!stampBrowserChild)("the effects panel confirms its latest mapped stamp through the controller before commit", async () => {
  const fixture = createBridge()
  const snapshotInput = { ...utilityPlaybackInput(), processorStateSequence: 10 }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")

  let processorStateSequence = 10
  const commits: EffectParamsCommitPayload[] = []
  const projectId = `project:controller-stamp-${crypto.randomUUID()}`
  await setLocalEffectInstance(projectId, "track", "utility", AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(), { instanceId: "utility:1", index: 0 })
  await createRoot(async (dispose) => {
    const device = createEffectsPanelAudioDevice({
      audioEngine: () => new AudioEngine(),
      projectId: () => projectId,
      userId: () => undefined,
      roomEffects: () => [],
      sidechainRoutes: () => [],
      canWriteCurrentTargetEffects: () => true,
      usesLegacyAudioEngine: () => false,
      allocateProcessorEdit: (payload) => {
        const order = ++processorStateSequence;
        return {
          id: `edit-${order}`,
          order,
          target: {
            nodeId: payload.targetId,
            instanceId: payload.instanceId ?? "",
            kindId: 1,
            incarnation: 1,
          },
          content: { params: payload.to, values: captureNativeBuiltInParameterValues(payload, 120) },
        };
      },
      deliverProcessor: controller.deliverProcessor,
      onEffectParamsCommitted: (payload) => {
        commits.push(payload)
      },
    }, () => "track", () => undefined)

    await new Promise<void>((resolve) => {
      createRenderEffect(() => {
        if (device.snapshotExportRows(["track"]).some((row) => row.instanceId === "utility:1")) resolve()
      })
    })
    const gesture = device.gestureOwner("utility:1", "utility")
    const holder = new ParameterGestureHolder()
    gesture.open(holder)
    gesture.tick(holder, () => device.utility.changeInstance("utility:1", (params) => ({
      ...params,
      state: { ...params.state, gainDb: -3 },
    })))
    gesture.tick(holder, () => device.utility.changeInstance("utility:1", (params) => ({
      ...params,
      state: { ...params.state, gainDb: -6 },
    })))
    gesture.end(holder)
    await device.flushPending()

    expect(commits.at(-1)).toMatchObject({ to: { state: { gainDb: -6 } } })
    expect(device.paramsForInstance({ id: "utility:1", kind: "utility" }))
      .toMatchObject({ state: { gainDb: -6 } })
    // Previews are one per frame and the gesture ended inside one: only the release reaches the controller.
    expect(fixture.calls.filter((call) => call === "built-in-parameter")).toHaveLength(1)
    dispose()
  })
  await controller.dispose()
})

test("unique edit orders suppress identical state and admit changed terminal content", async () => {
  const fixture = createBridge()
  const first = createDefaultUtilityParams()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...utilityPlaybackInput(),
      transport,
      processorStateSequence: 10,
    }),
  })
  await expect(controller.start(utilityPlaybackInput().transport)).resolves.toBe("started")

  const firstValue = { ...first, gainDb: -3 }
  const secondValue = { ...first, gainDb: -6 }
  const patch = (value: typeof first, processorStateSequence: number, editId: string) => controller.deliverProcessor(fixturePatchEdit({
    payload: {
      ...utilityCommit("utility:1", first, value),
      edit: {
        ...processorEdit(processorStateSequence, editId),
        content: { params: value },
      },
    },
    bpm: 120,
    processorStateSequence,
  })).settled
  await expect(patch(firstValue, 12, "edit-12")).resolves.toEqual({ state: "applied" })
  await expect(patch(firstValue, 12, "edit-12")).resolves.toEqual({ state: "applied" })
  expect(fixture.calls.filter((call) => call === "processor-state-patch")).toHaveLength(1)
  await expect(patch(secondValue, 13, "edit-13")).resolves.toEqual({ state: "applied" })
  expect(fixture.calls.filter((call) => call === "processor-state-patch")).toHaveLength(2)
  await expect(patch(first, 11, "edit-11")).resolves.toEqual({ state: "superseded", by: 13 })
  expect(fixture.calls.filter((call) => call === "processor-state-patch")).toHaveLength(2)
  await controller.dispose()
})

test("only increasing native capacity generations grant admission opportunities", async () => {
  const fixture = createBridge("runtime-revision-progress")
  const snapshotInput = utilityPlaybackInput()
  let compilations = 0
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => {
      compilations++
      return compileLivePlaybackSnapshot({ ...snapshotInput, transport })
    },
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  let opportunities = 0
  fixture.bridge.session.revisions.prepare = async () => {
    opportunities++
    return { ok: false, error: "asset-capacity-exceeded", kind: "refused" }
  }
  const { loopEnabled, loopStartSec, loopEndSec } = snapshotInput.transport
  const intent = { key: "refused", schedule: "refused", context: {}, loop: { loopEnabled, loopStartSec, loopEndSec } }
  expect(await controller.adoptSchedule(intent)).toMatchObject({ status: "blocked" })
  const before = opportunities
  const compiled = compilations
  // A refused attempt answers a repeat of its intent until a capacity fact moves; a reopened one reuses its candidate.
  const settle = async () => { await controller.adoptSchedule(intent) }
  const epoch = fixture.transportContexts.at(-1)?.epoch
  if (epoch === undefined) throw new Error("Missing transport epoch")
  let sequence = 100n
  const emit = (admissionCapacityGeneration?: bigint) => fixture.emitScheduleProgress({
    revision: 1, epoch, progressSequence: sequence++, renderedThroughFrame: 0n,
    acceptedThroughFrame: 48000n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: true,
    scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    admissionCapacityGeneration,
  })
  emit()
  emit(0n)
  await settle()
  expect(opportunities).toBe(before)
  emit(1n)
  await settle()
  expect(opportunities).toBe(before + 1)
  emit()
  emit(0n)
  emit(1n)
  await settle()
  expect(opportunities).toBe(before + 1)
  emit(2n)
  await settle()
  expect(opportunities).toBe(before + 2)
  expect(compilations).toBe(compiled)
  await controller.dispose()
})

for (const interleaving of ["accepted", "queued"]) test(`cached schedule candidate cannot overwrite processor patch (${interleaving})`, async () => {
  const fixture = createBridge("runtime-revision-progress")
  let snapshotInput = { ...utilityPlaybackInput(), processorStateSequence: 10 }
  let compilations = 0
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => {
      compilations++
      return compileLivePlaybackSnapshot({ ...snapshotInput, transport })
    },
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  snapshotInput = { ...snapshotInput, tracks: snapshotInput.tracks.map((track) => ({ ...track, clips: [] })) }
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-11")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

  const compiled = compilations
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "asset-capacity-exceeded", kind: "refused" })
  expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "blocked", reason: "asset-capacity-exceeded" })
  const first = createDefaultUtilityParams()
  const patchEntered = Promise.withResolvers<void>()
  const patchGate = Promise.withResolvers<NativeProcessorPatchReply>()
  if (interleaving === "queued") fixture.bridge.session.queueProcessorStatePatch = () => {
    patchEntered.resolve()
    return patchGate.promise
  }
  const patch = controller.deliverProcessor(fixturePatchEdit({
    payload: { ...utilityCommit("utility:1", first, { ...first, gainDb: -6 }), edit: processorEdit(11) }, bpm: 120,
  })).settled
  let queuedPublication: Promise<unknown> | undefined
  if (interleaving === "queued") {
    await patchEntered.promise
    queuedPublication = controller.adoptSchedule(candidateIntent)
    patchGate.resolve(appliedPatch)
  }
  expect(await patch).toEqual({ state: "applied" })
  if (queuedPublication) expect(await queuedPublication).toEqual({ status: "blocked", reason: "asset-capacity-exceeded" })
  snapshotInput = { ...snapshotInput, renderState: { ...snapshotInput.renderState, fx: {
    ...snapshotInput.renderState.fx, trackFx: { track: { instances: [
      { id: "utility:1", kind: "utility", params: { version: 1, state: { ...first, gainDb: -6 } } },
    ] } },
  } } }
  let seam = 0n
  let publishedRevision = 0
  fixture.bridge.session.revisions.prepare = async (request) => {
    seam = request.requestedPublicationFrame ?? 0n
    const result = await prepare(request)
    if (result.ok) publishedRevision = result.revision.requestedRevision
    return result
  }
  fixture.bridge.session.revisions.publish = async () => {
    const result = fixture.revisionReply("published")
    if (!result.ok) throw new Error("Missing proof")
    return { ...result, revision: { ...result.revision, activeRevision: publishedRevision,
      preparedRevision: 0, publicationFrame: seam, transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
  }
  fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
  const expectedCompilation = compileLivePlaybackSnapshot(snapshotInput)
  if (!expectedCompilation.supported) throw new Error("Missing expected graph")
  const expectedSnapshot = expectedCompilation.snapshot
  // The public retry reuses the owner's retained compile.
  expect(compilations).toBe(compiled)
  expect(await controller.adoptSchedule(candidateIntent, true)).toEqual({ status: "adopted" })
  expect(compilations).toBe(compiled)
  expect(fixture.graphPayloads.at(-1)).toEqual(serializeNativeGraph(capturedGraph(expectedSnapshot), new Set()))
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(1)
  expect(expectedSnapshot.tracks[0]?.clips).toHaveLength(0)
  await controller.dispose()
})

for (const removal of [false, true]) test(`rebases ten accepted patches during gated staging (removed node: ${removal})`, async () => {
  const fixture = createBridge("runtime-revision-progress")
  let snapshotInput = { ...utilityPlaybackInput(), processorStateSequence: 10 }
  let compilations = 0
  let hold = false
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => {
      compilations++
      const result = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
      if (hold) { entered.resolve(); await gate.promise }
      return result
    },
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  snapshotInput = { ...snapshotInput, tracks: removal ? [] : snapshotInput.tracks.map((track) => ({ ...track, clips: [] })) }
  hold = true
  const candidateCompile = holdCompile(controller)
  const candidateAdoption = controller.adoptSchedule(migrationIntent("ten-patches"), true)
  await entered.promise
  const first = createDefaultUtilityParams()
  for (let index = 1; index <= 9; index++) expect(await controller.deliverProcessor(fixturePatchEdit({
    payload: { ...utilityCommit("utility:1", first, { ...first, gainDb: -index }), edit: processorEdit(10 + index) }, bpm: 120,
  })).settled).toEqual({ state: "applied" })
  gate.resolve()
  const candidateCompilation = await candidateCompile.entered
  if (!candidateCompilation.supported) throw new Error("Missing captured schedule")
  const candidateSnapshot = candidateCompilation.snapshot

  const patchEntered = Promise.withResolvers<void>()
  const patchGate = Promise.withResolvers<NativeProcessorPatchReply>()
  fixture.bridge.session.queueProcessorStatePatch = () => { patchEntered.resolve(); return patchGate.promise }
  const patch = controller.deliverProcessor(fixturePatchEdit({
    payload: { ...utilityCommit("utility:1", first, { ...first, gainDb: -10 }), edit: processorEdit(20) }, bpm: 120,
  })).settled
  await patchEntered.promise
  let seam = 0n
  let revision = 0
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    seam = request.requestedPublicationFrame ?? 0n
    const reply = await prepare(request)
    if (reply.ok) revision = reply.revision.requestedRevision
    return reply
  }
  fixture.bridge.session.revisions.publish = async () => {
    const reply = fixture.revisionReply("published")
    if (!reply.ok) throw new Error("Missing proof")
    return { ...reply, revision: { ...reply.revision, activeRevision: revision, preparedRevision: 0,
      publicationFrame: seam, transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
  }
  fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
  const publication = (candidateCompile.release(), candidateAdoption)
  patchGate.resolve(appliedPatch)
  expect(await patch).toEqual({ state: "applied" })
  expect(await publication).toEqual({ status: "adopted" })
  expect(compilations).toBe(2)
  expect(fixture.statePatchPayloads).toHaveLength(9)
  const expectedInput = { ...snapshotInput, renderState: { ...snapshotInput.renderState, fx: {
    ...snapshotInput.renderState.fx, trackFx: { track: { instances: [
      { id: "utility:1", kind: "utility", params: { version: 1, state: { ...first, gainDb: -10 } } },
    ] } },
  } } } satisfies LivePlaybackSnapshotInput
  const expectedSnapshot = compileLivePlaybackSnapshot(expectedInput)
  if (!expectedSnapshot.supported) throw new Error("Missing expected snapshot")
  const expected = compileLiveNativeProjection({ tracks: expectedSnapshot.snapshot.tracks, bpm: 120,
    sampleRateHz: 48000, revision: capturedGraph(candidateSnapshot).revision, epoch: 1, firstSequence: 1,
    fx: expectedSnapshot.snapshot.mixer.fx, instrumentRegionMode: "metadata" })
  if (!expected.supported) throw new Error("Missing expected graph")
  expect(fixture.graphPayloads.at(-1)).toEqual(serializeNativeGraph(expected.graph, new Set()))
  expect(candidateSnapshot.tracks.flatMap((track) => track.clips)).toHaveLength(0)
  await controller.dispose()
})

for (const scenario of ["older utility ACK", "newer utility patch", "older FFT patch", "newer FFT patch", "FFT stream", "FFT admission stream", "latest desired FFT without dispatch"]) {
  test(`canonical processor order preserves clip adoption: ${scenario}`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    const spectral = scenario.includes("FFT")
    const fromUtility = createDefaultUtilityParams()
    const fromSpectral = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
    let snapshotInput = utilityPlaybackInput()
    if (spectral) snapshotInput = { ...snapshotInput,
      tracks: [...snapshotInput.tracks, { ...sourceTrack(), id: "parallel", clips: [] }],
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx,
        trackFx: { track: { instances: [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: fromSpectral } }] } },
      } } }
    let compilations = 0
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let latestDesiredInput: LivePlaybackSnapshotInput | undefined
    const projectedEdits = new Map<string, LiveProcessorEditIdentity>()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getProcessorTarget: (_nodeId, instanceId) => {
        const latest = projectedEdits.get(instanceId)
        return { kindId: spectral ? 15 : 1, incarnation: 1, latest }
      },
      getDesiredProcessorState: () => {
        const desired = compileLivePlaybackSnapshot(latestDesiredInput ?? snapshotInput)
        if (!desired.supported) throw new Error("Missing current desired state")
        const projection = compileLiveNativeProjection({ tracks: desired.snapshot.tracks, bpm: 120,
          sampleRateHz: 48000, revision: 1, epoch: 1, firstSequence: 1, fx: desired.snapshot.mixer.fx })
        if (!projection.supported) throw new Error("Missing current desired processor graph")
        return { sequence: latestDesiredInput?.processorStateSequence ?? snapshotInput.processorStateSequence ?? 0,
          graph: projection.graph, instruments: new Map() }
      },
      compileSnapshot: async (transport) => {
        compilations++
        const result = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
        if (compilations === 2) { entered.resolve(); await gate.promise }
        return result
      },
    })
    expect(await controller.start(snapshotInput.transport)).toBe("started")
    const patchEntered = Promise.withResolvers<void>()
    const patchGate = Promise.withResolvers<NativeProcessorPatchReply>()
    fixture.bridge.session.queueProcessorStatePatch = () => { patchEntered.resolve(); return patchGate.promise }
    // A patch whose bytes equal the prepared state is never sent: the older FFT patch differs in `mix`, which
    // costs no latency, so it reaches native.
    const patchFor = (sequence: number, fftSize: 512 | 2048 | 4096 = 512, mix = fromSpectral.mix) => controller.deliverProcessor(fixturePatchEdit({
      bpm: 120, processorStateSequence: sequence,
      payload: spectral ? { effect: "spectral", instanceId: "spectral:1", targetId: "track",
        from: { version: 1, state: fromSpectral }, to: { version: 1, state: { ...fromSpectral, fftSize, mix } } }
        : utilityCommit("utility:1", fromUtility, { ...fromUtility, gainDb: -6 }),
    })).settled
    const older = scenario.startsWith("older")
    const patches: ReturnType<typeof patchFor>[] = []
    if (older) { patches.push(patchFor(1, 512, 0.5)); await patchEntered.promise }
    snapshotInput = { ...snapshotInput, processorStateSequence: 2,
      tracks: snapshotInput.tracks.map((track) => ({ ...track, clips: [] })),
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx,
        trackFx: { track: { instances: spectral
          ? [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: { ...fromSpectral, fftSize: 4096 } } }]
          : [{ id: "utility:1", kind: "utility", params: { version: 1, state: { ...fromUtility, gainDb: -12 } } }],
        } },
      } },
    }
    const candidateCompile = holdCompile(controller)
    const candidateAdoption = controller.adoptSchedule(migrationIntent(`canonical-${scenario}`), true)
    await entered.promise
    const stream = scenario.endsWith("stream")
    if (scenario === "latest desired FFT without dispatch") {
      projectedEdits.set("spectral:1", fixturePatchEdit({ bpm: 120, processorStateSequence: 3, payload: {
        effect: "spectral", instanceId: "spectral:1", targetId: "track",
        from: { version: 1, state: fromSpectral }, to: { version: 1, state: { ...fromSpectral, fftSize: 2048 } },
      } }))
      latestDesiredInput = {
      ...snapshotInput, processorStateSequence: 3,
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx,
        trackFx: { track: { instances: [{ id: "spectral:1", kind: "spectral",
          params: { version: 1, state: { ...fromSpectral, fftSize: 2048 } } }] } } } },
      }
    }
    if (!older && scenario !== "FFT admission stream" && !latestDesiredInput) {
      const count = scenario === "FFT stream" ? 10 : 1
      for (let index = 0; index < count; index++) patches.push(patchFor(3 + index,
        stream ? index % 2 === 0 ? 2048 : 4096 : 512))
    }
    gate.resolve()
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error("Missing captured schedule")
    const candidateSnapshot = candidateCompilation.snapshot

    let seam = 0n
    let revision = 0
    const prepare = fixture.bridge.session.revisions.prepare
    let admissionEdits = false
    fixture.bridge.session.revisions.prepare = async (request) => {
      seam = request.requestedPublicationFrame ?? 0n
      const reply = await prepare(request)
      if (reply.ok) revision = reply.revision.requestedRevision
      if (scenario === "FFT admission stream" && !admissionEdits) {
        admissionEdits = true
        for (let index = 0; index < 10; index++) patches.push(patchFor(3 + index, index % 2 === 0 ? 4096 : 2048))
      }
      return reply
    }
    fixture.bridge.session.revisions.publish = async () => {
      const reply = fixture.revisionReply("published")
      if (!reply.ok) throw new Error("Missing canonical proof")
      return { ...reply, revision: { ...reply.revision, activeRevision: revision, preparedRevision: 0,
        publicationFrame: seam, transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
    }
    fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
    const publication = (candidateCompile.release(), candidateAdoption)
    patchGate.resolve(appliedPatch)
    expect(await publication).toEqual({ status: "adopted" })
    for (const [index, patch] of patches.entries()) expect(await patch).toEqual(
      scenario === "FFT stream" && index % 2 === 0 ? { state: "superseded", by: 12 } : { state: "applied" },
    )
    expect(compilations).toBe(2)
    const finalFft = scenario === "FFT admission stream" || latestDesiredInput ? 2048 : older || stream ? 4096 : 512
    const expectedInput: LivePlaybackSnapshotInput = { ...snapshotInput,
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx,
        trackFx: { track: { instances: spectral
          ? [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: { ...fromSpectral, fftSize: finalFft } } }]
          : [{ id: "utility:1", kind: "utility", params: { version: 1, state: { ...fromUtility, gainDb: older ? -12 : -6 } } }],
        } },
      } },
    }
    const expectedSnapshot = compileLivePlaybackSnapshot(expectedInput)
    if (!expectedSnapshot.supported) throw new Error("Missing expected canonical snapshot")
    const expected = compileLiveNativeProjection({ tracks: expectedSnapshot.snapshot.tracks, bpm: 120,
      sampleRateHz: 48000, revision: scenario === "FFT admission stream" ? capturedGraph(candidateSnapshot).revision + 1 : capturedGraph(candidateSnapshot).revision,
      epoch: 1, firstSequence: 1,
      fx: expectedSnapshot.snapshot.mixer.fx, instrumentRegionMode: "metadata" })
    if (!expected.supported) throw new Error("Missing expected canonical graph")
    expect(fixture.graphPayloads.at(-1)).toEqual(serializeNativeGraph(expected.graph, new Set()))
    expect(candidateSnapshot.tracks.flatMap((track) => track.clips)).toHaveLength(0)
    if (scenario === "FFT stream") expect(fixture.graphPayloads).toHaveLength(2)
    if (scenario === "FFT admission stream") expect(fixture.graphPayloads).toHaveLength(3)
    await controller.dispose()
  })
}

test("B6a1 retained schedule candidate survives latency and processor-patch promotions", async () => {
  const fixture = createBridge("runtime-revision-progress")
  let snapshotInput = { ...utilityPlaybackInput(), processorStateSequence: 10 }
  let keep = new Set<string>()
  let compilations = 0
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project", getKeepLatencyNodeIds: () => keep,
    compileSnapshot: async (transport) => {
      compilations++
      return compileLivePlaybackSnapshot({ ...snapshotInput, transport })
    },
  })
  try {
    expect(await controller.start(snapshotInput.transport)).toBe("started")
    snapshotInput = { ...snapshotInput, tracks: snapshotInput.tracks.map(track => ({ ...track, clips: [] })) }
    const prepare = fixture.bridge.session.revisions.prepare
    fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "asset-capacity-exceeded", kind: "refused" })
    const intent = migrationIntent("B6a1-retained")
    expect(await controller.adoptSchedule(intent, true)).toEqual({ status: "blocked", reason: "asset-capacity-exceeded" })
    expect(controller.adoptionWitness().retained).toBe(intent.key)
    expect(controller.liveScheduleCandidates()).toBe(1)
    const compiled = compilations
    const structural = controller.adoptionFieldsWitness().structural
    let seam = 0n
    let revision = 0
    fixture.bridge.session.revisions.prepare = async (request) => {
      seam = request.requestedPublicationFrame ?? 0n
      const reply = await prepare(request)
      if (reply.ok) revision = reply.revision.requestedRevision
      return reply
    }
    fixture.bridge.session.revisions.publish = async () => {
      const reply = fixture.revisionReply("published")
      if (!reply.ok) throw new Error("Missing publication proof")
      return { ...reply, revision: { ...reply.revision, activeRevision: revision, preparedRevision: 0,
        publicationFrame: seam, transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
    }
    fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
    keep = new Set(["track"])
    expect(await controller.updateKeepLatency()).toEqual({ handled: true })
    expect(controller.adoptionFieldsWitness().structural).toBe(structural)
    expect(controller.adoptionWitness().retained).toBe(intent.key)
    const first = createDefaultUtilityParams()
    expect(await controller.deliverProcessor(fixturePatchEdit({
      payload: { ...utilityCommit("utility:1", first, { ...first, gainDb: -6 }), edit: processorEdit(11) }, bpm: 120,
    })).settled).toEqual({ state: "applied" })
    expect(fixture.statePatchPayloads).toHaveLength(1)
    expect(controller.adoptionFieldsWitness().structural).toBe(structural)
    expect(await controller.adoptSchedule(intent, true)).toEqual({ status: "adopted" })
    expect(compilations).toBe(compiled)
    expect(controller.adoptionWitness().retained).toBeUndefined()
    expect(controller.liveScheduleCandidates()).toBe(0)
  } finally { await controller.dispose() }
})

test("B6a1 structural replacements discard retained schedule candidates", async () => {
  for (const replacement of ["configure", "schedule", "loss", "reset"]) {
    const fixture = createBridge("runtime-revision-progress")
    let snapshotInput = utilityPlaybackInput()
    let compilations = 0
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      compileSnapshot: async (transport) => {
        compilations++
        return compileLivePlaybackSnapshot({ ...snapshotInput, transport })
      },
    })
    try {
      expect(await controller.start(snapshotInput.transport)).toBe("started")
      snapshotInput = { ...snapshotInput, tracks: snapshotInput.tracks.map(track => ({ ...track, clips: [] })) }
      const prepare = fixture.bridge.session.revisions.prepare
      fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "asset-capacity-exceeded", kind: "refused" })
      const intent = migrationIntent(`B6a1-${replacement}`)
      expect(await controller.adoptSchedule(intent, true)).toEqual({ status: "blocked", reason: "asset-capacity-exceeded" })
      expect(controller.adoptionWitness().retained).toBe(intent.key)
      const compiled = compilations
      const structural = controller.adoptionFieldsWitness().structural
      fixture.bridge.session.revisions.prepare = prepare
      acknowledgeStagedPublication(fixture)
      if (replacement === "schedule") {
        expect(await controller.adoptSchedule(migrationIntent("B6a1-successor"), true)).toEqual({ status: "adopted" })
        expect(compilations).toBe(compiled + 1)
      } else if (replacement === "loss") {
        fixture.emitLoss("Native playback host connection was lost.")
      } else {
        await controller.dispose()
        if (replacement === "configure") {
          const cleared = controller.adoptionFieldsWitness().structural
          expect(await controller.start(snapshotInput.transport)).toBe("started")
          expect(controller.adoptionFieldsWitness().structural).toBeGreaterThan(cleared)
          expect(compilations).toBe(compiled + 1)
        }
      }
      expect(controller.adoptionFieldsWitness().structural).toBeGreaterThan(structural)
      expect(controller.adoptionWitness().retained).toBeUndefined()
      expect(controller.liveScheduleCandidates()).toBe(0)
    } finally { await controller.dispose() }
  }
})

test("Keep Latency publication during gated staging retains one candidate compile", async () => {
  const fixture = createBridge("runtime-revision-progress")
  let snapshotInput = utilityPlaybackInput()
  let keep = new Set<string>()
  let compilations = 0
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project", getKeepLatencyNodeIds: () => keep,
    compileSnapshot: async (transport) => {
      compilations++
      const result = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
      if (compilations === 2) { entered.resolve(); await gate.promise }
      return result
    },
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  snapshotInput = { ...snapshotInput, tracks: snapshotInput.tracks.map((track) => ({ ...track, clips: [] })) }
  const candidateCompile = holdCompile(controller)
  const candidateAdoption = controller.adoptSchedule(migrationIntent("keep-latency-capture"), true)
  await entered.promise
  keep = new Set(["track"])
  expect(await controller.updateKeepLatency()).toEqual({ handled: true })
  gate.resolve()
  const candidateCompilation = await candidateCompile.entered
  if (!candidateCompilation.supported) throw new Error("Missing captured schedule")
  const candidateSnapshot = candidateCompilation.snapshot

  let seam = 0n
  let revision = 0
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    seam = request.requestedPublicationFrame ?? 0n
    const reply = await prepare(request)
    if (reply.ok) revision = reply.revision.requestedRevision
    return reply
  }
  fixture.bridge.session.revisions.publish = async () => {
    const reply = fixture.revisionReply("published")
    if (!reply.ok) throw new Error("Missing proof")
    return { ...reply, revision: { ...reply.revision, activeRevision: revision, preparedRevision: 0,
      publicationFrame: seam, transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
  }
  fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
  expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
  expect(compilations).toBe(2)
  expect(fixture.graphPayloads.at(-1)).toEqual(serializeNativeGraph(capturedGraph(candidateSnapshot), keep))
  await controller.dispose()
})

const reverbPlaybackInput = () => ({
  ...input(),
  renderState: {
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: {
        track: {
          instances: [{
            id: "reverb:1",
            kind: "reverb" as const,
            params: createDefaultReverbParams(),
          }],
        },
      },
    },
    automationEnvelopes: [],
  },
})

for (const scenario of ["audio-delete", "audio-move", "audio-trim", "audio-tempo", "audio-replace", "audio-combined", "audio-seek", "sampled-track-remove-sampler", "sampled-track-remove-granular", "sampled-track-remove-drum-rack", "instrument-config", "asset-add", "asset-add-late-bind", "asset-add-install-cancel", "asset-add-rebase", "asset-add-capacity", "asset-add-cancel", "asset-add-hydration-cancel", "clip-add-existing", "audio-track-remove", "audio-track-remove-bundled", "sampled-add-sampler", "sampled-add-granular", "sampled-add-drum-rack", "sampled-add-budget", "sampled-remove-zone", "sampled-replace-synth", "sampled-change-key", "sampled-remove-zone-rollback", "sampled-remove-zone-cancel", "sampled-remove-zone-seek-racing", "proof", "expired-prepare", "invalid-prepare", "prepared-conflict", "stale-epoch", "chunk-cancel", "hydration-cancel", "rebase", "exhaustion", "seek", "readiness", "credits", "seek-published", "seek-racing", "stop", "project-switch", "seek-queued", "keep-latency-race", "paged-granular", "paged-sampler", "paged-drum-rack", "paged-concurrent-refill"]) {
  test(`staged schedule handoff ${scenario} retains active audio and epoch`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    const isScenario = (name: string) => String(scenario) === name
    let snapshotInput = nativeInstrumentInput()
    if (scenario.startsWith("audio-")) snapshotInput = input(longSourceTrack())
    if (scenario.startsWith("sampled-track-remove-")) {
      const kind = scenario === "sampled-track-remove-sampler" ? "sampler"
        : scenario === "sampled-track-remove-granular" ? "granular" : "drum-rack"
      const sampled = sampledNativeInput(kind, 0.1)
      snapshotInput = { ...sampled, tracks: [...sampled.tracks, longSourceTrack()] }
    }
    const sampledKind = scenario === "paged-granular" || scenario === "paged-concurrent-refill" ? "granular"
      : scenario === "paged-sampler" ? "sampler"
        : scenario === "paged-drum-rack" ? "drum-rack" : undefined
    if (sampledKind) {
      const sampled = sampledNativeInput(sampledKind)
      snapshotInput = { ...sampled, tracks: [...sampled.tracks, { ...longSourceTrack(), muted: true }] }
    }
    if (scenario.startsWith("asset-add") || scenario === "clip-add-existing" || scenario === "audio-track-remove")
      snapshotInput = input(longSourceTrack())
    if (scenario.startsWith("sampled-add-")) snapshotInput = input(longSourceTrack())
    if (scenario === "audio-track-remove" || scenario === "audio-track-remove-bundled")
      snapshotInput = { ...input(longSourceTrack()), tracks: [longSourceTrack(), instrumentTrack] }
    if (scenario.startsWith("sampled-remove-") || scenario.startsWith("sampled-replace-") || scenario.startsWith("sampled-change-")) {
      const sampled = sampledNativeInput("sampler", 0.1)
      snapshotInput = { ...sampled, tracks: [...sampled.tracks, longSourceTrack()] }
    }
    let desiredKeepLatency = new Set<string>()
    const faults: string[] = []
    const stagedBudget = scenario === "sampled-add-budget" ? createSampledInstrumentRegionBudget(40_000) : undefined
    const originalQueue = fixture.bridge.session.queueScheduleWindow
    let rejected = false
    let readdingSample = false
    let cancelDuringChunk: (() => void) | undefined
    let stagedChunks = 0
    let holdHydration = false
    const hydrationEntered = Promise.withResolvers<void>()
    const hydrationGate = Promise.withResolvers<BridgeReply>()
    const prepareRange = fixture.bridge.session.prepareMappedAssetRange
    let countRanges = false
    let preparedRanges = 0
    fixture.bridge.session.prepareMappedAssetRange = async (...args) => {
      if (countRanges) preparedRanges++
      if (holdHydration) { hydrationEntered.resolve(); return hydrationGate.promise }
      return prepareRange(...args)
    }
    fixture.bridge.session.queueScheduleWindow = async (bytes): Promise<BridgeReply> => {
      if (new DataView(bytes.buffer).getUint32(60, true) === 2) {
        stagedChunks++
        cancelDuringChunk?.()
      }
      if (scenario === "credits" && !rejected && new DataView(bytes.buffer).getUint32(60, true) === 2) {
        rejected = true
        return { ok: false, error: "capacity" }
      }
      return originalQueue(bytes)
    }
    if (scenario === "hydration-cancel") snapshotInput = input(longSourceTrack())
    if (scenario === "chunk-cancel") snapshotInput = { ...snapshotInput, tracks: [{ ...instrumentTrack,
      clips: instrumentTrack.clips.map((clip) => ({ ...clip, midi: { ...clip.midi!,
        notes: Array.from({ length: 300 }, (_, index) => ({ id: `note-${index}`, pitch: 40 + index % 50,
          beat: 0.5 + index / 1000, length: 1, velocity: 0.8 })) } })),
    }] }
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      instrumentBudget: stagedBudget,
      getKeepLatencyNodeIds: () => desiredKeepLatency,
      resolveSource: async () => longSourceDescriptor(),
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
      reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    })
    expect(await controller.start(snapshotInput.transport)).toBe("started")
    countRanges = true
    const before = fixture.calls.length
    const originalAssetIds = fixture.installedAssets.map((asset) => asset.sessionAssetId)
    const originalSampleAssetIds = fixture.installedAssets.filter((asset) => asset.frameCount === 4_800)
      .map((asset) => asset.sessionAssetId)
    const retainedAssetIds = originalAssetIds.filter((id) => !originalSampleAssetIds.includes(id))
    const releasedAssetIds = fixture.releasedAssetIds
      if (isScenario("sampled-remove-zone-rollback"))
      fixture.bridge.session.configureInstrumentStates = async () => ({ ok: false, error: "staged configuration rejected" })
    const originalPages = fixture.mappedPages.slice()
    const createMappedAsset = fixture.bridge.session.createMappedAsset
    const installEntered = Promise.withResolvers<void>()
    const installGate = Promise.withResolvers<void>()
    fixture.bridge.session.createMappedAsset = async (asset) => {
      expect(fixture.calls).toContain("stage-prepare")
      if (scenario !== "audio-track-remove" && !readdingSample
        && !(scenario === "sampled-change-key" && asset.sessionAssetId === originalSampleAssetIds[0]))
        expect(originalAssetIds).not.toContain(asset.sessionAssetId)
      if (scenario === "asset-add-capacity") return { ok: false, error: "asset-capacity-exceeded", kind: "refused" }
      const result = await createMappedAsset(asset)
      if (scenario === "asset-add-install-cancel") { installEntered.resolve(); await installGate.promise }
      return result
    }
    const originalWindows = fixture.schedulePayloads.slice()
    const epoch = new DataView(originalWindows[0]!.buffer).getUint32(4, true)
    let frame = 0n
    let seam = 0n
    let progressSequence = 100n
    let status: NativeGraphRevisionStatus["status"] = "prepared"
    let publishes = 0
    let prepares = 0
    let transportAcknowledged = false
    let assetsAtFirstSeamChange: number | undefined
    let addedPagesAtFirstSeamChange: number | undefined
    let rangesAtFirstSeamChange: number | undefined
    let stagedRevision = 2
    let activeRevision = 1
    const defaultRevisionPrepare = fixture.bridge.session.revisions.prepare
    const defaultRevisionPublish = fixture.bridge.session.revisions.publish
    const defaultRevisionInspect = fixture.bridge.session.revisions.inspect
    const reply = (): NativeRevisionReply => ({
      ok: true, hostPid: 123, hostGeneration: 7,
      revision: { status, continuity: "accepted", requestedRevision: stagedRevision,
        activeRevision: status === "published" ? stagedRevision : activeRevision,
        preparedRevision: status === "published" ? 0 : stagedRevision,
        retiredRevision: 0, publicationFrame: status === "published" ? seam : 0n,
        requestedPublicationFrame: seam, progressFrame: frame,
        transportEpoch: scenario.includes("seek-racing") ? fixture.transports.at(-1)?.epoch ?? epoch : epoch, renderEpoch: 1n },
    })
    fixture.bridge.session.revisions.prepare = async (request) => {
      if (scenario === "keep-latency-race" && request.requestedPublicationFrame === undefined)
        return defaultRevisionPrepare(request)
      fixture.calls.push("stage-prepare")
      fixture.graphPayloads.push(request.bytes)
      seam = request.requestedPublicationFrame ?? 0n
      expect(seam).toBeGreaterThan(0n)
      if (scenario === "invalid-prepare" || scenario === "prepared-conflict") {
        prepares++
        const rejected = reply()
        if (!rejected.ok) throw new Error("Missing revision")
        return { ...rejected, revision: { ...rejected.revision, status: "invalid-revision",
          preparedRevision: scenario === "prepared-conflict" ? 3 : 0 } }
      }
      if (scenario === "expired-prepare" && prepares++ === 0) {
        frame = seam
        const rejected = reply()
        if (!rejected.ok) throw new Error("Missing revision")
        return { ...rejected, revision: { ...rejected.revision, status: "invalid-revision", preparedRevision: 0 } }
      }
      return reply()
    }
    fixture.bridge.session.revisions.publish = async (request) => {
      if (scenario === "keep-latency-race" && request.requestedPublicationFrame === undefined)
        return defaultRevisionPublish(request)
      const requested = request.requestedPublicationFrame ?? 0n
      if (requested !== seam) {
        assetsAtFirstSeamChange ??= fixture.installedAssets.length
        rangesAtFirstSeamChange ??= preparedRanges
        addedPagesAtFirstSeamChange ??= fixture.mappedPages.filter((page) => !originalAssetIds.includes(page.sessionAssetId)).length
        seam = requested; status = "prepared"; return reply()
      }
      publishes++
      if (scenario === "exhaustion" || ((scenario === "rebase" || scenario === "asset-add-rebase") && publishes === 1)
        || (scenario === "paged-concurrent-refill" && publishes === 1)) {
        frame = seam + 128n
        status = "rebase-required"
      } else status = scenario === "readiness" && publishes === 1 ? "prepared" : "publish-pending"
      return reply()
    }
    fixture.bridge.session.revisions.inspect = async (request) => {
      if (scenario === "keep-latency-race" && request.requestedPublicationFrame === undefined)
        return defaultRevisionInspect(request)
      const inspection = reply()
      if (scenario === "sampled-remove-zone-seek-racing" && transportAcknowledged && inspection.ok)
        return { ...inspection, revision: { ...inspection.revision, status: "published",
          activeRevision: stagedRevision, preparedRevision: 0, transportEpoch: fixture.transports.at(-1)?.epoch ?? epoch } }
      if (scenario === "invalid-prepare" || scenario === "prepared-conflict") return inspection.ok
        ? { ...inspection, revision: { ...inspection.revision, status: "invalid-revision",
          preparedRevision: scenario === "prepared-conflict" ? 3 : 0 } } : inspection
      return scenario === "expired-prepare" && prepares === 1 && inspection.ok
        ? { ...inspection, revision: { ...inspection.revision, status: "invalid-revision", preparedRevision: 0 } }
        : inspection
    }
    fixture.bridge.session.revisions.rollback = async () => {
      fixture.calls.push("stage-rollback")
      status = scenario.includes("seek-racing") ? "publish-pending" : "rolled-back"
      return reply()
    }
    const progress = () => fixture.emitScheduleProgress({
      revision: activeRevision, epoch, progressSequence: ++progressSequence,
      renderedThroughFrame: frame, acceptedThroughFrame: 96_000n, lastAcceptedWindowId: 1n,
      appliedTransportTransitionId: 1n, appliedUrgentSequence: 0n, appliedProcessorSequence: 0n,
      running: true, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    })
    const initialSnapshotInput = snapshotInput
    snapshotInput = { ...snapshotInput, revision: 2 }
    if (scenario === "audio-delete") snapshotInput = { ...snapshotInput,
      tracks: snapshotInput.tracks.map((track) => ({ ...track, clips: [] })) }
    if (["audio-move", "audio-trim", "audio-replace", "audio-combined", "audio-seek"].includes(scenario))
      snapshotInput = { ...snapshotInput, tracks: snapshotInput.tracks.map((track) => ({
        ...track, clips: track.clips.map((clip) => ({ ...clip,
          startSec: scenario === "audio-trim" || scenario === "audio-replace" ? 0 : 0.05,
          bufferOffsetSec: scenario === "audio-trim" || scenario === "audio-combined" ? 0.25 : 0,
          buffer: scenario === "audio-replace" || scenario === "audio-combined"
            ? new TestAudioBuffer([new Float32Array(480_000), new Float32Array(480_000)]) : clip.buffer,
          sourceDurationSec: scenario === "audio-replace" || scenario === "audio-combined" ? 10 : clip.sourceDurationSec,
        })),
      })) }
    if (scenario === "audio-tempo" || scenario === "audio-combined") snapshotInput = { ...snapshotInput, bpm: 130 }
    if (scenario.startsWith("sampled-track-remove-")) snapshotInput = { ...snapshotInput, tracks: [longSourceTrack()],
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx, trackFx: {} } } }
    if (scenario === "instrument-config") snapshotInput = { ...snapshotInput,
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx, trackFx: {
        instrument: { instances: [], instrument: { kind: "synth", instanceId: "replacement", params: { ...createDefaultSynthParams(), gain: 0.2 } } },
      } } } }
    if (scenario.startsWith("asset-add") || scenario === "clip-add-existing") {
      snapshotInput = { ...snapshotInput, tracks: snapshotInput.tracks.map((track) => ({
        ...track, clips: [...track.clips, { ...track.clips[0]!, id: "added", startSec: 0.5,
          sourceAssetKey: scenario === "clip-add-existing" ? track.clips[0]!.sourceAssetKey : "added-source" }],
      })) }
    }
    if (scenario === "audio-track-remove") snapshotInput = { ...snapshotInput, tracks: [instrumentTrack] }
    if (scenario === "audio-track-remove-bundled") snapshotInput = { ...snapshotInput, tracks: [instrumentTrack, {
      ...longSourceTrack(), id: "added-track", clips: longSourceTrack().clips.map((clip) => ({
        ...clip, id: "added-clip", sourceAssetKey: "added-source",
      })),
    }] }
    if (scenario.startsWith("sampled-add-")) {
      const kind = scenario === "sampled-add-sampler" ? "sampler"
        : scenario === "sampled-add-granular" ? "granular" : "drum-rack"
      snapshotInput = { ...sampledNativeInput(kind, 0.1), revision: 2,
        tracks: [longSourceTrack(), instrumentTrack] }
    }
    if (scenario === "sampled-remove-zone") {
      const entry = snapshotInput.renderState.fx.trackFx!.instrument!
      const instrument = entry.instrument
      if (!instrument || instrument.kind !== "sampler") throw new Error("Expected sampler fixture.")
      snapshotInput = { ...snapshotInput, renderState: { ...snapshotInput.renderState, fx: {
        ...snapshotInput.renderState.fx, trackFx: { instrument: { ...entry,
          instrument: { ...instrument, params: { ...instrument.params, zones: [] } } } },
      } } }
    }
    if (scenario === "sampled-replace-synth") snapshotInput = { ...snapshotInput,
      renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx, trackFx: {
        instrument: { instances: [], instrument: { kind: "synth", instanceId: "replacement", params: createDefaultSynthParams() } },
      } } } }
    if (scenario === "sampled-change-key") {
      const entry = snapshotInput.renderState.fx.trackFx!.instrument!
      const sampled = entry.instrument!
      if (sampled.kind !== "sampler") throw new Error("Expected sampler fixture.")
      const zone = sampled.params.zones[0]
      if (!zone) throw new Error("Expected sampler zone fixture.")
      const changedZone = { ...zone, sample: { ...zone.sample, assetKey: "replacement-sample" } }
      snapshotInput = { ...snapshotInput, renderState: { ...snapshotInput.renderState, fx: {
        ...snapshotInput.renderState.fx, trackFx: { instrument: { ...entry,
          instrument: { ...sampled, params: { ...sampled.params, zones: [changedZone] } } },
      } } } }
    }
    holdHydration = scenario === "hydration-cancel" || scenario === "asset-add-hydration-cancel"
    let chunkSeek: Promise<unknown> | undefined
    if (scenario === "chunk-cancel") cancelDuringChunk = () => {
      cancelDuringChunk = undefined
      chunkSeek = controller.seekPrepared(0)
    }
    let settled = false
    const update = controller.adoptSchedule(migrationIntent("public-migration-1"), true).then((result) => { settled = true; return result })
    if (scenario === "asset-add-install-cancel") {
      await installEntered.promise
      let paused = false
      const pause = controller.pause(0).then(() => { paused = true })
      for (let turn = 0; turn < 300; turn++) await Promise.resolve()
      try {
        expect(paused).toBe(true)
        expect((await update).status).not.toBe("adopted")
        await pause
        expect(publishes).toBe(0)
      } finally { installGate.resolve() }
      await controller.dispose()
      return
    }
    if (scenario === "asset-add-capacity") {
      expect(await update).toEqual({ status: "blocked", reason: "asset-capacity-exceeded" })
      expect(fixture.calls).toContain("stage-rollback")
      expect(controller.isActive()).toBe(true)
      fixture.bridge.session.createMappedAsset = createMappedAsset
      status = "prepared"
      const retry = controller.adoptSchedule(migrationIntent("public-migration-2"), true)
      for (let turn = 0; turn < 300; turn++) await Promise.resolve()
      status = "published"
      activeRevision = stagedRevision
      fixture.setRuntimeRevision(activeRevision)
      frame = seam
      progress()
      expect(await retry).toEqual({ status: "adopted" })
      expect(fixture.calls.slice(before).filter((call) => ["stop", "start", "graph", "teardown"].includes(call))).toEqual([])
      await controller.dispose()
      return
    }
    if (scenario === "sampled-add-budget") {
      expect(await update).toMatchObject({ status: "failed" })
      expect(fixture.calls).toContain("stage-rollback")
      expect(stagedBudget?.totalBytes()).toBe(0)
      expect(stagedBudget?.reservedBytes()).toBe(0)
      expect(stagedBudget?.keys()).toEqual([])
      expect(controller.isActive()).toBe(true)
      await controller.dispose()
      return
    }
    if (scenario === "seek-queued") {
      const seek = controller.seekPrepared(0)
      // Unlike an unpublished private candidate, a public intent remains wanted.
      // Withdraw it explicitly while its transport lane is still queued.
      controller.dropAdoptionIntents()
      let seekCompleted = false
      void seek.then(() => { seekCompleted = true })
      for (let turn = 0; turn < 150; turn++) await Promise.resolve()
      expect((await update).status).not.toBe("adopted")
      expect(seekCompleted).toBe(true)
      expect(await seek).toBe("started")
      if (isScenario("sampled-remove-zone-seek-racing")) {
        expect(releasedAssetIds).toEqual(originalSampleAssetIds)
        expect(retainedAssetIds.every((id) => !releasedAssetIds.includes(id))).toBe(true)
        const callsBeforeReadd = fixture.calls.length
        const installedBeforeReadd = fixture.installedAssets.length
        readdingSample = true
        snapshotInput = { ...initialSnapshotInput, revision: 3 }
        stagedRevision = 3
        activeRevision = 2
        status = "prepared"
        const readd = controller.adoptSchedule(migrationIntent("public-migration-3"), true)
        for (let turn = 0; turn < 300; turn++) await Promise.resolve()
        expect(fixture.calls.slice(callsBeforeReadd)).not.toContain("start")
        status = "published"
        fixture.setRuntimeRevision(3)
        frame = seam
        const seekEpoch = fixture.transports.at(-1)?.epoch ?? epoch
        fixture.emitScheduleProgress({
          revision: activeRevision, epoch: seekEpoch, progressSequence: ++progressSequence,
          renderedThroughFrame: frame, acceptedThroughFrame: 96_000n, lastAcceptedWindowId: 1n,
          appliedTransportTransitionId: 1n, appliedUrgentSequence: 0n, appliedProcessorSequence: 0n,
          running: true, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
        })
        expect(await readd).toEqual({ status: "adopted" })
        expect(fixture.installedAssets.slice(installedBeforeReadd).map(({ sessionAssetId }) => sessionAssetId))
          .toEqual(originalSampleAssetIds)
        expect(fixture.calls.slice(callsBeforeReadd)).not.toContain("start")
        expect(fixture.calls.slice(callsBeforeReadd)).not.toContain("stop")
      }
      expect(fixture.calls).not.toContain("stage-prepare")
      await controller.dispose()
      return
    }
    // Flush bounded promise work; only explicit progress below advances native time.
    for (let turn = 0; turn < 150; turn++) await Promise.resolve()
    if (scenario === "audio-track-remove" || scenario === "audio-track-remove-bundled") {
      expect(fixture.calls.slice(before)).toContain("stage-prepare")
      expect(fixture.calls.slice(before)).not.toContain("release")
      const sources = decodeNativeSourceEvents(fixture.schedulePayloads.filter((bytes) =>
        new DataView(bytes.buffer).getUint32(60, true) === 2))
      expect(sources).toHaveLength(scenario === "audio-track-remove" ? 0 : 1)
    }
    if (scenario === "invalid-prepare" || scenario === "prepared-conflict") {
      expect((await update).status).not.toBe("adopted")
      expect(prepares).toBe(1)
      expect(faults).toHaveLength(0)
      expect(fixture.calls).not.toContain("stage-rollback")
    } else if (scenario === "hydration-cancel" || scenario === "asset-add-hydration-cancel") {
      await hydrationEntered.promise
      holdHydration = false
      const seek = controller.seekPrepared(0)
      let seekSettled = false
      void seek.then(() => { seekSettled = true })
      for (let turn = 0; turn < 300; turn++) await Promise.resolve()
      try {
        expect(seekSettled).toBe(true)
        expect((await update).status).not.toBe("adopted")
        expect(await seek).toBe("started")
      } finally { hydrationGate.resolve({ ok: true }) }
      if (scenario === "asset-add-hydration-cancel") {
        // The publication settled and retired its resources while the read was held; once it returns, nothing follows it.
        const rangesAtCancel = preparedRanges
        for (let turn = 0; turn < 300; turn++) await Promise.resolve()
        expect(preparedRanges).toBe(rangesAtCancel)
      }
    } else if (scenario === "chunk-cancel") {
      expect((await update).status).not.toBe("adopted")
      expect(await chunkSeek).toBe("started")
      expect(stagedChunks).toBe(1)
    } else if (scenario === "exhaustion") {
      for (let retry = 0; retry < 12 && !settled; retry++) {
        progress()
        for (let turn = 0; turn < 150; turn++) await Promise.resolve()
      }
      expect((await update).status).not.toBe("adopted")
      expect(faults).toHaveLength(0)
      expect(controller.isActive()).toBe(true)
    } else if (scenario.startsWith("seek") || scenario === "audio-seek" || String(scenario) === "sampled-remove-zone-seek-racing"
      || String(scenario) === "sampled-remove-zone-cancel") {
      if (scenario === "seek-published") { status = "published"; fixture.setRuntimeRevision(2) }
      if (scenario.includes("seek-racing")) {
        const transport = fixture.bridge.session.setTransport
        fixture.bridge.session.setTransport = async (request) => {
          transportAcknowledged = true
          status = "published"
          fixture.setRuntimeRevision(2)
          return transport(request)
        }
      }
      const seek = controller.seekPrepared(0)
      let seekCompleted = false
      void seek.then(() => { seekCompleted = true })
      for (let turn = 0; turn < 150; turn++) await Promise.resolve()
      expect((await update).status).toBe(
        scenario === "seek-published" || scenario.includes("seek-racing") ? "adopted" : "superseded")
      expect(seekCompleted).toBe(true)
      expect(await seek).toBe("started")
      if (scenario === "seek" || scenario === "audio-seek" || scenario === "sampled-remove-zone-cancel" || scenario.endsWith("-seek-racing"))
        expect(fixture.calls).toContain("stage-rollback")
      else expect(new DataView(fixture.schedulePayloads.at(-1)!.buffer).getUint32(0, true)).toBe(2)
    } else if (isScenario("sampled-remove-zone-rollback")) {
      expect(await update).toMatchObject({ status: "failed" })
      expect(fixture.calls).toContain("stage-rollback")
      expect(releasedAssetIds).toEqual([])
      await controller.dispose()
      return
    } else if (scenario === "stop" || scenario === "project-switch" || scenario === "asset-add-cancel") {
      if (isScenario("sampled-remove-zone-cancel")) expect(releasedAssetIds).toEqual([])
      await controller.dispose(undefined, scenario)
      expect((await update).status).not.toBe("adopted")
      expect(controller.isPrepared()).toBe(false)
      expect(fixture.listenerCounts().progress).toBe(0)
      expect(faults).toEqual([])
    } else {
      expect(faults).toEqual([])
      expect(settled).toBe(false)
      expect(controller.isActive()).toBe(true)
      expect(fixture.calls.slice(before)).not.toContain("release")
      if (scenario.startsWith("sampled-remove-") || scenario.startsWith("sampled-replace-") || scenario.startsWith("sampled-change-"))
        expect(releasedAssetIds).toEqual([])
      const keepLatencyUpdate = scenario === "keep-latency-race"
        ? (() => {
          desiredKeepLatency = new Set(["instrument"])
          return controller.updateKeepLatency()
        })()
        : undefined
      if (scenario === "credits") {
        expect(rejected).toBe(true)
        expect(publishes).toBe(0)
        progress()
        for (let turn = 0; turn < 150; turn++) await Promise.resolve()
        expect(publishes).toBe(1)
      }
      if (scenario === "readiness") {
        expect(publishes).toBe(1)
        progress()
        for (let turn = 0; turn < 150; turn++) await Promise.resolve()
        expect(publishes).toBe(2)
      }
      if (scenario === "rebase" || scenario === "asset-add-rebase" || scenario === "paged-concurrent-refill") {
        if (scenario === "paged-concurrent-refill") {
          frame = 60_000n
          progress()
          for (let turn = 0; turn < 300; turn++) await Promise.resolve()
          const activeRefills = fixture.schedulePayloads.slice(originalWindows.length)
            .filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 0)
          expect(activeRefills.length).toBeGreaterThan(0)
        }
        progress()
        for (let turn = 0; turn < 150; turn++) await Promise.resolve()
        expect(publishes).toBe(2)
        if (scenario === "rebase") {
          const bindings = fixture.schedulePayloads.slice(originalWindows.length).map((bytes) => new DataView(bytes.buffer))
            .filter((view) => view.getUint32(60, true) === 2)
          expect(new Set(bindings.map((view) => view.getBigUint64(64, true))).size).toBe(2)
          expect(bindings.at(-1)?.getBigUint64(16, true)).toBe(seam)
        }
      }
      status = "published"
      activeRevision = stagedRevision
      fixture.setRuntimeRevision(activeRevision)
      frame = seam
      if (scenario === "stale-epoch") {
        const stale = reply()
        if (!stale.ok) throw new Error("Missing proof")
        fixture.bridge.session.revisions.inspect = async () => ({ ...stale,
          revision: { ...stale.revision, transportEpoch: epoch + 1 } })
        progress()
        expect((await update).status).not.toBe("adopted")
        expect(faults).toHaveLength(0)
        await controller.dispose()
        return
      }
      progress()
      expect(await update).toEqual({ status: "adopted" })
      if (scenario.startsWith("audio-") && !scenario.startsWith("audio-track-")) {
        const sources = decodeNativeSourceEvents(fixture.schedulePayloads.filter((bytes) =>
          new DataView(bytes.buffer).getUint32(60, true) === 2))
        expect(sources).toHaveLength(scenario === "audio-delete" ? 0 : 1)
        // The moved clip starts at 0.05 s (2400 frames); a seam bound before it no longer cuts it.
        if (scenario === "audio-move" || scenario === "audio-combined") expect(sources[0]?.startFrame).toBe(Math.max(Number(seam), 2400))
        if (scenario === "audio-trim") expect(sources[0]?.sourceOffsetFrame).toBe(Number(seam) + 12_000)
        if (scenario === "audio-tempo") expect(sources[0]?.startFrame).toBe(0)
        if (scenario === "audio-replace" || scenario === "audio-combined") {
          expect(sources[0]?.assetId).not.toBe(originalAssetIds[0])
          expect(fixture.installedAssets.slice(originalAssetIds.length)).toHaveLength(1)
          expect(releasedAssetIds).toEqual(originalAssetIds)
        }
      }
      if (scenario.startsWith("sampled-track-remove-")) expect(releasedAssetIds).toEqual(originalSampleAssetIds)
      if (scenario.startsWith("sampled-remove-") || scenario.startsWith("sampled-replace-") || scenario.startsWith("sampled-change-")) {
        expect(releasedAssetIds).toEqual(scenario === "sampled-remove-zone-seek-racing" ? [] : originalSampleAssetIds)
        expect(retainedAssetIds.every((id) => !releasedAssetIds.includes(id))).toBe(true)
        const addedIds = fixture.installedAssets.map(({ sessionAssetId }) => sessionAssetId)
          .filter((id) => !originalAssetIds.includes(id))
        expect(addedIds).toHaveLength(scenario === "sampled-change-key" ? 1 : 0)
        expect(addedIds.every((id) => !releasedAssetIds.includes(id))).toBe(true)
        if (scenario !== "sampled-remove-zone-seek-racing") {
          const callsBeforeReadd = fixture.calls.length
          const installedBeforeReadd = fixture.installedAssets.length
          readdingSample = true
          snapshotInput = { ...initialSnapshotInput, revision: 3 }
          stagedRevision = 3
          activeRevision = 2
          status = "prepared"
          const readd = controller.adoptSchedule(migrationIntent("public-migration-4"), true)
          for (let turn = 0; turn < 300; turn++) await Promise.resolve()
          expect(fixture.calls.slice(callsBeforeReadd)).not.toContain("start")
          status = "published"
          fixture.setRuntimeRevision(3)
          frame = seam
          progress()
          expect(await readd).toEqual({ status: "adopted" })
          expect(fixture.installedAssets.slice(installedBeforeReadd).map(({ sessionAssetId }) => sessionAssetId))
            .toEqual(originalSampleAssetIds)
          expect(fixture.calls.slice(callsBeforeReadd)).not.toContain("start")
          expect(fixture.calls.slice(callsBeforeReadd)).not.toContain("stop")
        }
      }
      if (scenario === "instrument-config") {
        const nextEvents = fixture.schedulePayloads.filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
        expect(nextEvents.some((bytes) => {
          const view = new DataView(bytes.buffer)
          return view.getUint32(44, true) > 0 && view.getUint32(72 + 28, true) === 0
            && view.getUint32(72 + 32, true) === 1
        })).toBe(true)
      }
      // A publication that adds no timeline source has no new pages to make resident before the seam binds.
      if (scenario === "clip-add-existing") expect(rangesAtFirstSeamChange).toBe(0)
      if (scenario === "asset-add-late-bind") {
        // The seam binds after hydration, and the pages are primed from the bound seam.
        expect(assetsAtFirstSeamChange).toBe(originalAssetIds.length + 1)
        // The new source's first pages are resident before the short bind spends its lead.
        expect(addedPagesAtFirstSeamChange).toBeGreaterThan(0)
        const stagedHeaders = fixture.schedulePayloads.slice(originalWindows.length)
          .filter((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 2)
          .map((bytes) => new DataView(bytes.buffer).getBigUint64(16, true))
        expect(stagedHeaders.length).toBeGreaterThan(0)
        expect(new Set(stagedHeaders)).toEqual(new Set([seam]))
      }
      if (scenario.startsWith("asset-add") || scenario === "clip-add-existing") {
        expect(fixture.installedAssets.slice(originalAssetIds.length)).toHaveLength(scenario === "clip-add-existing" ? 0 : 1)
        const originalPageKeys = new Set(originalPages.map((page) => `${page.sessionAssetId}:${page.startFrame}`))
        const rewrites = fixture.mappedPages.slice(originalPages.length)
          .filter((page) => originalPageKeys.has(`${page.sessionAssetId}:${page.startFrame}`))
        expect(rewrites.map((page) => page.startFrame)).toEqual([])
        const preparedSources = decodeNativeSourceEvents(fixture.schedulePayloads.filter((bytes) =>
          new DataView(bytes.buffer).getUint32(60, true) === 2))
        expect(preparedSources.some((source) => source.startFrame === 24_000)).toBe(true)
        if (scenario !== "asset-add-rebase") {
          expect(preparedSources.map(({ startFrame, stopFrame, sourceOffsetFrame }) => ({
            startFrame, stopFrame, sourceOffsetFrame,
          }))).toEqual([
            { startFrame: 0, stopFrame: Number(seam) + 96_000, sourceOffsetFrame: 0 },
            { startFrame: 24_000, stopFrame: Number(seam) + 96_000, sourceOffsetFrame: 0 },
          ])
        }
      }
      if (scenario.startsWith("sampled-add-")) {
        expect(fixture.installedAssets.slice(originalAssetIds.length)).toHaveLength(1)
        expect(fixture.mappedPages.filter((page) => !originalAssetIds.includes(page.sessionAssetId))
          .reduce((sum, page) => sum + page.frameCount, 0)).toBe(4_800)
      }
      if (scenario === "audio-track-remove") expect(fixture.calls.slice(before)).toContain("release")
      if (scenario === "audio-track-remove") {
        const next = fixture.installedAssets.length
        snapshotInput = { ...snapshotInput, revision: 3, tracks: [{ ...longSourceTrack(),
          clips: longSourceTrack().clips.map((clip) => ({ ...clip, bufferOffsetSec: 0.25 })) }, instrumentTrack] }
        stagedRevision = 3
        status = "prepared"
        const readd = controller.adoptSchedule(migrationIntent("public-migration-5"), true)
        for (let turn = 0; turn < 300; turn++) await Promise.resolve()
        expect(fixture.installedAssets.slice(next).map((asset) => asset.sessionAssetId)).toEqual(originalAssetIds)
        status = "published"
        activeRevision = 3
        fixture.setRuntimeRevision(3)
        frame = seam
        progress()
        expect(await readd).toEqual({ status: "adopted" })
        const sources = decodeNativeSourceEvents(fixture.schedulePayloads.filter((bytes) =>
          new DataView(bytes.buffer).getUint32(60, true) === 3))
        expect(sources[0]?.startFrame).toBe(Number(seam))
        expect(sources[0]?.sourceOffsetFrame).toBe(Number(seam) + 12_000)
      }
      if (scenario === "paged-concurrent-refill") {
        const assertConsumedSequenceOrder = (minimum: number, lowerBound: number) => {
          const consumed = fixture.schedulePayloads.flatMap((bytes, payloadIndex) => {
            const view = new DataView(bytes.buffer)
            const sourceCount = view.getUint32(48, true)
            const sourceOffset = 72 + view.getUint32(44, true) * 48
            const revision = view.getUint32(0, true)
            const preparedRevision = view.getUint32(60, true)
            return Array.from({ length: sourceCount }, (_, index) => {
              const offset = sourceOffset + index * 112
              return {
                payloadIndex,
                revision: preparedRevision === 0 ? revision : preparedRevision,
                isPrepared: preparedRevision !== 0,
                requestedFrame: Number(view.getBigUint64(64, true)),
                sequence: Number(view.getBigUint64(offset + 4, true)),
                startFrame: Number(view.getBigInt64(offset + 24, true)),
                stopFrame: Number(view.getBigInt64(offset + 32, true)),
              }
            })
          })
            .filter((event) => (!event.isPrepared && event.revision === activeRevision - 1
              && event.startFrame >= lowerBound && event.startFrame < Number(seam))
              || (event.isPrepared && event.revision === stagedRevision
                && event.requestedFrame === Number(seam) && event.stopFrame > Number(seam)))
            .sort((left, right) => Math.max(left.startFrame, left.requestedFrame) - Math.max(right.startFrame, right.requestedFrame)
              || left.payloadIndex - right.payloadIndex)
          expect(consumed.length).toBeGreaterThan(0)
          let lastSequence = minimum
          for (const event of consumed) {
            expect(event.sequence).toBeGreaterThan(lastSequence)
            lastSequence = event.sequence
          }
          return lastSequence
        }
        const previousSeam = Number(seam)
        const lastConsumedSequence = assertConsumedSequenceOrder(0, 0)
        stagedRevision = 3
        activeRevision = 2
        status = "prepared"
        snapshotInput = { ...snapshotInput, revision: stagedRevision }
        const secondPublication = controller.adoptSchedule(migrationIntent("public-migration-6"), true)
        for (let turn = 0; turn < 150; turn++) await Promise.resolve()
        expect(publishes).toBe(3)
        status = "published"
        activeRevision = stagedRevision
        fixture.setRuntimeRevision(activeRevision)
        frame = seam
        progress()
        expect(await secondPublication).toEqual({ status: "adopted" })
        assertConsumedSequenceOrder(lastConsumedSequence, previousSeam)
      }
      if (sampledKind && scenario !== "paged-concurrent-refill") {
        fixture.setRuntimeRevision(2)
        for (const renderedFrame of [60_000n, 120_000n, 180_000n, 240_000n, 300_000n, 360_000n]) {
          frame = renderedFrame
          progress()
          for (let turn = 0; turn < 300; turn++) await Promise.resolve()
        }
        const sources = decodeNativeSourceEvents(fixture.schedulePayloads)
        expect(sources.length).toBeGreaterThan(4)
        let stop = 0
        let lastSequence = 0
        for (const source of sources) {
          if (source.startFrame < stop) {
            expect(source.startFrame).toBe(0)
            expect(source.sourceOffsetFrame).toBe(0)
          } else expect(source.startFrame).toBe(stop)
          // The native core retains its sequence floor across graph publication.
          expect(source.sequence).toBeGreaterThan(lastSequence)
          stop = source.stopFrame
          lastSequence = source.sequence
        }
        expect(stop).toBeGreaterThan(360_000)
        expect(fixture.preparedRanges.some((range) => range.startFrame > 96_000)).toBe(true)
        expect(fixture.listenerCounts().progress).toBe(1)
      }
      if (keepLatencyUpdate) {
        let reconciled = false
        void keepLatencyUpdate.then(() => { reconciled = true })
        for (let retry = 0; retry < 12 && !reconciled; retry++) {
          progress()
          for (let turn = 0; turn < 150; turn++) await Promise.resolve()
        }
        if (!reconciled) throw new Error(`Keep Latency reconciliation stalled: ${fixture.calls.join(",")}`)
        expect(await keepLatencyUpdate).toEqual({ handled: true })
        expect(fixture.calls.filter((call) => call === "stage-prepare")).toHaveLength(1)
        expect(fixture.calls.filter((call) => call === "revision-prepare")).toHaveLength(1)
        const stagedGraph = fixture.graphPayloads.at(-2)
        const reconciledGraph = fixture.graphPayloads.at(-1)
        if (!stagedGraph || !reconciledGraph) throw new Error("Missing Keep Latency publication graphs")
        const stagedView = new DataView(stagedGraph.buffer, stagedGraph.byteOffset)
        const reconciledView = new DataView(reconciledGraph.buffer, reconciledGraph.byteOffset)
        expect(stagedView.getUint32(12, true)).toBe(3)
        expect(reconciledView.getUint32(12, true)).toBe(5)
        const keepLatencyNodeCount = Array.from({ length: reconciledView.getUint32(20, true) }, (_, index) => index)
          .filter((index) => reconciledView.getUint32(36 + index * 140 + 32, true) === 1).length
        expect(keepLatencyNodeCount).toBe(1)
      }
      expect(controller.isActive()).toBe(true)
      expect(faults).toEqual([])
      expect(fixture.transports.at(-1)?.epoch).toBe(epoch)
    }
    expect(fixture.schedulePayloads.slice(0, originalWindows.length)).toEqual(originalWindows)
    if (!scenario.startsWith("seek") && scenario !== "audio-seek" && !scenario.endsWith("-seek-racing") && scenario !== "sampled-remove-zone-cancel" && scenario !== "stop" && scenario !== "project-switch" && scenario !== "asset-add-cancel"
      && scenario !== "chunk-cancel" && scenario !== "hydration-cancel" && scenario !== "asset-add-hydration-cancel")
      expect(fixture.calls.slice(before).filter((call) => ["stop", "transport", "start"].includes(call)))
        .toEqual(["audio-tempo", "audio-combined"].includes(scenario) ? ["transport"] : [])
    await controller.dispose()
  })
}

for (const accepted of [true, false]) test(`tempo and meter context is revision-staged only after prepare admission (${accepted})`, async () => {
  const fixture = createBridge("runtime-revision-progress")
  let changed = false
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...input(), transport, bpm: changed ? 137 : 120,
      timeSignature: { numerator: changed ? 3 : 4, denominator: 4 },
    }),
  })
  try {
    expect(await controller.start(input().transport)).toBe("started")
    const before = fixture.calls.length
    const previous = fixture.transportContexts.at(-1)
    changed = true
    acknowledgeStagedPublication(fixture)
    const prepare = fixture.bridge.session.revisions.prepare
    fixture.bridge.session.revisions.prepare = async (request) => {
      expect(fixture.transportContexts.at(-1)).toBe(previous)
      return accepted ? prepare(request) : { ok: false, error: "rejected", kind: "refused" }
    }
    const result = await controller.adoptSchedule(migrationIntent("public-migration-7"), true)
    expect(result.status === "adopted").toBe(accepted)
    if (accepted) expect(fixture.transportContexts.at(-1)).toMatchObject({
      bpm: 137, timeSignatureNumerator: 3, timeSignatureDenominator: 4,
      epoch: previous?.epoch, transitionId: previous?.transitionId, running: true,
    })
    else expect(fixture.transportContexts.at(-1)).toBe(previous)
    expect(fixture.calls.slice(before).filter((call) => ["stop", "begin", "graph", "teardown"].includes(call))).toEqual([])
  } finally { await controller.destroy() }
})

for (const unsupported of ["sidechain", "midi-mappings", "midi-device-mapping", "missing-attachment-plan"]) {
  test(`shared native admission rejects live ${unsupported} before staging and at startup`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    let changed = false
    // E6: MIDI expression automation and a sidechain are limitations of the native graph, never defects.
    const limitation = unsupported !== "missing-attachment-plan"
    const snapshotInput = nativeInstrumentInput()
    clearInstanceLimits()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      compileSnapshot: async (transport) => {
        const compiled = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
        if (!changed || !compiled.supported) return compiled
        const snapshot = compiled.snapshot
        return { ...compiled, snapshot: { ...snapshot, revision: 2,
          nativeExternalAttachmentPlan: limitation ? nativeAttachmentPlan : undefined,
          requiresNativePlayback: unsupported === "missing-attachment-plan",
          mixer: { ...snapshot.mixer, sidechainRoutes: unsupported === "sidechain"
            ? [{ sourceTrackId: "instrument", targetTrackId: "master", effectInstanceId: "external" }] : [] },
          tracks: unsupported.startsWith("midi") ? snapshot.tracks.map((track) => ({ ...track,
            clips: track.clips.map((clip) => ({ ...clip, midi: clip.midi && { ...clip.midi,
              mappings: [{ id: "mapping", source: { kind: "cc", controller: 1, channel: 1 },
                target: unsupported === "midi-device-mapping" ? { parameterId: "gain", effectInstanceId: "external" } : { parameterId: "gain" },
                outputMin: 0, outputMax: 1 }] } })),
          })) : snapshot.tracks,
        } }
      },
    })
    try {
      expect(await controller.start(snapshotInput.transport)).toBe("started")
      changed = true
      expect(await controller.adoptSchedule(migrationIntent(`unsupported-${unsupported}`), true))
        .toMatchObject({ status: limitation ? "unsupported" : "failed" })
      expect(fixture.calls).not.toContain("revision-prepare")
      expect(controller.isActive()).toBe(true)
      // The notice sits on the element the routing belongs to: the device whose sidechain input is set, or, for a mapping
      // that targets no device, the track it sits on. The plug-in the graph merely holds carries none.
      expect({ device: instanceLimit("external"), track: instanceLimit(snapshotInput.tracks[0]!.id), plugin: instanceLimit(nativeAttachmentPlan.attachments[0].instanceId) })
        .toEqual({
          device: unsupported === "sidechain" ? "The native VST3 graph cannot activate with the current sidechain routing."
            : unsupported === "midi-device-mapping" ? "Native VST3 playback does not support MIDI expression automation yet." : undefined,
          track: unsupported === "midi-mappings" ? "Native VST3 playback does not support MIDI expression automation yet." : undefined,
          plugin: undefined })
      await controller.dispose()
      expect(await controller.start(snapshotInput.transport)).toBe(
        unsupported === "missing-attachment-plan" ? "blocked" : "unavailable")
      expect(fixture.calls).not.toContain("revision-prepare")
    } finally { await controller.dispose() }
  })
}

for (const edit of ["vst-state", "vst-state-requirements", "time-signature"]) {
  test(`native staged admission adopts a ${edit} change live and hands plug-in state to the host, never rebuilding`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    let changed = false
    const snapshotInput = input()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      compileSnapshot: async (transport) => {
        const compiled = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
        if (!compiled.supported) return compiled
        const instanceId = nativeAttachmentPlan.attachments[0]!.instanceId
        return { ...compiled, snapshot: { ...compiled.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          nativeExternalAttachmentStates: [{ instanceId, bytes: new Uint8Array([changed && edit === "vst-state" ? 2 : 1]),
            sha256: changed && edit === "vst-state" ? "b".repeat(64) : "a".repeat(64) }],
          nativeExternalAttachmentStateRequirements: changed && edit === "vst-state-requirements" ? [instanceId] : [],
          timeSignature: { numerator: changed && edit === "time-signature" ? 3 : 4, denominator: 4 },
        } }
      },
    })
    try {
      expect(await controller.start(snapshotInput.transport)).toBe("started")
      const startupCoordinations = fixture.coordinations.length
      acknowledgeStagedPublication(fixture)
      expect(await controller.adoptSchedule(migrationIntent(`startup-${edit}`), true)).toEqual({ status: "adopted" })
      changed = true
      acknowledgeStagedPublication(fixture)
      expect(await controller.adoptSchedule(migrationIntent(`changed-${edit}`), true)).toEqual({ status: "adopted" })
      expect(fixture.coordinations.length - startupCoordinations).toBe(edit === "time-signature" ? 0 : 1)
      expect(controller.isActive()).toBe(true)
    } finally { await controller.dispose() }
  })
}

const vstJoinFixture = () => {
  const fixture = createBridge("runtime-revision-progress")
  let inserted = false
  const snapshotInput = input()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    reportFault: (fault) => { faults.push(fault.kind) },
    compileSnapshot: async (transport) => {
      const compiled = compileLivePlaybackSnapshot({ ...snapshotInput, transport })
      return compiled.supported && inserted
        ? { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } } : compiled
    },
  })
  const edit = (next: boolean, key: string) => {
    inserted = next
    acknowledgeStagedPublication(fixture)
    return controller.adoptSchedule(migrationIntent(key), true)
  }
  return { fixture, controller, edit, faults, transport: snapshotInput.transport }
}

test("insert, remove and undo of a trusted VST while playing stage live, never stopping or rebuilding", async () => {
  const { fixture, controller, edit, transport } = vstJoinFixture()
  try {
    expect(await controller.start(transport)).toBe("started")
    const startCalls = fixture.calls.length
    const attachmentCounts = () => fixture.coordinations.map((plan) => z.object({ attachments: z.array(z.unknown()) }).parse(JSON.parse(plan)).attachments.length)
    const steps: [boolean, string, number[]][] = [[true, "insert", [1]], [false, "remove", [1, 0]], [true, "undo", [1, 0, 1]]]
    for (const [inserted, key, counts] of steps) {
      expect(await edit(inserted, key)).toEqual({ status: "adopted" })
      expect(attachmentCounts()).toEqual(counts)
    }
    const live = fixture.calls.slice(startCalls)
    expect(live.filter((call) => call === "coordinate")).toHaveLength(3)
    for (const call of ["stop", "teardown", "start", "prepare", "begin-transaction"]) expect(live).not.toContain(call)
    // Every attachment goes to the host before the graph that binds it is prepared.
    expect(live.indexOf("stage-prepare")).toBeGreaterThan(live.indexOf("coordinate"))
    expect(controller.isActive()).toBe(true)
  } finally { await controller.dispose() }
})

test("a Play that starts while a paused VST insertion is still being staged leaves the transport running", async () => {
  const { fixture, controller, edit, transport } = vstJoinFixture()
  const coordinate = fixture.bridge.session.coordinateVstAttachments
  const staging = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  fixture.bridge.session.coordinateVstAttachments = async (request) => {
    entered.resolve()
    await staging.promise
    return coordinate(request)
  }
  try {
    expect(await controller.ensureLivePreview(0)).toBe("started")
    const insertion = edit(true, "insert")
    await entered.promise
    const play = controller.start(transport)
    staging.resolve()
    expect(await insertion).toEqual({ status: "adopted" })
    expect(await play).toBe("started")
    expect({ active: controller.isActive(), running: fixture.transports.at(-1)?.running }).toEqual({ active: true, running: true })
  } finally { await controller.dispose() }
})

// Each refused staging waits for native progress reports, never a timer: this feeds one per macrotask until `done`.
const feedProgress = async (fixture: ReturnType<typeof createBridge>, done: () => boolean) => {
  for (let frame = 0; !done() && frame < 2000; frame++) {
    fixture.emitProgress(frame)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

test("a transient VST staging refusal retries on native progress with no further edit, and binds", async () => {
  const { fixture, controller, edit, faults, transport } = vstJoinFixture()
  const coordinate = fixture.bridge.session.coordinateVstAttachments
  let refusals = 2
  let attempts = 0
  fixture.bridge.session.coordinateVstAttachments = async (request) => {
    attempts++
    return refusals-- > 0 ? { ok: false as const, error: "staging failed" } : coordinate(request)
  }
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    expect(await controller.start(transport)).toBe("started")
    const before = fixture.calls.length
    const adopted = edit(true, "insert")
    await feedProgress(fixture, () => attempts >= 3)
    expect(await adopted).toEqual({ status: "adopted" })
    expect(attempts).toBe(3)
    expect(fixture.coordinations).toHaveLength(1)
    expect(warnings.filter(([message]) => String(message).includes("VST staging refused"))).toHaveLength(2)
    expect(faults).toEqual([])
    for (const call of ["stop", "teardown"]) expect(fixture.calls.slice(before)).not.toContain(call)
  } finally { console.warn = warn; await controller.dispose() }
})

test("a persistent VST staging refusal stops after 8 resubmits with a defect log, and the old graph keeps playing", async () => {
  const { fixture, controller, edit, faults, transport } = vstJoinFixture()
  let attempts = 0
  fixture.bridge.session.coordinateVstAttachments = async () => { attempts++; return { ok: false as const, error: "staging failed" } }
  const warn = console.warn
  const error = console.error
  const defects: unknown[][] = []
  console.warn = () => undefined
  console.error = (...args: unknown[]) => { defects.push(args) }
  try {
    expect(await controller.start(transport)).toBe("started")
    const before = fixture.calls.length
    const failed = edit(true, "insert")
    await feedProgress(fixture, () => defects.length > 0)
    expect(await failed).toMatchObject({ status: "failed" })
    expect(attempts).toBe(9)
    expect(defects).toHaveLength(1)
    expect(String(defects[0]?.[0])).toContain("defect")
    expect(controller.isActive()).toBe(true)
    expect(faults).toEqual([])
    expect(fixture.calls.slice(before)).not.toContain("stage-prepare")
    for (const call of ["stop", "teardown"]) expect(fixture.calls.slice(before)).not.toContain(call)
  } finally { console.warn = warn; console.error = error; await controller.dispose() }
})

// UD 11: a plug-in that crashes or errors while it is staged fails the same way every time, so it is shown on its device
// and never retried or logged as our defect.
test("a plug-in that crashes during live staging is marked failed on its device, never retried and not logged as a defect", async () => {
  const { fixture, controller, edit, faults, transport } = vstJoinFixture()
  const instanceId = nativeAttachmentPlan.attachments[0].instanceId
  let attempts = 0
  fixture.bridge.session.coordinateVstAttachments = async () => {
    attempts++
    return { ok: false, error: "The native VST3 worker preflight failed.", failure: { code: "worker-crashed", origin: "plugin", instanceId } }
  }
  const warn = console.warn
  const error = console.error
  const logs: unknown[][] = []
  console.warn = (...args: unknown[]) => { logs.push(args) }
  console.error = (...args: unknown[]) => { logs.push(args) }
  try {
    expect(await controller.start(transport)).toBe("started")
    expect(vstInstanceFailed(instanceId)).toBe(false)
    expect(await edit(true, "insert")).toMatchObject({ status: "failed" })
    expect({ attempts, failed: vstInstanceFailed(instanceId), defects: logs.filter(([message]) => String(message).includes("defect")), faults, active: controller.isActive() })
      .toEqual({ attempts: 1, failed: true, defects: [], faults: [], active: true })
    expect(logs.filter(([message]) => String(message).includes("staging refused"))).toEqual([])
  } finally { console.warn = warn; console.error = error; await controller.dispose() }
})

// Our own refusals keep the retry; a host failure that names an instance must not mark it failed.
test("a host-side staging refusal that names an instance retries and does not mark the instance failed", async () => {
  const { fixture, controller, edit, transport } = vstJoinFixture()
  const instanceId = nativeAttachmentPlan.attachments[0].instanceId
  let attempts = 0
  fixture.bridge.session.coordinateVstAttachments = async () => {
    attempts++
    return { ok: false, error: "The native VST3 attachment transaction failed.", failure: { code: "native-transaction-failed", origin: "host", instanceId } }
  }
  const warn = console.warn
  const error = console.error
  console.warn = () => undefined
  console.error = () => undefined
  try {
    expect(await controller.start(transport)).toBe("started")
    const failed = edit(true, "insert")
    await feedProgress(fixture, () => attempts >= 9)
    expect(await failed).toMatchObject({ status: "failed" })
    expect({ attempts, failed: vstInstanceFailed(instanceId) }).toEqual({ attempts: 9, failed: false })
  } finally { console.warn = warn; console.error = error; await controller.dispose() }
})

for (const transport of ["seek", "pause"]) {
  test(`active coverage hydration cannot block publication cancellation by ${transport}`, async () => {
    const fixture = createBridge("runtime-revision-progress")
    const prepare = fixture.bridge.session.revisions.prepare
    fixture.bridge.session.revisions.prepare = async (request) => {
      const reply = await prepare(request)
      fixture.setRuntimeRevision(1)
      return reply
    }
    const snapshotInput = input(longSourceTrack())
    const entered = Promise.withResolvers<void>()
    const hydration = Promise.withResolvers<BridgeReply>()
    let hold = false
    const prepareRange = fixture.bridge.session.prepareMappedAssetRange
    fixture.bridge.session.prepareMappedAssetRange = async (...args) => {
      if (hold) { entered.resolve(); return hydration.promise }
      return prepareRange(...args)
    }
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      resolveSource: async () => longSourceDescriptor(),
      compileSnapshot: async (state) => compileLivePlaybackSnapshot({ ...snapshotInput, transport: state }),
    })
    try {
      expect(await controller.start(snapshotInput.transport)).toBe("started")
      hold = true
      const epoch = fixture.transports.at(-1)!.epoch
      fixture.emitScheduleProgress({ revision: 1, epoch, progressSequence: 100n,
        renderedThroughFrame: 96_000n, acceptedThroughFrame: 96_000n, lastAcceptedWindowId: 1n,
        appliedTransportTransitionId: 1n, appliedUrgentSequence: 0n, appliedProcessorSequence: 0n,
        running: true, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256 })
      await entered.promise
      const update = controller.adoptSchedule(migrationIntent("public-migration-8"), true)
      for (let turn = 0; turn < 150; turn++) await Promise.resolve()
      expect(fixture.calls).toContain("revision-prepare")
      expect(fixture.schedulePayloads.every((bytes) => new DataView(bytes.buffer).getUint32(60, true) === 0)).toBe(true)
      hold = false
      let completed = false
      const transition = transport === "seek" ? controller.seekPrepared(0) : controller.pause(0)
      void transition.then(() => { completed = true })
      for (let turn = 0; turn < 300; turn++) await Promise.resolve()
      expect(completed).toBe(true)
      expect((await update).status).not.toBe("adopted")
      await transition
      expect(controller.isPrepared()).toBe(true)
      hydration.resolve({ ok: true })
      if (transport === "pause") expect(await controller.start(snapshotInput.transport)).toBe("started")
      expect(await controller.seekPrepared(0)).toBe("started")
      expect(controller.isActive()).toBe(true)
    } finally {
      hydration.resolve({ ok: true })
      await controller.dispose()
    }
  })
}

test("publishes latency-changing spectral state through live revisions, never a cheap patch", async () => {
  const fixture = createBridge("runtime-revision-progress")
  const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(), tracks: [sourceTrack(), { ...sourceTrack(), id: "parallel", clips: [] }], renderState: { fx: { masterVolume: 1, masterFxInstances: [],
      trackFx: { track: { instances: [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: from } }] } } },
      automationEnvelopes: [] },
  }
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => new Set(["track"]),
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  const meterBatches: Array<ReadonlyMap<string, { left: number; right: number }>> = []
  const unsubscribeMeters = controller.subscribeTrackMeters((levels) => meterBatches.push(levels))
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  fixture.emitMeterBatch({ graphRevision: 1, transportEpoch: 1, sequence: 50n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 0.2, rightRms: 0.3 }] })
  const before = fixture.calls.length
  await expect(controller.deliverProcessor(fixturePatchEdit({ bpm: 120, payload: {
    effect: "spectral", instanceId: "spectral:1", targetId: "track",
    from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize: 4096 } },
  } })).settled).resolves.toEqual({ state: "applied" })
  expect(fixture.calls.slice(before)).toEqual(["revision-prepare", "revision-publish", "revision-retire"])
  expect(fixture.statePatchPayloads).toHaveLength(0)
  const meterCount = meterBatches.length
  fixture.emitMeterBatch({ graphRevision: 2, transportEpoch: 1, sequence: 49n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 1, rightRms: 1 }] })
  expect(meterBatches).toHaveLength(meterCount)
  fixture.emitMeterBatch({ graphRevision: 2, transportEpoch: 1, sequence: 51n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 0.4, rightRms: 0.5 }] })
  expect(meterBatches.at(-1)).toEqual(new Map([["track", { left: 0.4, right: 0.5 }]]))
  const payload = fixture.graphPayloads.at(-1)
  if (!payload) throw new Error("Missing live graph")
  const view = new DataView(payload.buffer, payload.byteOffset)
  const nodeBytes = view.getUint32(12, true) === 5 ? 140 : view.getUint32(12, true) === 4 ? 136 : 132
  const edges = 36 + view.getUint32(20, true) * nodeBytes
  expect(view.getUint32(edges + 48 + 44, true)).toBe(4096)
  const seek = controller.seekPrepared(0)
  // Drain queued bridge work, not wall-clock audio progress.
  let settled = false
  void seek.then(() => { settled = true })
  for (let turn = 0; turn < 50; turn++) await Promise.resolve()
  try {
    expect(settled).toBeTrue()
    await expect(seek).resolves.toBe("started")
    const schedule = fixture.schedulePayloads.at(-1)
    if (!schedule) throw new Error("Missing post-publication schedule")
    expect(new DataView(schedule.buffer).getUint32(0, true)).toBe(2)
  } finally {
    await controller.dispose()
    unsubscribeMeters()
    await seek.catch(() => undefined)
  }
})

for (const scenario of ["lost reply", "lost reply and failed inspection", "pending then completion", "late success"]) {
  test(`recovers latency publication after ${scenario}`, async () => {
    const fixture = createBridge()
    let published = false
    let inspectionRecovered = scenario !== "lost reply and failed inspection"
    const proof = () => fixture.revisionReply("published")
    fixture.bridge.session.revisions.publish = async () => {
      if (scenario.startsWith("lost reply")) { published = true; throw new Error("Reply lost") }
      if (scenario === "late success") return new Promise<NativeRevisionReply>((resolve) => {
        lateReply = resolve
      })
      const result = await proof()
      if (!result.ok) return result
      return { ...result, revision: { ...result.revision, status: "publish-pending", activeRevision: 1 } }
    }
    let inspections = 0
    fixture.bridge.session.revisions.inspect = async () => {
      inspections++
      if (!inspectionRecovered) throw new Error("Inspection unavailable")
      const result = await proof()
      if (!result.ok || published) return result
      return { ...result, revision: { ...result.revision, status: "publish-pending", activeRevision: 1 } }
    }
    let lateReply: ((reply: NativeRevisionReply) => void) | undefined
    let desired = new Set<string>()
    const snapshotInput = { ...nativeInstrumentInput(), tracks: [{
      ...instrumentTrack, clips: instrumentTrack.clips.map((clip) => ({ ...clip, duration: 30 })),
    }] }
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getKeepLatencyNodeIds: () => desired,
      compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
    })
    await controller.start(snapshotInput.transport)
    const firstWindow = fixture.schedulePayloads.at(-1)
    if (!firstWindow) throw new Error("Initial schedule missing")
    const epoch = new DataView(firstWindow.buffer, firstWindow.byteOffset).getUint32(4, true)
    desired = new Set(["instrument"])
    let finished = false
    const update = controller.updateKeepLatency().then((result) => { finished = true; return result })
    await Bun.sleep(0)
    if (scenario !== "lost reply") {
      expect(finished).toBeFalse()
      if (scenario === "lost reply and failed inspection") expect(inspections).toBeGreaterThan(0)
      inspectionRecovered = true
      published = true
      fixture.emitScheduleProgress({
        revision: 2, epoch, progressSequence: 100n, renderedThroughFrame: 2048n,
        acceptedThroughFrame: 4096n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
        appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: false,
        scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
      })
    }
    expect(await update).toEqual({ handled: true })
    const windowsBeforeProgress = fixture.schedulePayloads.length
    fixture.emitScheduleProgress({
      revision: 2, epoch, progressSequence: 101n, renderedThroughFrame: 72000n,
      acceptedThroughFrame: 96000n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
      appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: true,
      scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    })
    await Bun.sleep(0)
    const resumedWindows = fixture.schedulePayloads.slice(windowsBeforeProgress)
    expect(resumedWindows.length).toBeGreaterThan(0)
    expect(resumedWindows.every((bytes) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === 2)).toBeTrue()
    lateReply?.(await proof())
    expect(controller.isPrepared()).toBe(true)
    expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(1)
    expect(fixture.calls).not.toContain("revision-rollback")
    expect(fixture.calls).not.toContain("stop")
    expect(fixture.calls).not.toContain("teardown")
    await controller.dispose()
  })
}

for (const phase of ["prepare", "publish", "retire"]) {
  test(`retries pending latency ${phase} once after completion`, async () => {
    const fixture = createBridge()
    let complete = false
    let attempts = 0
    const revisions = fixture.bridge.session.revisions
    const pendingReply = (result: NativeRevisionReply): NativeRevisionReply => {
      attempts++
      if (!result.ok || complete) return result
      return { ...result, revision: { ...result.revision,
        status: phase === "retire" ? "retirement-not-safe" : "publish-pending" } }
    }
    if (phase === "prepare") {
      const prepare = revisions.prepare
      revisions.prepare = async (request) => pendingReply(complete
        ? await prepare(request) : fixture.revisionReply("prepared"))
    } else if (phase === "publish") {
      const publish = revisions.publish
      revisions.publish = async (request) => pendingReply(await publish(request))
    } else {
      const retire = revisions.retire
      revisions.retire = async (request) => pendingReply(await retire(request))
    }
    fixture.bridge.session.revisions.inspect = async (request) => {
      const result = fixture.revisionReply(request.revision === 0 ? "stale-revision" : "prepared")
      if (!result.ok || complete) return result
      return { ...result, revision: { ...result.revision, status: "publish-pending" } }
    }
    let desired = new Set<string>()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getKeepLatencyNodeIds: () => desired,
      compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    })
    await controller.ensureLivePreview(0)
    desired = new Set(["track"])
    let settled = false
    const update = controller.updateKeepLatency().then((result) => { settled = true; return result })
    await Bun.sleep(0)
    expect(settled).toBe(phase === "retire")
    const progress: NativeScheduleProgress = {
      revision: 1, epoch: 1, progressSequence: 100n, renderedThroughFrame: phase === "retire" ? 0n : 2048n,
      acceptedThroughFrame: 4096n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
      appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: false,
      scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    }
    fixture.emitScheduleProgress(progress)
    await Bun.sleep(0)
    expect(attempts).toBe(1)
    if (phase === "retire") await expect(update).resolves.toEqual({ handled: true })
    complete = true
    fixture.emitScheduleProgress({ ...progress, progressSequence: 101n, latencyCompletionGeneration: 1n })
    await expect(update).resolves.toEqual({ handled: true })
    await step7Turns()
    expect(attempts).toBe(2)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 102n, latencyCompletionGeneration: 1n })
    await Bun.sleep(0)
    expect(attempts).toBe(2)
    expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(1)
    expect(fixture.calls).not.toContain("stop")
    expect(fixture.calls).not.toContain("teardown")
    await controller.dispose()
  })
}

for (const stamps of ["increasing", "equal"]) for (const phase of ["prepare", "publish"]) test(`coalesces two edits with ${stamps} stamps into the newest pending latency graph during ${phase}`, async () => {
  const fixture = createBridge("runtime-revision-progress")
  const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(), processorStateSequence: 10, renderState: { fx: { masterVolume: 1, masterFxInstances: [],
      trackFx: { track: { instances: [
        { id: "spectral:1", kind: "spectral", params: { version: 1, state: from } },
        { id: "spectral:2", kind: "spectral", params: { version: 1, state: from } },
      ] } } }, automationEnvelopes: [] },
  }
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  let complete = false
  const prepare = fixture.bridge.session.revisions.prepare
  let submitted: Uint8Array | undefined
  fixture.bridge.session.revisions.prepare = async (request) => {
    if (complete) { submitted = request.bytes; return prepare(request) }
    return phase === "prepare" ? fixture.revisionReply("publish-pending") : prepare(request)
  }
  const publish = fixture.bridge.session.revisions.publish
  fixture.bridge.session.revisions.publish = async (request) =>
    complete ? publish(request) : fixture.revisionReply("publish-pending")
  fixture.bridge.session.revisions.inspect = async () =>
    fixture.revisionReply(complete ? phase === "prepare" ? "stale-revision" : "prepared" : "publish-pending")
  let sequence = 10
  const patch = (instanceId: string, fftSize: 2048 | 4096) => controller.deliverProcessor(fixturePatchEdit({
    bpm: 120, processorStateSequence: stamps === "equal" ? 11 : ++sequence, payload: {
    effect: "spectral", instanceId, targetId: "track",
    from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize } },
  } })).settled
  const first = patch("spectral:1", 2048)
  await Bun.sleep(0)
  const second = patch("spectral:2", 4096)
  const newest = patch("spectral:1", 4096)
  await Bun.sleep(0)
  complete = true
  fixture.emitScheduleProgress({
    revision: 1, epoch: 1, progressSequence: 100n, renderedThroughFrame: 2048n,
    acceptedThroughFrame: 4096n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: false,
    scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
  })
  expect(await Promise.all([first, second, newest])).toEqual([{ state: "superseded", by: stamps === "equal" ? 11 : 13 }, { state: "applied" }, { state: "applied" }])
  expect(fixture.calls.filter((call) => call === "revision-publish")).toHaveLength(1)
  if (!submitted) throw new Error("Missing newest graph")
  // Both spectral processor headers carry the latest 4096-frame latency.
  const view = new DataView(submitted.buffer, submitted.byteOffset)
  const nodeBytes = view.getUint32(12, true) === 5 ? 140 : view.getUint32(12, true) === 4 ? 136 : 132
  const processorStart = 36 + view.getUint32(20, true) * nodeBytes + view.getUint32(24, true) * 48
  expect(view.getUint32(processorStart + 40, true)).toBe(4096)
  const secondProcessor = processorStart + 48 + view.getUint32(processorStart + 16, true)
    + view.getUint32(processorStart + 36, true) * 4
  expect(view.getUint32(secondProcessor + 40, true)).toBe(4096)
  const prepareAfterAbsorption = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "Rejected follow-up edit", kind: "refused" })
  expect(await patch("spectral:1", 2048)).toMatchObject({ state: "refused" })
  fixture.bridge.session.revisions.prepare = prepareAfterAbsorption
  // The refused follow-up stays desired: a later candidate compiled from the older model carries it, not the
  // absorbed 4096 or the older model's 512.
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-13")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

  acknowledgeStagedPublication(fixture)
  const prepareCandidate = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = (request) => {
    submitted = request.bytes
    return prepareCandidate(request)
  }
  expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
  const rebased = new DataView(submitted.buffer, submitted.byteOffset)
  expect(rebased.getUint32(processorStart + 40, true)).toBe(2048)
  await controller.dispose()
})

test("latency coalescing rejects a processor patch below the published sequence floor", async () => {
  const fixture = createBridge()
  const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(),
    processorStateSequence: 10,
    renderState: { fx: { masterVolume: 1, masterFxInstances: [],
      trackFx: { track: { instances: [
        { id: "spectral:1", kind: "spectral", params: { version: 1, state: from } },
        { id: "spectral:2", kind: "spectral", params: { version: 1, state: from } },
      ] } } }, automationEnvelopes: [] },
  }
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await controller.ensureLivePreview(0)
  let complete = false
  const prepare = fixture.bridge.session.revisions.prepare
  let submitted: Uint8Array | undefined
  fixture.bridge.session.revisions.prepare = async (request) => {
    if (complete) { submitted = request.bytes; return prepare(request) }
    return fixture.revisionReply("publish-pending")
  }
  fixture.bridge.session.revisions.inspect = async () =>
    fixture.revisionReply(complete ? "stale-revision" : "publish-pending")
  const latencyEdit = controller.deliverProcessor(fixturePatchEdit({ bpm: 120, processorStateSequence: 11, payload: {
    effect: "spectral", instanceId: "spectral:2", targetId: "track",
    from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize: 4096 } },
  } })).settled
  await Bun.sleep(0)
  const staleEdit = controller.deliverProcessor(fixturePatchEdit({ bpm: 120, processorStateSequence: 9, payload: {
    effect: "spectral", instanceId: "spectral:1", targetId: "track",
    from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize: 4096 } },
  } })).settled
  await Bun.sleep(0)
  complete = true
  fixture.emitScheduleProgress({
    revision: 1, epoch: 1, progressSequence: 100n, renderedThroughFrame: 2048n,
    acceptedThroughFrame: 4096n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: false,
    scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
  })
  await expect(Promise.all([latencyEdit, staleEdit])).resolves.toEqual([{ state: "applied" }, { state: "superseded", by: 10 }])
  if (!submitted) throw new Error("Missing latency graph")
  const view = new DataView(submitted.buffer, submitted.byteOffset)
  const nodeBytes = view.getUint32(12, true) === 5 ? 140 : view.getUint32(12, true) === 4 ? 136 : 132
  const processorStart = 36 + view.getUint32(20, true) * nodeBytes + view.getUint32(24, true) * 48
  expect(view.getUint32(processorStart + 40, true)).toBe(512)
  await controller.dispose()
})

for (const phase of ["prepare", "publish", "retire"]) for (const cancellation of ["stop", "loss", "device-loss", "dispose"]) {
  test(`clears pending latency ${phase} work and listeners on ${cancellation}`, async () => {
    const fixture = createBridge()
    let desired = new Set<string>()
    const faults: string[] = []
    let currentInput = input()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getKeepLatencyNodeIds: () => desired,
      compileSnapshot: async () => compileLivePlaybackSnapshot(currentInput),
      reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
    })
    await controller.ensureLivePreview(0)
    let attempts = 0
    const pendingReply = (): NativeRevisionReply => {
      attempts++
      return fixture.revisionReply(phase === "retire" ? "retirement-not-safe" : "publish-pending")
    }
    const revisions = { ...fixture.bridge.session.revisions }
    let latePublish: ((reply: NativeRevisionReply) => void) | undefined
    if (phase === "prepare") fixture.bridge.session.revisions.prepare = async () => pendingReply()
    else if (phase === "publish") {
      fixture.bridge.session.revisions.publish = () => {
        const reply = pendingReply()
        return cancellation === "device-loss"
          ? new Promise((resolve) => { latePublish = resolve })
          : Promise.resolve(reply)
      }
      fixture.bridge.session.revisions.inspect = async () => fixture.revisionReply("publish-pending")
    } else fixture.bridge.session.revisions.retire = async () => pendingReply()
    desired = new Set(["track"])
    const pending = controller.updateKeepLatency()
    await Bun.sleep(0)
    expect(fixture.listenerCounts().progress).toBeGreaterThan(0)
    if (cancellation === "device-loss") {
      fixture.emitLoss("Audio output device was disconnected. Select an available device in Audio Settings.")
    } else if (cancellation === "loss") fixture.emitLoss("Host lost")
    else await controller.dispose(undefined, cancellation)
    await pending
    expect(attempts).toBe(1)
    expect(fixture.listenerCounts()).toEqual({ progress: 0, loss: 0 })
    if (cancellation === "device-loss") {
      expect(faults).toEqual(["Audio output device was disconnected. Select an available device in Audio Settings."])
      expect(controller.isPrepared()).toBeFalse()
      expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
      // Project edits continue while the device is unavailable. Recovery must
      // compile this current graph rather than replay the cancelled publication.
      const oldGraph = fixture.graphPayloads[0]
      currentInput = { ...currentInput, renderState: {
        fx: { masterVolume: 0.25, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [],
      } }
      Object.assign(fixture.bridge.session.revisions, revisions)
      await expect(controller.start(currentInput.transport)).resolves.toBe("started")
      expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
      expect(fixture.graphPayloads.at(-1)).not.toEqual(oldGraph)
      const recovered = fixture.graphPayloads.at(-1)
      if (!recovered) throw new Error("Missing recovered graph")
      const view = new DataView(recovered.buffer, recovered.byteOffset)
      const version = view.getUint32(12, true)
      const nodeBytes = version === 5 ? 140 : version === 4 ? 136 : 132
      const masterIndex = Array.from({ length: view.getUint32(20, true) }, (_, index) => index)
        .find((index) => view.getUint32(36 + index * nodeBytes + 8, true) === 6)
      if (masterIndex === undefined) throw new Error("Missing recovered master")
      const instrumentOffset = version === 5 ? 36 : version === 4 ? 32 : 28
      expect(view.getFloat32(36 + masterIndex * nodeBytes + instrumentOffset + 88, true)).toBe(0.25)
      const callsAfterRecovery = [...fixture.calls]
      latePublish?.(fixture.revisionReply("published"))
      await Promise.resolve()
      await Promise.resolve()
      expect(fixture.calls).toEqual(callsAfterRecovery)
      expect(controller.isPrepared()).toBeTrue()
      expect(attempts).toBe(1)
    }
    await controller.destroy()
    expect(fixture.listenerCounts()).toEqual({ progress: 0, loss: 0 })
  })
}

test("drops pending latency work when inspection reports a different host generation", async () => {
  const fixture = createBridge()
  let desired = new Set<string>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project", getKeepLatencyNodeIds: () => desired,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  await controller.ensureLivePreview(0)
  fixture.bridge.session.revisions.prepare = async () => fixture.revisionReply("publish-pending")
  fixture.bridge.session.revisions.inspect = async () => {
    const result = fixture.revisionReply("stale-revision")
    return result.ok ? { ...result, hostGeneration: result.hostGeneration + 1 } : result
  }
  desired = new Set(["track"])
  let settled = false
  const update = controller.updateKeepLatency().then((result) => { settled = true; return result })
  await Bun.sleep(0)
  fixture.emitScheduleProgress({
    revision: 1, epoch: 1, progressSequence: 100n, renderedThroughFrame: 2048n,
    acceptedThroughFrame: 4096n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
    appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: false,
    scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
  })
  await Bun.sleep(0)
  const settledBeforeDispose = settled
  await controller.dispose()
  await update
  expect(settledBeforeDispose).toBeTrue()
  expect(fixture.listenerCounts()).toEqual({ progress: 0, loss: 0 })
})

test("explains divergent mixed-bus Keep Latency rejection without rebuilding", async () => {
  const fixture = createBridge()
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    const result = await prepare(request)
    if (!result.ok) return result
    return { ...result, revision: { ...result.revision, status: "prepare-failed",
      continuity: "rejected", activeRevision: 1, preparedRevision: 0, diagnosticCode: 3 } }
  }
  let desired = new Set<string>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => desired,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  await controller.ensureLivePreview(0)
  desired = new Set(["track"])
  await expect(controller.updateKeepLatency()).resolves.toEqual({ handled: false, reason: "latency-unsupported",
    error: "Keep Latency can't be used here: this bus mixes monitored and other tracks, then splits to outputs with different latency. Route them through separate buses." })
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(1)
  for (const call of ["revision-publish", "revision-rollback", "stop", "teardown"]) expect(fixture.calls).not.toContain(call)
  await controller.dispose()
})

test("reconciles Keep Latency changed while startup awaits the bridge", async () => {
  const fixture = createBridge()
  let desired = new Set<string>()
  const publish = fixture.bridge.session.publishGraph
  fixture.bridge.session.publishGraph = async (...args) => {
    const reply = await publish(...args)
    desired = new Set(["track"])
    return reply
  }
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => desired,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  expect(fixture.calls).toContain("revision-prepare")
  await controller.dispose()
})

test("publishes reactive Keep Latency membership without restarting the session", async () => {
  const fixture = createBridge()
  let keepLatency = new Set(["track"])
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => keepLatency,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const initial = fixture.graphPayloads.at(-1)
  if (!initial) throw new Error("Missing initial graph")
  expect(new DataView(initial.buffer).getUint32(12, true)).toBe(5)
  const before = fixture.calls.length
  keepLatency = new Set()
  await expect(controller.updateKeepLatency()).resolves.toEqual({ handled: true })
  expect(fixture.calls.slice(before)).toEqual(["revision-prepare", "revision-publish", "revision-retire"])
  await expect(controller.updateKeepLatency()).resolves.toEqual({ handled: true })
  expect(fixture.calls.slice(before)).toHaveLength(3)
  await controller.dispose()
})

test("publishes attachment latency only for the current instance generation", async () => {
  const fixture = createBridge()
  const compiled = compileLivePlaybackSnapshot({ ...input(), tracks: [sourceTrack(), { ...sourceTrack(), id: "parallel", clips: [] }] })
  if (!compiled.supported) throw new Error(compiled.reasons.join(" "))
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async () => ({ supported: true,
      snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } }),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const instanceId = nativeAttachmentPlan.attachments[0]?.instanceId
  if (!instanceId) throw new Error("Missing attachment")
  const generation = controller.attachmentGeneration(instanceId)
  if (generation === undefined) throw new Error("Missing generation")
  const before = fixture.calls.length
  await expect(controller.publishAttachmentLatency({ instanceId, generation: generation + 1, latencyFrames: 2048 }))
    .resolves.toEqual({ handled: false, reason: "stale" })
  expect(fixture.calls).toHaveLength(before)
  await expect(controller.publishAttachmentLatency({ instanceId, generation, latencyFrames: 2048 }))
    .resolves.toEqual({ handled: true })
  expect(fixture.calls.slice(before)).toEqual(["revision-prepare", "revision-publish", "revision-retire"])
  const payload = fixture.graphPayloads.at(-1)
  if (!payload) throw new Error("Missing attachment latency graph")
  const view = new DataView(payload.buffer, payload.byteOffset)
  const edges = 36 + view.getUint32(20, true) * 136
  expect(view.getUint32(edges + 48 + 44, true)).toBe(2048 + 512)
  await controller.dispose()
  await expect(controller.publishAttachmentLatency({ instanceId, generation, latencyFrames: 0 }))
    .resolves.toEqual({ handled: false, reason: "stale" })
})

const reverbCommit = (
  fromState: ReturnType<typeof createDefaultReverbParams>,
  toState: ReturnType<typeof createDefaultReverbParams>,
) => ({
  targetId: "track",
  effect: "reverb" as const,
  instanceId: "reverb:1",
  from: fromState,
  to: toState,
} satisfies EffectParamsCommitPayload<"reverb">)

test("refreshes native built-in tail metadata when reverb state changes", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(reverbPlaybackInput()),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const from = createDefaultReverbParams()
  const to = { ...from, decaySec: 2 }
  await expect(controller.deliverProcessor(fixturePatchEdit({
    payload: reverbCommit(from, to),
    bpm: 120,
  })).settled).resolves.toEqual({ state: "applied" })
  const patch = fixture.statePatchPayloads.at(-1)
  expect(patch).toBeDefined()
  if (!patch) return
  expect(new DataView(patch.buffer).getUint32(52, true)).toBe(96_960)
  await controller.dispose()
})

test("sends the tail of the newest content a queued patch is built from", async () => {
  const fixture = createBridge()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<NativeProcessorPatchReply>()
  const queue = fixture.bridge.session.queueProcessorStatePatch
  let held = true
  fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
    if (held) { held = false; entered.resolve(); return gate.promise }
    return queue(bytes)
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(reverbPlaybackInput()),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const registry = createProcessorEditRegistry(() => 120)
  const from = createDefaultReverbParams()
  const edited = (decaySec: number) => {
    const commit = reverbCommit(from, { ...from, decaySec })
    const edit = registry.allocate(commit)
    if (!edit) throw new Error("Missing reverb edit")
    return { ...commit, edit }
  }
  const first = controller.deliverProcessor(fixturePatchEdit({ payload: edited(1), bpm: 120 })).settled
  await entered.promise
  // The patch waits behind the first; an 8 s edit registers meanwhile, so the state sent is its, and so is the tail.
  const queued = controller.deliverProcessor(fixturePatchEdit({ payload: edited(2), bpm: 120 })).settled
  const newest = edited(8)
  const newestReceipt = controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "reverb:1", edit: newest.edit,
    values: Object.entries(newest.edit.content.values ?? {}).map(([parameterId, value]) => ({ parameterId, value })),
  }), fixtureGesture({
    instanceId: "reverb:1", edit: newest.edit,
    values: Object.entries(newest.edit.content.values ?? {}).map(([parameterId, value]) => ({ parameterId, value })),
  }, true)).settled;
  gate.resolve(appliedPatch)
  await expect(newestReceipt).resolves.toEqual({ state: "applied" });
  await expect(Promise.all([first, queued])).resolves.toEqual([{ state: "applied" }, { state: "superseded", by: newest.edit.order }])
  const patch = fixture.statePatchPayloads.at(-1)
  if (!patch) throw new Error("Missing materialized patch")
  expect(new DataView(patch.buffer).getUint32(52, true)).toBe(384_960)
  expect(Array.from(patch.slice(56, 56 + (newest.edit.content.state?.byteLength ?? 0)))).toEqual(Array.from(newest.edit.content.state ?? []))
  await controller.dispose()
})

const delayPlaybackInput = (bpm: number): LivePlaybackSnapshotInput => ({
  ...input(),
  bpm,
  renderState: {
    fx: {
      masterVolume: 1,
      masterFxInstances: [],
      trackFx: { track: { instances: [{ id: "delay:1", kind: "delay", params: createDefaultDelayParams() }] } },
    },
    automationEnvelopes: [],
  },
})
const delayFeedbackCommit = (): EffectParamsCommitPayload<"delay"> => {
  const from = createDefaultDelayParams()
  return { targetId: "track", effect: "delay", instanceId: "delay:1", from, to: { ...from, feedback: 0.5 } }
}
const delayTailAt = (bpm: number) => {
  const { tail } = getEffectTiming({ kind: "delay", params: normalizeDelayParams(delayFeedbackCommit().to) }, 48_000, bpm)
  if (tail.kind !== "finite") throw new Error("Delay tail is finite at feedback 0.5")
  return tail.frames
}
// The tail of every processor descriptor in a serialized graph (descriptor layout: native-host-wire.ts serializeNativeGraph).
const graphProcessorTails = (graph: Uint8Array) => {
  const view = new DataView(graph.buffer, graph.byteOffset, graph.byteLength)
  const version = view.getUint32(12, true)
  let offset = 36 + view.getUint32(20, true) * (version === 5 ? 140 : version === 4 ? 136 : 132) + view.getUint32(24, true) * 48
  return Array.from({ length: view.getUint32(28, true) }, () => {
    const tail = view.getUint32(offset + 44, true)
    offset += 48 + view.getUint32(offset + 16, true) + view.getUint32(offset + 36, true) * 4
    return tail
  })
}

test("a latency publication after a patch queued at another tempo keeps the prepared-tempo tail", async () => {
  expect(delayTailAt(60)).not.toBe(delayTailAt(120))
  const fixture = createBridge()
  let keep = new Set<string>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project", getKeepLatencyNodeIds: () => keep,
    compileSnapshot: async () => compileLivePlaybackSnapshot(delayPlaybackInput(120)),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await expect(controller.deliverProcessor(fixturePatchEdit({ payload: delayFeedbackCommit(), bpm: 60, processorStateSequence: 1 })).settled).resolves.toEqual({ state: "applied" })
  const patch = fixture.statePatchPayloads.at(-1)
  if (!patch) throw new Error("Missing patch")
  expect(new DataView(patch.buffer).getUint32(52, true)).toBe(delayTailAt(120))
  // The ledger still holds the edit; a later publication folds it into the graph it writes.
  keep = new Set(["track"])
  await expect(controller.updateKeepLatency()).resolves.toEqual({ handled: true })
  const graph = fixture.graphPayloads.at(-1)
  if (!graph) throw new Error("Missing publication")
  expect(graphProcessorTails(graph)).toContain(delayTailAt(120))
  expect(graphProcessorTails(graph)).not.toContain(delayTailAt(60))
  await controller.dispose()
})

test("a candidate that changes the tempo folds a queued patch at the candidate's tempo", async () => {
  const fixture = createBridge("runtime-revision-progress")
  let snapshotInput = delayPlaybackInput(120)
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  await expect(controller.deliverProcessor(fixturePatchEdit({ payload: delayFeedbackCommit(), bpm: 60, processorStateSequence: 1 })).settled).resolves.toEqual({ state: "applied" })
  snapshotInput = delayPlaybackInput(90)
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-14")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

  let seam = 0n
  let revision = 0
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    seam = request.requestedPublicationFrame ?? 0n
    const reply = await prepare(request)
    if (reply.ok) revision = reply.revision.requestedRevision
    return reply
  }
  fixture.bridge.session.revisions.publish = async () => {
    const reply = fixture.revisionReply("published")
    if (!reply.ok) throw new Error("Missing proof")
    return { ...reply, revision: { ...reply.revision, activeRevision: revision, preparedRevision: 0,
      publicationFrame: seam, transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
  }
  fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
  expect(await (candidateCompile.release(), candidateAdoption)).toEqual({ status: "adopted" })
  const graph = fixture.graphPayloads.at(-1)
  if (!graph) throw new Error("Missing publication")
  expect(graphProcessorTails(graph)).toContain(delayTailAt(90))
  await controller.dispose()
})

test("rejects enabled changes instead of claiming a same-core patch succeeded", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const from = createDefaultUtilityParams()
  await expect(controller.deliverProcessor(fixturePatchEdit({
    payload: utilityCommit("utility:1", from, { ...from, enabled: false }),
    bpm: 120,
  })).settled).resolves.toEqual({ state: "refused", reason: "unsupported" })
  expect(fixture.statePatchPayloads).toHaveLength(0)
  await controller.dispose()
})

test("coalesces each processor independently without dropping distinct updates", async () => {
  const fixture = createBridge()
  const first = createDefaultUtilityParams()
  const second = { ...first, gainDb: -3 }
  const snapshotInput = {
    ...utilityPlaybackInput(),
    renderState: {
      ...utilityPlaybackInput().renderState,
      fx: {
        ...utilityPlaybackInput().renderState.fx,
        trackFx: {
          track: {
            instances: [
              { id: "utility:1", kind: "utility" as const, params: { version: 1 as const, state: first } },
              { id: "utility:2", kind: "utility" as const, params: { version: 1 as const, state: first } },
            ],
          },
        },
      },
    },
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await Promise.all([
    controller.deliverProcessor(fixturePatchEdit({ payload: utilityCommit("utility:1", first, second), bpm: 120 })).settled,
    controller.deliverProcessor(fixturePatchEdit({ payload: utilityCommit("utility:2", first, { ...first, pan: 0.25 }), bpm: 120 })).settled,
  ])
  expect(fixture.calls.filter((call) => call === "processor-state-patch")).toHaveLength(2)
  expect(fixture.statePatchPayloads.map((bytes) => new DataView(bytes.buffer).getUint32(16, true))).toHaveLength(2)
  await controller.dispose()
})

test("serializes native state patches globally while retaining one latest pending patch per processor", async () => {
  const fixture = createBridge()
  const pending: Array<{
    bytes: Uint8Array
    resolve: (reply: NativeProcessorPatchReply) => void
  }> = []
  fixture.bridge.session.queueProcessorStatePatch = (bytes) => new Promise((resolve) => {
    pending.push({ bytes, resolve })
  })
  const first = createDefaultUtilityParams()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...utilityPlaybackInput(),
      renderState: {
        ...utilityPlaybackInput().renderState,
        fx: {
          ...utilityPlaybackInput().renderState.fx,
          trackFx: {
            track: {
              instances: [
                { id: "utility:1", kind: "utility", params: { version: 1, state: first } },
                { id: "utility:2", kind: "utility", params: { version: 1, state: first } },
              ],
            },
          },
        },
      },
    }),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const firstPatch = controller.deliverProcessor(fixturePatchEdit({
    payload: utilityCommit("utility:1", first, { ...first, gainDb: -1 }),
    bpm: 120,
  })).settled
  const replacement = controller.deliverProcessor(fixturePatchEdit({
    payload: utilityCommit("utility:1", first, { ...first, gainDb: -2 }),
    bpm: 120,
  })).settled
  const distinct = controller.deliverProcessor(fixturePatchEdit({
    payload: utilityCommit("utility:2", first, { ...first, pan: 0.25 }),
    bpm: 120,
  })).settled
  await Promise.resolve()
  expect(pending).toHaveLength(1)
  pending[0]?.resolve(appliedPatch)
  await Bun.sleep(0)
  expect(pending).toHaveLength(2)
  pending[1]?.resolve(appliedPatch)
  // The two utility:1 patches were pending before the lane ran: only the latest is sent.
  await Bun.sleep(0)
  expect(pending).toHaveLength(2)
  const sent = pending.map(({ bytes }) => ({
    instanceId: new DataView(bytes.buffer).getUint32(16, true),
    state: bytes.slice(56, 56 + new DataView(bytes.buffer).getUint32(28, true)),
  }))
  expect(sent[0]?.instanceId).not.toBe(sent[1]?.instanceId)
  expect(Array.from(sent[0]?.state ?? [])).toEqual(Array.from(encodeUtilityProcessorState({ ...first, gainDb: -2 })))
  expect(Array.from(sent[1]?.state ?? [])).toEqual(Array.from(encodeUtilityProcessorState({ ...first, pan: 0.25 })))
  await expect(Promise.all([firstPatch, replacement, distinct])).resolves.toEqual([
    { state: "superseded", by: 0 },
    { state: "applied" },
    { state: "applied" },
  ])
  await controller.dispose()
})

test("canonical order, not delayed submission order, coalesces pending processor state", async () => {
  const fixture = createBridge()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<NativeProcessorPatchReply>()
  const queue = fixture.bridge.session.queueProcessorStatePatch
  let held = true
  fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
    if (held) { held = false; entered.resolve(); return gate.promise }
    return queue(bytes)
  }
  const snapshotInput = utilityPlaybackInput()
  const controller = createObservedController({ bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput) })
  expect(await controller.ensureLivePreview(0)).toBe("started")
  const from = createDefaultUtilityParams()
  const patch = (sequence: number, gainDb: number) => controller.deliverProcessor(fixturePatchEdit({
    processorStateSequence: sequence, bpm: 120,
    payload: utilityCommit("utility:1", from, { ...from, gainDb }),
  })).settled
  const first = patch(1, -1)
  await entered.promise
  const newest = patch(4, -12)
  const delayed = patch(3, -6)
  gate.resolve(appliedPatch)
  expect(await Promise.all([first, newest, delayed])).toEqual([
    { state: "applied" }, { state: "applied" }, { state: "superseded", by: 4 },
  ])
  const expectedFixture = createBridge()
  const expectedController = createObservedController({ bridge: expectedFixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput) })
  expect(await expectedController.ensureLivePreview(0)).toBe("started")
  await expectedController.deliverProcessor(fixturePatchEdit({ bpm: 120,
    payload: utilityCommit("utility:1", from, { ...from, gainDb: -12 }) })).settled
  expect(fixture.statePatchPayloads.at(-1)).toEqual(expectedFixture.statePatchPayloads.at(-1))
  await expectedController.dispose()
  await controller.dispose()
})

test("the latest unique-order processor patch wins in an older schedule candidate", async () => {
  const fixture = createBridge("runtime-revision-progress")
  // Use a non-latency edit: latency edits wait for candidate publication, so
  // awaiting one before publishing would deadlock this test's own next step.
  const from = createDefaultUtilityParams()
  let snapshotInput: LivePlaybackSnapshotInput = {
    ...input(),
    processorStateSequence: 10,
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: {
          track: {
            instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: from } }],
          },
        },
      },
      automationEnvelopes: [],
    },
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  snapshotInput = {
    ...snapshotInput,
    tracks: snapshotInput.tracks.map((track) => ({ ...track, clips: [] })),
  }
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-15")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const candidateSnapshot = candidateCompilation.snapshot

  const patch = (gainDb: number, order: number) => controller.deliverProcessor(fixturePatchEdit({
    processorStateSequence: order,
    bpm: 120,
    payload: {
      effect: "utility",
      instanceId: "utility:1",
      targetId: "track",
      from: { version: 1, state: from },
      to: { version: 1, state: { ...from, gainDb } },
    },
  })).settled
  expect(await patch(-3, 11)).toEqual({ state: "applied" })
  expect(await patch(-6, 12)).toEqual({ state: "applied" })
  expect(fixture.statePatchPayloads).toHaveLength(2)
  acknowledgeStagedPublication(fixture)
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = (request) => {
    fixture.graphPayloads.push(request.bytes)
    return prepare(request)
  }
  await expect((candidateCompile.release(), candidateAdoption)).resolves.toEqual({ status: "adopted" })

  const expectedSnapshot = await compileLivePlaybackSnapshot({
    ...snapshotInput,
    transport: snapshotInput.transport,
    renderState: {
      ...snapshotInput.renderState,
      fx: {
        ...snapshotInput.renderState.fx,
        trackFx: {
          track: { instances: [{ id: "utility:1", kind: "utility",
            params: { version: 1, state: { ...from, gainDb: -6 } } }] },
        },
      },
    },
  })
  if (!expectedSnapshot.supported) throw new Error("Expected the latest utility snapshot.")
  const expected = compileLiveNativeProjection({
    tracks: expectedSnapshot.snapshot.tracks,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: capturedGraph(candidateSnapshot).revision,
    epoch: 1,
    firstSequence: 1,
    fx: expectedSnapshot.snapshot.mixer.fx,
    instrumentRegionMode: "metadata",
  })
  if (!expected.supported) throw new Error("Expected the latest utility graph.")
  expect(fixture.graphPayloads.at(-1)).toEqual(serializeNativeGraph(expected.graph, new Set()))
  await controller.dispose()
})

for (const capturedSequence of [10, 11]) test(`keeps changed equal-stamp latency bytes pending after schedule publication captures floor ${capturedSequence}`, async () => {
  const fixture = createBridge("runtime-revision-progress")
  const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
  let snapshotInput: LivePlaybackSnapshotInput = {
    ...input(), processorStateSequence: 10,
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {
      track: { instances: [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: from } }] },
    } }, automationEnvelopes: [] },
  }
  const controller = createObservedController({ bridge: fixture.bridge,
    getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...snapshotInput, transport }),
  })
  expect(await controller.start(snapshotInput.transport)).toBe("started")
  snapshotInput = { ...snapshotInput, processorStateSequence: capturedSequence,
    tracks: snapshotInput.tracks.map((track) => ({ ...track, clips: [] })) }
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-16")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

  const patch = (fftSize: 2048 | 4096) => controller.deliverProcessor(fixturePatchEdit({
    processorStateSequence: capturedSequence + (fftSize === 2048 ? 1 : 2), bpm: 120,
    payload: { effect: "spectral", instanceId: "spectral:1", targetId: "track",
      from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize } } },
  })).settled
  const first = patch(2048)
  const latencyPrepare = fixture.bridge.session.revisions.prepare
  const latencyPublish = fixture.bridge.session.revisions.publish
  const latencyInspect = fixture.bridge.session.revisions.inspect
  acknowledgeStagedPublication(fixture)
  const schedulePrepare = fixture.bridge.session.revisions.prepare
  const captured = Promise.withResolvers<void>()
  const releaseCapture = Promise.withResolvers<void>()
  const releaseNext = Promise.withResolvers<void>()
  const publishedGraphs: Uint8Array[] = []
  let preparations = 0
  fixture.bridge.session.revisions.prepare = async (request) => {
    preparations++
    publishedGraphs.push(request.bytes)
    if (preparations === 1) {
      captured.resolve()
      await releaseCapture.promise
      return schedulePrepare(request)
    }
    await releaseNext.promise
    return latencyPrepare(request)
  }
  const publication = (candidateCompile.release(), candidateAdoption)
  await captured.promise
  let latestSettled = false
  const latest = patch(4096).then((result) => { latestSettled = true; return result })
  releaseCapture.resolve()
  try {
    expect(await publication).toEqual({ status: "adopted" })
    // Bound the serialized lane's promise drain; never await an unstarted publication.
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
    expect(latestSettled).toBeFalse()
    expect(preparations).toBe(2)
    fixture.bridge.session.revisions.publish = latencyPublish
    fixture.bridge.session.revisions.inspect = latencyInspect
    releaseNext.resolve()
    expect(await latest).toEqual({ state: "applied" })
    expect(await first).toEqual({ state: "applied" })
    const latencies = publishedGraphs.map((bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset)
      const nodeBytes = view.getUint32(12, true) === 5 ? 140 : view.getUint32(12, true) === 4 ? 136 : 132
      const processors = 36 + view.getUint32(20, true) * nodeBytes + view.getUint32(24, true) * 48
      return view.getUint32(processors + 40, true)
    })
    expect(latencies).toEqual([2048, 4096])
  } finally {
    releaseCapture.resolve()
    releaseNext.resolve()
    await controller.dispose()
  }
})

test("continues the serialized native state patch queue after a timed-out request", async () => {
  const fixture = createBridge()
  let calls = 0
  const entered = Promise.withResolvers<void>()
  const timeout = Promise.withResolvers<NativeProcessorPatchReply>()
  fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
    calls += 1
    if (calls === 1) { entered.resolve(); return timeout.promise }
    fixture.statePatchPayloads.push(bytes)
    return appliedPatch
  }
  const snapshotInput = utilityPlaybackInput()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const from = createDefaultUtilityParams()
  const first = controller.deliverProcessor(fixturePatchEdit({
    payload: utilityCommit("utility:1", from, { ...from, gainDb: -1 }),
    bpm: 120,
  })).settled
  await entered.promise
  // Queued while the first request is in the bridge: the lane sends it once that request has failed.
  const second = controller.deliverProcessor(fixturePatchEdit({
    payload: utilityCommit("utility:1", from, { ...from, gainDb: -2 }),
    bpm: 120,
  })).settled
  timeout.reject(new Error("Native audio host control request timed out."))
  // The lost reply leaves the first patch unconfirmed; the one resend the fence allows carries the newer content,
  // which applies and supersedes it.
  await expect(first).resolves.toEqual({ state: "superseded", by: 0 })
  await expect(second).resolves.toEqual({ state: "applied" })
  expect(calls).toBe(2)
  await controller.dispose()
})

test("queues supported built-in parameters for active native playback without lifecycle changes", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  const before = fixture.calls.slice()
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -6 }],
  })).settled).resolves.toEqual({ state: "applied" })
  expect(fixture.calls.slice(0, before.length)).toEqual(before)
  expect(fixture.calls.slice(before.length)).toEqual(["built-in-parameter"])
  const payload = fixture.builtInParameterPayloads[0]
  if (!payload) throw new Error("Expected built-in parameter payload.")
  const view = new DataView(payload.buffer)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getBigUint64(12, true)).toBeGreaterThan(0n)
  expect(view.getUint32(28, true)).toBe(1)
  expect(view.getUint32(32, true)).toBe(0)
  expect(view.getFloat32(36, true)).toBe(-6)
  expect(fixture.calls).not.toContain("stop")
  expect(fixture.calls).not.toContain("teardown")
  await controller.dispose()
})

test("queues built-in parameters for paused prepared preview and reports target or bridge failures", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.pan", value: 0.25 }],
  })).settled).resolves.toEqual({ state: "applied" })
  const dispatched = fixture.builtInParameterPayloads.length
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.unknown", value: 0.25 }],
  })).settled).resolves.toEqual({ state: "refused", reason: "unsupported" })
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "missing",
    values: [{ parameterId: "utility.pan", value: 0.25 }],
  })).settled).resolves.toEqual({ state: "refused", reason: "unsupported" })
  expect(fixture.builtInParameterPayloads).toHaveLength(dispatched)
  await controller.dispose()

  const failedFixture = createBridge("built-in-parameter", false, false, "queue rejected")
  const failedController = createObservedController({
    bridge: failedFixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(failedController.ensureLivePreview(0)).resolves.toBe("started")
  failedFixture.bridge.session.queueProcessorStatePatch = async () => ({ ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 })
  await expect(failedController.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.pan", value: 0.25 }],
  })).settled).resolves.toMatchObject({ state: "refused" })
  await failedController.dispose()
})

test("the internal parameter queue does not turn an invalid batch into proof", async () => {
  const fixture = createBridge()
  const snapshotInput = utilityPlaybackInput()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })
  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  await expect(controller.deliverProcessor(fixtureParameterEdit({
    instanceId: "utility:1",
    values: [{ parameterId: "utility.gainDb", value: -3 }],
  })).settled).resolves.toEqual({ state: "applied" })
  const dispatched = fixture.builtInParameterPayloads.length
  // Invalid wire identities belong at serialization, not a public receipt bypass.
  expect(() => serializeNativeProcessorEvents([
    { processorInstanceId: 1, parameterTarget: 1, frameOffset: 0, value: -2 },
  ], { revision: 0, epoch: 1, sequence: 2 })).toThrow()
  expect(fixture.builtInParameterPayloads).toHaveLength(dispatched)
  await controller.dispose()
})

test("maps native graph meters and ignores stale revision or sequence batches", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const trackBatches: Array<ReadonlyMap<string, { left: number; right: number }>> = []
  const masterBatches: Array<{ left: number; right: number }> = []
  const unsubscribeTrack = controller.subscribeTrackMeters((levels) => trackBatches.push(levels))
  const unsubscribeMaster = controller.subscribeMasterMeter((levels) => masterBatches.push(levels))
  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.emitMeterBatch({
    graphRevision: 1,
    transportEpoch: 1,
    sequence: 1n,
    entries: [
      { nodeId: nativeGraphNodeId("track"), leftRms: 0.25, rightRms: 0.5 },
      { nodeId: nativeGraphNodeId("master"), leftRms: 0.75, rightRms: 1 },
    ],
  })
  fixture.emitMeterBatch({
    graphRevision: 1,
    transportEpoch: 1,
    sequence: 1n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 1, rightRms: 1 }],
  })
  fixture.emitMeterBatch({
    graphRevision: 2,
    transportEpoch: 1,
    sequence: 2n,
    entries: [{ nodeId: nativeGraphNodeId("track"), leftRms: 1, rightRms: 1 }],
  })
  expect(trackBatches.at(-1)).toEqual(new Map([["track", { left: 0.25, right: 0.5 }]]))
  expect(masterBatches.at(-1)).toEqual({ left: 0.75, right: 1 })
  await controller.dispose()
  expect(trackBatches.at(-1)).toEqual(new Map([["track", { left: 0, right: 0 }]]))
  expect(masterBatches.at(-1)).toEqual({ left: 0, right: 0 })
  unsubscribeTrack()
  unsubscribeMaster()
})

test("staged observation maps promote only on Published proof without resetting retained meters or spectrum", async () => {
  const fixture = createBridge()
  const second = { ...sourceTrack(), id: "second", clips: sourceTrack().clips.map((clip) => ({
    ...clip, id: "second-clip", sourceAssetKey: "second-source",
  })) }
  const added = { ...sourceTrack(), id: "added", clips: sourceTrack().clips.map((clip) => ({
    ...clip, id: "added-clip", sourceAssetKey: "added-source",
  })) }
  let tracks: RuntimeTrack[] = [sourceTrack(), second]
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), tracks, transport }),
  })
  const meterUpdates: Array<ReadonlyMap<string, { left: number; right: number }>> = []
  const spectrumFrames: Array<SpectrumFrame | null> = []
  const unsubscribeMeters = controller.subscribeTrackMeters((levels) => meterUpdates.push(levels))
  const unsubscribeSpectrum = controller.subscribeSpectrum("second", (frame) => spectrumFrames.push(frame))
  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.emitMeterBatch({ graphRevision: 1, transportEpoch: 1, sequence: 5n, entries: [
    { nodeId: nativeGraphNodeId("track"), leftRms: 0.25, rightRms: 0.5 },
    { nodeId: nativeGraphNodeId("second"), leftRms: 0.3, rightRms: 0.4 },
  ] })
  const selectionCount = fixture.spectrumSelections.length
  const epoch = new DataView(fixture.schedulePayloads.at(-1)!.buffer).getUint32(4, true)
  tracks = [second, added]
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-17")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

  let requestedFrame = 0n
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    requestedFrame = request.requestedPublicationFrame ?? 0n
    return prepare(request)
  }
  let isPublished = false
  fixture.bridge.session.revisions.inspect = async () => {
    const proof = fixture.revisionReply(isPublished ? "published" : "prepared")
    return proof.ok ? { ...proof, revision: {
      ...proof.revision, publicationFrame: requestedFrame, transportEpoch: epoch,
    } } : proof
  }
  let publish: ((reply: NativeRevisionReply) => void) | undefined
  fixture.bridge.session.revisions.publish = () => new Promise((resolve) => {
    publish = resolve
  })
  const update = (candidateCompile.release(), candidateAdoption)
  for (let turn = 0; turn < 200; turn++) await Promise.resolve()
  fixture.emitMeterBatch({ graphRevision: 1, transportEpoch: 1, sequence: 6n, entries: [
    { nodeId: nativeGraphNodeId("track"), leftRms: 0.2, rightRms: 0.2 },
    { nodeId: nativeGraphNodeId("second"), leftRms: 0.35, rightRms: 0.45 },
  ] })
  expect(meterUpdates.at(-1)).toEqual(new Map([
    ["track", { left: 0.2, right: 0.2 }],
    ["second", { left: 0.35, right: 0.45 }],
  ]))
  const revision = fixture.revisionReply("published")
  const prepared: NativeRevisionReply = revision.ok ? { ...revision, revision: {
    ...revision.revision, publicationFrame: requestedFrame, transportEpoch: epoch,
  } } : revision
  isPublished = true
  publish?.(prepared)
  await expect(update).resolves.toMatchObject({ status: "adopted" })

  expect(meterUpdates.at(-1)).toEqual(new Map([
    ["track", { left: 0, right: 0 }],
    ["added", { left: 0, right: 0 }],
  ]))
  const selectionsAfterPromotion = fixture.spectrumSelections.length
  expect(selectionsAfterPromotion).toBe(selectionCount)
  fixture.emitSpectrumFrame({ graphRevision: 2, transportEpoch: 1, sequence: 8n,
    nodeId: nativeGraphNodeId("second"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(spectrumFrames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("second"), sequence: 8n })
  fixture.emitMeterBatch({ graphRevision: 2, transportEpoch: 1, sequence: 7n, entries: [
    { nodeId: nativeGraphNodeId("second"), leftRms: 0.4, rightRms: 0.5 },
    { nodeId: nativeGraphNodeId("added"), leftRms: 0.6, rightRms: 0.7 },
  ] })
  expect(meterUpdates.at(-1)).toEqual(new Map([
    ["second", { left: 0.4, right: 0.5 }],
    ["added", { left: 0.6, right: 0.7 }],
  ]))
  fixture.emitMeterBatch({ graphRevision: 1, transportEpoch: 1, sequence: 7n, entries: [
    { nodeId: nativeGraphNodeId("added"), leftRms: 1, rightRms: 1 },
  ] })
  fixture.emitMeterBatch({ graphRevision: 2, transportEpoch: 99, sequence: 8n, entries: [
    { nodeId: nativeGraphNodeId("added"), leftRms: 1, rightRms: 1 },
  ] })
  expect(meterUpdates.at(-1)).toEqual(new Map([
    ["second", { left: 0.4, right: 0.5 }],
    ["added", { left: 0.6, right: 0.7 }],
  ]))
  await controller.dispose()
  unsubscribeMeters()
  unsubscribeSpectrum()
})

test("removing a staged spectrum target emits one null at promotion and candidate-only targets select then", async () => {
  const fixture = createBridge()
  let tracks: RuntimeTrack[] = [sourceTrack()]
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), tracks, transport }),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("added", (frame) => frames.push(frame))
  await expect(controller.start(input().transport)).resolves.toBe("started")
  const previousSelectionCount = fixture.spectrumSelections.length
  const nullFramesBefore = frames.filter((frame) => frame === null).length
  tracks = [{ ...sourceTrack(), id: "added", clips: sourceTrack().clips.map((clip) => ({
    ...clip, id: "added-clip", sourceAssetKey: "added-source",
  })) }]
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-18")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
  let requestedFrame = 0n
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    requestedFrame = request.requestedPublicationFrame ?? 0n
    return prepare(request)
  }
  let published = false
  fixture.bridge.session.revisions.inspect = async () => {
    const proof = fixture.revisionReply(published ? "published" : "prepared")
    return proof.ok ? { ...proof, revision: {
      ...proof.revision, publicationFrame: requestedFrame, transportEpoch: 1,
    } } : proof
  }
  let resolvePublish: ((reply: NativeRevisionReply) => void) | undefined
  fixture.bridge.session.revisions.publish = () => new Promise((resolve) => { resolvePublish = resolve })
  const update = (candidateCompile.release(), candidateAdoption)
  for (let turn = 0; turn < 200; turn++) await Promise.resolve()
  expect(fixture.spectrumSelections.length).toBe(previousSelectionCount)
  published = true
  const proof = fixture.revisionReply("published")
  resolvePublish?.(proof.ok ? { ...proof, revision: {
    ...proof.revision, publicationFrame: requestedFrame, transportEpoch: 1,
  } } : proof)
  await expect(update).resolves.toMatchObject({ status: "adopted" })
  expect(fixture.spectrumSelections.slice(previousSelectionCount)).toEqual([
    { nodeId: nativeGraphNodeId("added"), sessionStarted: true },
  ])
  expect(frames.filter((frame) => frame === null)).toHaveLength(nullFramesBefore)
  fixture.emitSpectrumFrame({ graphRevision: 2, transportEpoch: 1, sequence: 1n,
    nodeId: nativeGraphNodeId("added"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(frames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("added") })
  const nullFramesBeforeRemoval = frames.filter((frame) => frame === null).length
  tracks = [sourceTrack()]
  const removalCompile = holdCompile(controller)
    const removalIntent = migrationIntent("migration-19")
    const removalAdoption = controller.adoptSchedule(removalIntent, true)
    const removalCompilation = await removalCompile.entered
    if (!removalCompilation.supported) throw new Error(removalCompilation.reasons.join("; "))
  const secondPrepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    requestedFrame = request.requestedPublicationFrame ?? 0n
    return secondPrepare(request)
  }
  await expect((removalCompile.release(), removalAdoption)).resolves.toMatchObject({ status: "adopted" })
  expect(frames.filter((frame) => frame === null)).toHaveLength(nullFramesBeforeRemoval + 1)
  expect(fixture.spectrumSelections.at(-1)).toEqual({ nodeId: null, sessionStarted: true })
  unsubscribe()
  await controller.dispose()
})

test("retries a rejected spectrum selection after publication promotion", async () => {
  const fixture = createBridge()
  const second = { ...sourceTrack(), id: "second", clips: sourceTrack().clips.map((clip) => ({
    ...clip, id: "second-clip", sourceAssetKey: "second-source",
  })) }
  let tracks: RuntimeTrack[] = [sourceTrack(), second]
  let rejectSelection = false
  fixture.setSpectrumReply(async () => rejectSelection
    ? { ok: false, error: "schedule owner is held" }
    : { ok: true })
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), tracks, transport }),
  })
  await expect(controller.start(input().transport)).resolves.toBe("started")
  rejectSelection = true
  const spectrum: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("second", (frame) => spectrum.push(frame))
  await Promise.resolve()
  expect(fixture.spectrumSelections.at(-1)?.nodeId).toBe(nativeGraphNodeId("second"))
  tracks = [second, { ...sourceTrack(), id: "added", clips: sourceTrack().clips.map((clip) => ({
    ...clip, id: "added-clip", sourceAssetKey: "added-source",
  })) }]
  const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-20")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
  let requestedFrame = 0n
  const prepare = fixture.bridge.session.revisions.prepare
  fixture.bridge.session.revisions.prepare = async (request) => {
    requestedFrame = request.requestedPublicationFrame ?? 0n
    return prepare(request)
  }
  let published = false
  fixture.bridge.session.revisions.inspect = async () => {
    const proof = fixture.revisionReply(published ? "published" : "prepared")
    return proof.ok ? { ...proof, revision: { ...proof.revision, publicationFrame: requestedFrame, transportEpoch: 1 } } : proof
  }
  fixture.bridge.session.revisions.publish = async () => {
    published = true
    const proof = fixture.revisionReply("published")
    return proof.ok ? { ...proof, revision: { ...proof.revision, publicationFrame: requestedFrame, transportEpoch: 1 } } : proof
  }
  rejectSelection = false
  await expect((candidateCompile.release(), candidateAdoption)).resolves.toMatchObject({ status: "adopted" })
  const secondSelections = fixture.spectrumSelections.filter(({ nodeId }) => nodeId === nativeGraphNodeId("second"))
  expect(secondSelections).toHaveLength(2)
  fixture.emitSpectrumFrame({ graphRevision: 2, transportEpoch: 1, sequence: 1n,
    nodeId: nativeGraphNodeId("second"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(spectrum.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("second") })
  unsubscribe()
  await controller.dispose()
})

test("reconciles a rejected spectrum selection after a Seek", async () => {
  const fixture = createBridge()
  let attempts = 0
  fixture.setSpectrumReply(async () => {
    attempts += 1
    return attempts === 1 ? { ok: false, error: "schedule owner is held" } : { ok: true }
  })
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("track", (frame) => frames.push(frame))
  await expect(controller.start(input().transport)).resolves.toBe("started")
  await expect(controller.seekPrepared(0.25)).resolves.toBe("started")
  expect(attempts).toBe(2)
  fixture.emitSpectrumFrame({ graphRevision: 1, transportEpoch: 2, sequence: 1n,
    nodeId: nativeGraphNodeId("track"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(frames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("track"), transportEpoch: 2 })
  unsubscribe()
  await controller.dispose()
})

for (const ok of [true, false]) test(`spectrum A B A restores acknowledged A after delayed B (${ok})`, async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  await controller.start(input().transport)
  const first = controller.subscribeSpectrum("track", () => {})
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  const delayed = Promise.withResolvers<BridgeReply>()
  fixture.setSpectrumReply((nodeId) => nodeId === nativeGraphNodeId("master")
    ? delayed.promise : Promise.resolve({ ok: true }))
  const second = controller.subscribeSpectrum("master", () => {})
  await Promise.resolve()
  const frames: Array<SpectrumFrame | null> = []
  const third = controller.subscribeSpectrum("track", (frame) => frames.push(frame))
  await Promise.resolve()
  delayed.resolve(ok ? { ok: true } : { ok: false, error: "ownership" })
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  expect(fixture.spectrumNodeIds.at(-1)).toBe(nativeGraphNodeId("track"))
  fixture.emitSpectrumFrame({ graphRevision: 1, transportEpoch: 1, sequence: 1n,
    nodeId: nativeGraphNodeId("track"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(frames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("track") })
  first()
  second()
  third()
  await controller.dispose()
})

test("ignores a spectrum selection reply after a newer target was selected", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  await expect(controller.start(input().transport)).resolves.toBe("started")
  const oldReply = Promise.withResolvers<BridgeReply>()
  fixture.setSpectrumReply((nodeId) => nodeId === nativeGraphNodeId("track")
    ? oldReply.promise : Promise.resolve({ ok: true }))
  const first = controller.subscribeSpectrum("track", () => {})
  await Promise.resolve()
  const frames: Array<SpectrumFrame | null> = []
  const second = controller.subscribeSpectrum("master", (frame) => frames.push(frame))
  await Promise.resolve()
  oldReply.resolve({ ok: true })
  await Promise.resolve()
  const selections = fixture.spectrumSelections.length
  fixture.emitSpectrumFrame({ graphRevision: 1, transportEpoch: 1, sequence: 1n,
    nodeId: nativeGraphNodeId("master"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(frames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("master") })
  expect(fixture.spectrumSelections).toHaveLength(selections)
  first()
  second()
  await controller.dispose()
})

test("ignores stale spectrum selection replies and clears pending selection on project switch", async () => {
  const fixture = createBridge()
  let projectId = "local_project"
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => projectId,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  await expect(controller.start(input().transport)).resolves.toBe("started")
  const oldReply = Promise.withResolvers<BridgeReply>()
  fixture.setSpectrumReply((nodeId) => nodeId === nativeGraphNodeId("track") ? oldReply.promise : Promise.resolve({ ok: true }))
  const first = controller.subscribeSpectrum("track", () => {})
  await Promise.resolve()
  const latestFrames: Array<SpectrumFrame | null> = []
  const latest = controller.subscribeSpectrum("master", (frame) => latestFrames.push(frame))
  await Promise.resolve()
  oldReply.resolve({ ok: true })
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  const selectionsBeforeSeek = fixture.spectrumSelections.length
  await expect(controller.seekPrepared(0.25)).resolves.toBe("started")
  expect(fixture.spectrumSelections).toHaveLength(selectionsBeforeSeek)
  fixture.emitSpectrumFrame({ graphRevision: 1, transportEpoch: 2, sequence: 1n,
    nodeId: nativeGraphNodeId("master"), sampleRateHz: 48_000, fftSize: 2_048,
    binCount: 1_024, data: new Float32Array(1_024) })
  expect(latestFrames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("master") })
  first()
  latest()
  const selectionsBeforeSwitch = fixture.spectrumSelections.length
  projectId = "another_project"
  await controller.dispose()
  oldReply.resolve({ ok: true })
  await Promise.resolve()
  expect(fixture.spectrumSelections).toHaveLength(selectionsBeforeSwitch)
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(fixture.spectrumSelections.slice(selectionsBeforeSwitch).map(({ nodeId }) => nodeId))
    .toEqual([null])
  await controller.dispose()
})

test("queues native live notes and releases them through the native backend", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const initialSchedule = fixture.schedulePayloads[0]
  expect(initialSchedule).toBeDefined()
  if (initialSchedule) expect(new DataView(initialSchedule.buffer).getUint32(40, true)).toBe(0)
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toMatchObject({ backend: "native", trackId: "instrument", pitch: 60 })
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)
  expect(controller.hasLiveMidiTails()).toBeTrue()
  expect(fixture.instrumentPayloads).toHaveLength(2)
  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBeLessThanOrEqual(noteOff.getUint32(32, true))
  expect(noteOn.getUint32(36, true)).toBe(101)
  expect(noteOff.getUint32(36, true)).toBe(102)
  await controller.dispose()
  expect(controller.hasLiveMidiTails()).toBeFalse()
})

test("does not retain live MIDI tail ownership when note-on preparation fails", async () => {
  const fixture = createBridge("instrument")
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  if (!handle) throw new Error("Native live note did not start.")
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(controller.hasLiveMidiTails()).toBeFalse()
  await controller.dispose()
})

test("does not retain live MIDI tail ownership when note preparation is cancelled", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: () => compilation.promise,
  })

  const handle = controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
    playheadSec: 0.75,
  })
  if (!handle) throw new Error("Native live note did not queue.")
  expect(controller.hasLiveMidiTails()).toBeFalse()
  controller.releaseLiveMidiNote(handle, true)

  compilation.resolve(compileLivePlaybackSnapshot(liveMidiInput()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(0)
  expect(controller.hasLiveMidiTails()).toBeFalse()
  await controller.dispose()
})

test("retains one session-level live MIDI tail owner across repeated notes", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  for (let index = 0; index < 32; index += 1) {
    const handle = controller.startLiveMidiNote({
      trackId: "instrument",
      pitch: index % 12 + 48,
      velocity: 0.8,
    })
    if (!handle) throw new Error("Native live note did not start.")
    controller.releaseLiveMidiNote(handle)
  }
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(64)
  expect(controller.hasLiveMidiTails()).toBeTrue()
  await controller.dispose()
})

test("forces only the requested live MIDI note off", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const first = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  const second = controller.startLiveMidiNote({ trackId: "instrument", pitch: 64, velocity: 0.8 })
  if (!first || !second) throw new Error("Native live notes did not start.")
  controller.releaseLiveMidiNote(first, true)
  await Bun.sleep(0)
  const forcedRelease = new DataView(fixture.instrumentPayloads.at(-1)!.buffer)
  expect(forcedRelease.getUint32(36, true)).toBe(102)
  expect(forcedRelease.getUint32(44, true)).toBe(60)
  controller.releaseLiveMidiNote(second)
  await controller.dispose()
})

test("notifies MIDI overlay ownership when preview disposal rebuilds the session", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
  })
  let resetCount = 0
  const unsubscribe = controller.subscribeNativeLiveMidiReset(() => { resetCount += 1 })
  await controller.ensureLivePreview(0)
  await controller.dispose()
  expect(resetCount).toBe(1)
  unsubscribe()
})

test("filters native spectrum frames by target, revision, epoch, and sequence", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("track", (frame) => frames.push(frame))
  expect(fixture.spectrumSelections.filter(({ nodeId, sessionStarted }) => nodeId !== null && !sessionStarted)).toEqual([])
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(fixture.spectrumSelections.at(-1)).toEqual({
    nodeId: nativeGraphNodeId("track"),
    sessionStarted: true,
  })
  const valid = {
    graphRevision: 1,
    transportEpoch: 1,
    sequence: 1n,
    nodeId: nativeGraphNodeId("track"),
    sampleRateHz: 48_000,
    fftSize: 2_048,
    binCount: 1_024,
    data: new Float32Array(1_024),
  } satisfies NativeHostSpectrumFrame
  fixture.emitSpectrumFrame(valid)
  fixture.emitSpectrumFrame({ ...valid, sequence: 1n })
  fixture.emitSpectrumFrame({ ...valid, graphRevision: 2, sequence: 2n })
  expect(frames.at(-1)).toMatchObject({ sampleRate: 48_000, fftSize: 2_048, binCount: 1_024 })
  await controller.dispose()
  expect(frames.at(-1)).toBeNull()
  unsubscribe()
})

test("retains the spectrum target while rebuilding the native session", async () => {
  const fixture = createBridge()
  let projectGeneration = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectGeneration: () => projectGeneration,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  const frames: Array<SpectrumFrame | null> = []
  const unsubscribe = controller.subscribeSpectrum("track", (frame) => frames.push(frame))

  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(fixture.spectrumNodeIds).toContain(nativeGraphNodeId("track"))

  await controller.pause(0.5)
  const beforeRebuild = {
    begin: fixture.calls.filter((call) => call === "begin").length,
    graph: fixture.calls.filter((call) => call === "graph").length,
    install: fixture.calls.filter((call) => call === "install").length,
  }
  projectGeneration += 1
  await expect(controller.start({ ...input().transport, playheadSec: 0.5 })).resolves.toBe("started")
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(beforeRebuild.begin + 1)
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(beforeRebuild.graph + 1)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(beforeRebuild.install + 1)
  expect(fixture.spectrumNodeIds.at(-1)).toBe(nativeGraphNodeId("track"))

  fixture.emitSpectrumFrame({
    graphRevision: 1,
    transportEpoch: 2,
    sequence: 1n,
    nodeId: nativeGraphNodeId("track"),
    sampleRateHz: 48_000,
    fftSize: 2_048,
    binCount: 1_024,
    data: new Float32Array(1_024),
  })
  expect(frames.at(-1)).toMatchObject({ nodeId: nativeGraphNodeId("track"), sequence: 1n })

  unsubscribe()
  expect(fixture.spectrumNodeIds.at(-1)).toBeNull()
  await controller.dispose()
})

test("lazily starts a paused native preview and preserves queued note order", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  let compiledTransport: LivePlaybackSnapshotInput["transport"] | undefined
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: (transport) => {
      compiledTransport = transport
      return compilation.promise
    },
  })

  const handle = controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
    playheadSec: 0.75,
  })
  expect(handle).toBeDefined()
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeFalse()

  compilation.resolve(compileLivePlaybackSnapshot(liveMidiInput()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  expect(compiledTransport).toMatchObject({ state: "paused", playheadSec: 0.75 })
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)

  if (!handle) throw new Error("Native live note did not queue.")
  controller.releaseLiveMidiNote(handle)
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(2)
  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBe(noteOff.getUint32(32, true))
  expect(noteOn.getBigUint64(20, true)).toBe(1_000_000n)
  expect(noteOff.getBigUint64(20, true)).toBe(1_000_001n)
  await controller.dispose()
})

test("releases a short native note exactly once after deferred preview preparation", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: () => compilation.promise,
  })

  const handle = controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
    playheadSec: 0.75,
  })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Native live note did not queue.")
  controller.releaseLiveMidiNote(handle)
  controller.releaseLiveMidiNote(handle)

  compilation.resolve(compileLivePlaybackSnapshot(liveMidiInput()))
  await expect(controller.ensureLivePreview(0.75)).resolves.toBe("started")
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(2)
  expect(new DataView(fixture.instrumentPayloads[0]!.buffer).getUint32(36, true)).toBe(101)
  expect(new DataView(fixture.instrumentPayloads[1]!.buffer).getUint32(36, true)).toBe(102)
  await controller.dispose()
})

test("does not claim live MIDI for a track absent from the prepared native graph", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  expect(controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
  })).toBeUndefined()
  expect(fixture.instrumentPayloads).toHaveLength(0)
  await controller.dispose()
})

test("does not claim live MIDI for an empty instrument track compiled as a source node", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...input(),
      transport,
      tracks: [{ ...instrumentTrack, clips: [] }],
    }),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  expect(controller.startLiveMidiNote({
    trackId: "instrument",
    pitch: 60,
    velocity: 0.8,
  })).toBeUndefined()
  expect(fixture.instrumentPayloads).toHaveLength(0)
  await controller.dispose()
})

test("cold rebuild retirement returns the stopped host frame rather than stale renderer progress", async () => {
  const fixture = createBridge()
  let releaseStarted = false
  const stopping = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const stop = fixture.bridge.session.stop
  fixture.bridge.session.stop = async () => {
    const reply = await stop()
    stopping.resolve()
    await stopped.promise
    return reply
  }
  const releaseAsset = fixture.bridge.session.releaseAsset
  fixture.bridge.session.releaseAsset = async (sessionAssetId) => {
    releaseStarted = true
    const reply = await releaseAsset(sessionAssetId)
    return reply
  }
  const controller = createObservedController({
    bridge: {
      ...fixture.bridge,
      diagnostics: async () => {
        expect(fixture.calls).toContain("stop")
        if (releaseStarted) return { ok: false, error: "The native audio host is unavailable." }
        return { ok: true, status: { pid: 123, generation: 7 }, configurationGeneration: 1, diagnostics: {
          transportFrame: 3072n, activeRevision: 1, transportEpoch: fixture.transports.at(-1)?.epoch ?? 0,
        } }
      },
    },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  try {
    expect(await controller.start(input().transport)).toBe("started")
    let stoppedPosition: number | undefined
    const retirement = controller.dispose({ onStoppedPosition: (seconds) => { stoppedPosition = seconds } }, "timeline-rebuild-retirement")
    await stopping.promise
    // Let retirement enqueue any asset releases while the host Stop ACK is held.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    stopped.resolve()
    await retirement
    expect(stoppedPosition).toBe(3072 / 48000)
    expect(fixture.calls.at(-1)).toBe("teardown")
    expect(await controller.start({ ...input().transport, playheadSec: stoppedPosition ?? 0 })).toBe("started")
    expect(controller.isActive()).toBeTrue()
    expect(fixture.transports.at(-1)).toMatchObject({ frame: 3072, running: true })
  } finally {
    await controller.destroy()
  }
})

test("cold rebuild rejects a second same-host configure before publishing a stopped position", async () => {
  const fixture = createBridge()
  let configurationGeneration = 0
  let hostFrame = 3072n
  const configure = fixture.bridge.session.configure
  fixture.bridge.session.configure = async (...args) => {
    const reply = await configure(...args)
    if (!reply.ok) return reply
    configurationGeneration += 1
    return { ok: true, hostIdentity: { pid: 123, generation: 7, configurationGeneration } }
  }
  const controller = createObservedController({
    bridge: {
      ...fixture.bridge,
      diagnostics: async () => ({
        ok: true,
        status: { pid: 123, generation: 7 },
        configurationGeneration,
        diagnostics: {
          transportFrame: hostFrame,
          activeRevision: 1,
          transportEpoch: fixture.transports.at(-1)?.epoch ?? 0,
        },
      }),
    },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  try {
    expect(await controller.start(input().transport)).toBe("started")
    const stop = fixture.bridge.session.stop
    fixture.bridge.session.stop = async () => {
      const reply = await stop()
      await fixture.bridge.session.configure()
      hostFrame = 0n
      return reply
    }
    let stoppedPosition: number | undefined
    await expect(controller.dispose({
      onStoppedPosition: (seconds) => { stoppedPosition = seconds },
    }, "timeline-rebuild-retirement")).rejects.toThrow()
    expect(stoppedPosition).toBeUndefined()
    expect(fixture.calls.at(-1)).toBe("teardown")
  } finally {
    await controller.destroy()
  }
})

test("cold rebuild rejects a missing stopped-diagnostics configuration identity", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: {
      ...fixture.bridge,
      diagnostics: async () => {
        const ok: true = true
        const reply = {
          ok,
          status: { pid: 123, generation: 7 },
          configurationGeneration: 1,
          diagnostics: {
            transportFrame: 3072n,
            activeRevision: 1,
            transportEpoch: fixture.transports.at(-1)?.epoch ?? 0,
          },
        }
        Reflect.deleteProperty(reply, "configurationGeneration")
        return reply
      },
    },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  try {
    expect(await controller.start(input().transport)).toBe("started")
    let stoppedPosition: number | undefined
    await expect(controller.dispose({
      onStoppedPosition: (seconds) => { stoppedPosition = seconds },
    }, "timeline-rebuild-retirement")).rejects.toThrow()
    expect(stoppedPosition).toBeUndefined()
    expect(fixture.calls.at(-1)).toBe("teardown")
  } finally {
    await controller.destroy()
  }
})

test("cold rebuild rejects a configure reply missing its configuration identity", async () => {
  const fixture = createBridge()
  const configure = fixture.bridge.session.configure
  fixture.bridge.session.configure = async (...args): Promise<
    { ok: true; hostIdentity: { pid: number; generation: number; configurationGeneration: number } }
    | { ok: false; error: string }
  > => {
    const reply = await configure(...args)
    if (!reply.ok) return reply
    const hostIdentity = { ...reply.hostIdentity }
    Reflect.deleteProperty(hostIdentity, "configurationGeneration")
    return { ok: true, hostIdentity }
  }
  const controller = createObservedController({
    bridge: {
      ...fixture.bridge,
      diagnostics: async () => ({
        ok: true,
        status: { pid: 123, generation: 7 },
        configurationGeneration: 1,
        diagnostics: {
          transportFrame: 3072n,
          activeRevision: 1,
          transportEpoch: fixture.transports.at(-1)?.epoch ?? 0,
        },
      }),
    },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  try {
    expect(await controller.start(input().transport)).toBe("started")
    let stoppedPosition: number | undefined
    await expect(controller.dispose({
      onStoppedPosition: (seconds) => { stoppedPosition = seconds },
    }, "timeline-rebuild-retirement")).rejects.toThrow()
    expect(stoppedPosition).toBeUndefined()
    expect(fixture.calls.at(-1)).toBe("teardown")
  } finally {
    await controller.destroy()
  }
})

test("cold rebuild rejects when both configuration identity values are missing", async () => {
  const fixture = createBridge()
  const configure = fixture.bridge.session.configure
  fixture.bridge.session.configure = async (...args) => {
    const reply = await configure(...args)
    if (!reply.ok) return reply
    Reflect.deleteProperty(reply.hostIdentity, "configurationGeneration")
    return reply
  }
  const controller = createObservedController({
    bridge: {
      ...fixture.bridge,
      diagnostics: async () => {
        const ok: true = true
        const reply = {
          ok,
          status: { pid: 123, generation: 7 },
          configurationGeneration: 1,
          diagnostics: {
            transportFrame: 3072n,
            activeRevision: 1,
            transportEpoch: fixture.transports.at(-1)?.epoch ?? 0,
          },
        }
        Reflect.deleteProperty(reply, "configurationGeneration")
        return reply
      },
    },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  try {
    expect(await controller.start(input().transport)).toBe("started")
    let stoppedPosition: number | undefined
    await expect(controller.dispose({
      onStoppedPosition: (seconds) => { stoppedPosition = seconds },
    }, "timeline-rebuild-retirement")).rejects.toThrow()
    expect(stoppedPosition).toBeUndefined()
    expect(fixture.calls.at(-1)).toBe("teardown")
  } finally {
    await controller.destroy()
  }
})

for (const failure of ["stop", "revision", "epoch", "pid", "generation", "loss"]) {
  test(`cold rebuild rejects ${failure} without publishing a stopped position`, async () => {
    const fixture = createBridge()
    let diagnosticsReads = 0
    const controller = createObservedController({
      bridge: {
        ...fixture.bridge,
        diagnostics: async () => {
          diagnosticsReads += 1
          const transport = fixture.transports.at(-1)
          return {
            ok: true,
            status: { pid: failure === "pid" ? 124 : 123, generation: failure === "generation" ? 8 : 7 },
            configurationGeneration: 1,
            diagnostics: {
              transportFrame: 3072n,
              activeRevision: failure === "revision" ? 99 : 1,
              transportEpoch: failure === "epoch" ? 99 : transport?.epoch ?? 0,
            },
          }
        },
      },
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
    })
    try {
      expect(await controller.start(input().transport)).toBe("started")
      const stop = fixture.bridge.session.stop
      fixture.bridge.session.stop = async () => {
        const reply = await stop()
        if (failure === "loss") fixture.emitLoss("host lost during retirement")
        return failure === "stop" ? { ok: false, error: "Stop failed" } : reply
      }
      let stoppedPosition: number | undefined
      await expect(controller.dispose({
        onStoppedPosition: (seconds) => { stoppedPosition = seconds },
      }, "timeline-rebuild-retirement")).rejects.toThrow()
      expect(stoppedPosition).toBeUndefined()
      expect(fixture.calls.at(-1)).toBe("teardown")
      if (failure === "stop") expect(diagnosticsReads).toBe(0)
    } finally {
      await controller.destroy()
    }
  })
}

test("loop hydration during Play preparation cannot pause the completed start", async () => {
  const fixture = createBridge()
  const priming = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const schedule = fixture.bridge.session.queueScheduleWindow
  fixture.bridge.session.queueScheduleWindow = async (...args) => {
    priming.resolve()
    await release.promise
    return schedule(...args)
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  try {
    const play = controller.start(input().transport)
    await priming.promise
    const loop = controller.updateLoop({ loopEnabled: false, loopStartSec: 0, loopEndSec: 8 })
    release.resolve()
    await play
    await loop
    expect(controller.isActive()).toBeTrue()
    expect(fixture.transports.at(-1)?.running).toBeTrue()
    expect(fixture.calls.filter((call) => call === "configure")).toHaveLength(1)
  } finally {
    release.resolve()
    await controller.destroy()
  }
})

test("prepares a paused native preview without starting transport", async () => {
  const fixture = createBridge()
  let compiledTransport: LivePlaybackSnapshotInput["transport"] | undefined
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => {
      compiledTransport = transport
      return compileLivePlaybackSnapshot(input())
    },
  })

  await expect(controller.ensureLivePreview(0.5)).resolves.toBe("started")
  expect(compiledTransport).toMatchObject({
    state: "paused",
    playheadSec: 0.5,
    loopEnabled: false,
    loopStartSec: 0,
    loopEndSec: 0,
  })
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
  await controller.dispose()
})

test("serializes synchronous native live note events through the single host request slot", async () => {
  const fixture = createBridge(undefined, true)
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(liveMidiInput()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  expect(await controller.ensureLivePreview(0)).toBe("started")
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Native live note did not start.")
  controller.releaseLiveMidiNote(handle)

  await Promise.resolve()
  expect(fixture.instrumentRequests).toHaveLength(1)
  expect(faults).toEqual([])
  fixture.instrumentRequests[0]?.resolve({ ok: true })
  await Bun.sleep(0)
  expect(fixture.instrumentRequests).toHaveLength(2)
  expect(faults).toEqual([])
  fixture.instrumentRequests[1]?.resolve({ ok: true })
  await Bun.sleep(0)
  expect(fixture.instrumentPayloads).toHaveLength(2)
  expect(faults).toEqual([])

  const noteOn = new DataView(fixture.instrumentPayloads[0]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[1]!.buffer)
  expect(noteOn.getUint32(32, true)).toBeLessThanOrEqual(noteOff.getUint32(32, true))
  expect(noteOn.getUint32(36, true)).toBe(101)
  expect(noteOff.getUint32(36, true)).toBe(102)
  await controller.dispose()
})

test("coordinates native attachments inside the encompassing session transaction", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot(input())
      if (!result.supported) throw new Error(result.reasons.join(" "))
      const parameterId = externalAutomationParameterId(nativeAttachmentPlan.attachments[0]!.instanceId, 7)
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          mixer: {
            ...result.snapshot.mixer,
            automationEnvelopes: [{
              id: "automation",
              projectId: "project:1",
              target: { kind: "track" as const, trackId: "track" },
              targetKey: automationTargetKey({ kind: "track", trackId: "track" }, "volume"),
              parameterId,
              enabled: true,
              points: [{ id: "point", timeSec: 0, value: 0.6, interpolation: "hold" as const }],
              updatedAt: 1,
            }],
          },
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toEqual(["begin", "coordinate", "configure", "install", "graph", "parameter", "transport", "commit", "start", "schedule", "transport"])
  expect(fixture.schedulePayloads.some((payload) => (
    new TextDecoder().decode(payload).includes(nativeAttachmentPlan.attachments[0]!.instanceId)
  ))).toBeTrue()
  await controller.dispose()
})

test("allows native reverb alongside a native VST attachment", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot({
        ...input(),
        renderState: {
          fx: {
            masterVolume: 1,
            masterFxInstances: [],
            trackFx: {
              track: {
                instances: [{
                  id: "reverb:1",
                  kind: "reverb",
                  params: createDefaultReverbParams(),
                }],
              },
            },
          },
          automationEnvelopes: [],
        },
      })
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("coordinate")
  expect(fixture.calls).toContain("graph")
  const graph = fixture.graphPayloads[0]
  if (!graph) throw new Error("Expected native graph payload.")
  const view = new DataView(graph.buffer)
  const nodeBytes = view.getUint32(12, true) === 4 ? 136 : 132
  const processorOffset = 12 + 24 + 2 * nodeBytes + 48
  expect(view.getUint32(processorOffset + 8, true)).toBe(14)
  expect(view.getUint32(processorOffset + 16, true)).toBe(72)
  expect(view.getUint32(processorOffset + 48, true)).toBe(1)
  await controller.dispose()
})

test("prepares arranged synth MIDI with native reverb and VST effect", async () => {
  const fixture = createBridge()
  const instrumentAttachmentPlan: NativeExternalAttachmentPlan = {
    ...nativeAttachmentPlan,
    attachments: nativeAttachmentPlan.attachments.map((attachment) => ({
      ...attachment,
      graphNodeId: "instrument",
    })),
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot({
        ...input(instrumentTrack),
        renderState: {
          fx: {
            masterVolume: 1,
            masterFxInstances: [],
            trackFx: {
              instrument: {
                instances: [{
                  id: "reverb:1",
                  kind: "reverb",
                  params: createDefaultReverbParams(),
                }],
                instrument: {
                  kind: "synth",
                  instanceId: "synth:1",
                  params: createDefaultSynthParams(),
                },
              },
            },
          },
          automationEnvelopes: [],
        },
      })
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: instrumentAttachmentPlan,
          requiresNativePlayback: true,
        },
      }
    },
  })

  expect(await controller.start(input(instrumentTrack).transport)).toBe("started")
  expect(fixture.calls).toContain("coordinate")
  expect(fixture.calls).toContain("schedule")
  expect(fixture.schedulePayloads.length).toBeGreaterThan(0)
  await controller.dispose()
})

test("primes arranged playback only after the committed native session starts", async () => {
  const fixture = createBridge(undefined, false, true)
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  await expect(controller.start(input(instrumentTrack).transport)).resolves.toBe("started")
  expect(fixture.calls.indexOf("commit")).toBeLessThan(fixture.calls.indexOf("start"))
  expect(fixture.calls.indexOf("start")).toBeLessThan(fixture.calls.indexOf("schedule"))
  expect(controller.isActive()).toBeTrue()
  await controller.dispose()
})

test("compiles native playback with the default synth when instrument state is absent", () => {
  const result = compileLivePlaybackSnapshot({
    ...input(instrumentTrack),
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: {},
      },
      automationEnvelopes: [],
    },
  })

  if (!result.supported) throw new Error(result.reasons.join(" "))
  const projection = compileLiveNativeProjection({
    tracks: result.snapshot.tracks,
    fx: result.snapshot.mixer.fx,
    bpm: result.snapshot.bpm,
    sampleRateHz: 48_000,
    revision: result.snapshot.revision,
    epoch: 1,
    firstSequence: 1,
  })
  if (!projection.supported) throw new Error(projection.reasons.join(" "))
  expect(projection.graph.nodes.find((node) => node.id === "instrument")).toMatchObject({
    kind: "instrument",
    instrument: { kind: "synth" },
  })
  expect(result.snapshot.mixer.fx.trackFx).toEqual({})
})

test("queues bounded native VST overrides and current-block automation", async () => {
  const fixture = createBridge()
  const parameterId = externalAutomationParameterId(nativeAttachmentPlan.attachments[0]?.instanceId ?? "", 7)
  const envelope = {
    id: "automation:1",
    projectId: "project:1",
    target: { kind: "track" as const, trackId: "track", effectInstanceId: nativeAttachmentPlan.attachments[0]?.instanceId },
    targetKey: automationTargetKey(
      { kind: "track", trackId: "track", effectInstanceId: nativeAttachmentPlan.attachments[0]?.instanceId },
      parameterId,
    ),
    parameterId,
    enabled: true,
    points: [
      { id: "start", timeSec: 0, value: 0.5, interpolation: "linear" as const },
      { id: "next", timeSec: 0.005, value: 0.75, interpolation: "linear" as const },
    ],
    updatedAt: 1,
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectId: () => "project:1",
    compileSnapshot: async () => {
      const result = compileLivePlaybackSnapshot(input())
      if (!result.supported) throw new Error(result.reasons.join(" "))
      return {
        supported: true,
        snapshot: {
          ...result.snapshot,
          nativeExternalAttachmentPlan: nativeAttachmentPlan,
          requiresNativePlayback: true,
          mixer: { ...result.snapshot.mixer, automationEnvelopes: [envelope] },
        },
      }
    },
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("parameter")
  const bytes = fixture.parameterPayloads[0]
  expect(bytes).toBeDefined()
  if (!bytes) return
  const view = new DataView(bytes.buffer)
  const instanceBytes = view.getUint32(0, true)
  expect(view.getUint32(4 + instanceBytes, true)).toBe(1)
  expect(view.getUint32(8 + instanceBytes, true)).toBe(7)
  expect(view.getUint32(12 + instanceBytes, true)).toBe(0)
  expect(view.getFloat64(16 + instanceBytes, true)).toBe(0.4)
})

test("queues native MIDI events for a projected synth track", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("instrument")
  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(fixture.calls).toContain("schedule")
  const eventTypes = nativeInstrumentEventTypes(fixture.instrumentPayloads[0]!)
  expect(eventTypes).toEqual([5, 5, 5, 5, 5, 5, 5, 5])
  await controller.dispose()
})

test("rejects schedules that exceed the native callback capacity", async () => {
  const fixture = createBridge()
  const denseTrack: RuntimeTrack = {
    ...instrumentTrack,
    clips: [{
      ...instrumentTrack.clips[0]!,
      midi: {
        wave: "sawtooth",
        notes: Array.from({ length: 600 }, (_, index) => ({
          pitch: 36 + (index % 48),
          beat: 0,
          length: 0.25,
          velocity: 0.5,
        })),
      },
    }],
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(denseTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
  await controller.dispose()
})

test("omits arranged MIDI from paused native preview initialization", async () => {
  const createController = (fixture: ReturnType<typeof createBridge>) => createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })
  const fixture = createBridge()
  const controller = createController(fixture)

  expect(await controller.ensureLivePreview(0.5)).toBe("started")
  expect(fixture.instrumentPayloads).toHaveLength(1)
  expect(nativeInstrumentEventTypes(fixture.instrumentPayloads[0]!)).toEqual([5, 5, 5, 5, 5, 5, 5, 5])
  await controller.dispose()
})

test("releases only instrument nodes from the prepared native graph", async () => {
  const actualInstrumentTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "actual-instrument",
  }
  const emptyInstrumentTrack: RuntimeTrack = {
    ...instrumentTrack,
    id: "empty-instrument",
    clips: [],
  }
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(),
    tracks: [actualInstrumentTrack, emptyInstrumentTrack],
    renderState: {
      fx: {
        masterVolume: 1,
        masterFxInstances: [],
        trackFx: {
          "actual-instrument": {
            instances: [],
            instrument: {
              kind: "synth",
              instanceId: "synth:actual",
              params: createDefaultSynthParams(),
            },
          },
        },
      },
      automationEnvelopes: [],
    },
  }
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })

  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  const initialPayloadCount = fixture.instrumentPayloads.length
  await controller.pause(0.5)

  const releaseEvents = nativeTransportReleaseEvents(
    fixture.instrumentPayloads.slice(initialPayloadCount),
  )
  expect(releaseEvents).toEqual([{
    nodeId: nativeGraphNodeId("actual-instrument"),
    type: 103,
  }])
  expect(releaseEvents).not.toContainEqual({
    nodeId: nativeGraphNodeId("empty-instrument"),
    type: 103,
  })

  await controller.dispose()
})

test("B6d2 resume prepares again when the recompile names a source the session never installed", async () => {
  const fixture = createBridge()
  const [clip] = sourceTrack().clips
  if (!clip) throw new Error("Missing source clip")
  const long = { ...sourceTrack(), clips: [{ ...clip, duration: 5, sampleUrl: silenceWavDataUrl(270_000, 2),
    buffer: new TestAudioBuffer([new Float32Array(270_000), new Float32Array(270_000)]) }] }
  const empty = input({ ...sourceTrack(), clips: [] })
  let next = empty
  const faults: NativePlaybackFault[] = []
  const controller = createObservedController({ bridge: fixture.bridge, reportFault: fault => { faults.push(fault) },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...next, transport }) })
  try {
    expect(await controller.start(empty.transport)).toBe("started")
    await controller.pause(0.5)
    // A schedule edit no adoption installed: the paused session never staged its source.
    next = input(long)
    expect(await controller.start({ ...empty.transport, playheadSec: 0.5 })).toBe("started")
    expect(fixture.calls.filter(call => call === "begin")).toHaveLength(2)
    expect(faults).toEqual([])
    expect(decodeNativeSourceEvents(fixture.schedulePayloads).length).toBeGreaterThan(0)
  } finally { await controller.dispose() }
})

test("B6d2 resume prepares again when the recompile adds a processor the prepared graph does not hold", async () => {
  const fixture = createBridge()
  const withUtility = utilityPlaybackInput()
  const without = { ...withUtility, renderState: { ...withUtility.renderState,
    fx: { ...withUtility.renderState.fx, trackFx: { track: { instances: [] } } } } }
  const registry = createProcessorEditRegistry(() => 120)
  registry.observe(without.renderState.fx)
  let current: LivePlaybackSnapshotInput = without
  const faults: NativePlaybackFault[] = []
  const controller = createObservedController({
    bridge: fixture.bridge, getProcessorTarget: registry.target, reportFault: fault => { faults.push(fault) },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...current, transport }),
    getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 900),
  })
  try {
    expect(await controller.start(without.transport)).toBe("started")
    await controller.pause(0.5)
    // A Utility added while paused with no adoption: only the projection and the registry carry it.
    current = withUtility
    registry.observe(current.renderState.fx)
    expect(await controller.start({ ...without.transport, playheadSec: 0.5 })).toBe("started")
    expect(fixture.calls.filter(call => call === "begin")).toHaveLength(2)
    const edit = registry.allocate(utilityCommit("utility:1", createDefaultUtilityParams(), { ...createDefaultUtilityParams(), gainDb: -9 }))
    if (!edit) throw new Error("Missing allocated edit")
    expect(await controller.deliverProcessor(edit).settled).toEqual({ state: "applied" })
    expect(faults).toEqual([])
    const bytes = fixture.builtInParameterPayloads.at(-1)
    if (!bytes) throw new Error("The added processor's edit was answered without a send")
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(36, true)).toBe(-9)
  } finally { await controller.dispose() }
})

test("B6d2 resume sends processor content its recompile carries and the prepared graph does not hold", async () => {
  const fixture = createBridge()
  const base = utilityPlaybackInput()
  const registry = createProcessorEditRegistry(() => 120)
  registry.observe(base.renderState.fx)
  let current = base
  const controller = createObservedController({
    bridge: fixture.bridge, getProcessorTarget: registry.target,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...current, transport }),
    getDesiredProcessorState: (snapshot, rate) => compileDesiredNativeProcessorState(snapshot, rate, 900),
  })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    await controller.pause(0.5)
    expect(fixture.builtInParameterPayloads).toHaveLength(0)
    // Written while paused with no live delivery (a collaborator, history): only the projection carries it.
    const changed = { ...createDefaultUtilityParams(), gainDb: -6 }
    current = { ...base, renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { track: {
      instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: changed } }] } } } } }
    registry.observe(current.renderState.fx)
    expect(await controller.start({ ...base.transport, playheadSec: 0.5 })).toBe("started")
    for (let turn = 0; turn < 60; turn++) await Promise.resolve()
    const bytes = fixture.builtInParameterPayloads.at(-1)
    if (!bytes) throw new Error("The recompiled processor content was never sent")
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(36, true)).toBe(-6)
  } finally { await controller.dispose() }
})

test("pause and resume retain the prepared native graph and installed assets", async () => {
  const fixture = createBridge(undefined, false, false, "failed", 48_000, true)
  let compilations = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => {
      compilations += 1
      return compileLivePlaybackSnapshot(input())
    },
  })

  await controller.start(input().transport)
  await controller.pause(0.5)
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeTrue()
  expect(controller.isPrepared()).toBeTrue()
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(0)
  await controller.start({ ...input().transport, playheadSec: 0.5 })

  expect(compilations).toBe(2)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(4)
  expect(fixture.transports.map(({ running }) => running)).toEqual([false, true, false, true])
  expect(fixture.transports.map(({ epoch }) => epoch)).toEqual([1, 1, 2, 2])
  expect(controller.isActive()).toBeTrue()
  expect(controller.isPrepared()).toBeTrue()
  expect(fixture.calls).not.toContain("release")
})

test("primes each advancing prepared resume with active source and automation windows", async () => {
  const fixture = createBridge()
  const track = {
    ...sourceTrack(),
    clips: [{
      ...sourceTrack().clips[0]!,
      duration: 5,
      sourceKind: "url" as const,
      sampleUrl: silenceWavDataUrl(270_000, 2),
      buffer: new TestAudioBuffer([
        new Float32Array(270_000),
        new Float32Array(270_000),
      ]),
    }],
  }
  const snapshotInput: LivePlaybackSnapshotInput = {
    ...input(track),
    renderState: {
      ...input(track).renderState,
      automationEnvelopes: [{
        id: "volume-automation",
        projectId: "project:1",
        target: { kind: "track", trackId: "track" },
        targetKey: automationTargetKey({ kind: "track", trackId: "track" }, "volume"),
        parameterId: "volume",
        enabled: true,
        points: [
          { id: "start", timeSec: 0, value: 0.25, interpolation: "linear" },
          { id: "end", timeSec: 6, value: 0.75, interpolation: "linear" },
        ],
        updatedAt: 1,
      }],
    },
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
  })

  await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
  await controller.pause(3)
  await expect(controller.start({ ...snapshotInput.transport, playheadSec: 3 })).resolves.toBe("started")
  await controller.pause(3.5)
  await expect(controller.start({ ...snapshotInput.transport, playheadSec: 3.5 })).resolves.toBe("started")

  const runningTransports = fixture.transports.filter(({ running }) => running)
  expect(runningTransports.map(({ epoch, frame }) => ({ epoch, frame }))).toEqual([
    { epoch: 1, frame: 0 },
    { epoch: 2, frame: 144_000 },
    { epoch: 3, frame: 168_000 },
  ])
  const sourceEvents = decodeNativeSourceEvents(fixture.schedulePayloads)
  expect(new Set(sourceEvents.filter((event) => event.epoch === 1).map((event) => event.assetId)).size).toBe(1)
  expect(new Set(sourceEvents.filter((event) => event.epoch === 2).map((event) => event.assetId)).size).toBe(1)
  expect(sourceEvents.find((event) => event.epoch === 2)?.assetId)
    .toBe(sourceEvents.find((event) => event.epoch === 1)?.assetId)
  for (const transport of runningTransports) {
    const windows = fixture.schedulePayloads.filter((payload) => {
      const view = new DataView(payload.buffer)
      return view.getUint32(4, true) === transport.epoch
        && Number(view.getBigUint64(16, true)) <= transport.frame
        && Number(view.getBigUint64(24, true)) > transport.frame
    })
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.some((payload) => decodeNativeSourceEvents([payload]).some((event) => (
      event.startFrame <= transport.frame && event.stopFrame > transport.frame
    )))).toBeTrue()
    expect(windows.some((payload) => decodeNativeProcessorEvents([payload]).some((event) => (
      event.frame >= transport.frame
    )))).toBeTrue()
  }

  await controller.dispose()
})

test("rebuilds the coordinator when same-frame resume changes loop scheduling", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  await controller.pause(0.5)
  await expect(controller.start({
    ...input().transport,
    playheadSec: 0.5,
    loopEnabled: true,
    loopStartSec: 0.25,
    loopEndSec: 1.25,
  })).resolves.toBe("started")

  expect(fixture.transports.map(({ epoch, running, hasCycleStart, hasCycleEnd }) => ({
    epoch,
    running,
    hasCycleStart,
    hasCycleEnd,
  }))).toEqual([
    { epoch: 1, running: false, hasCycleStart: false, hasCycleEnd: false },
    { epoch: 1, running: true, hasCycleStart: false, hasCycleEnd: false },
    { epoch: 2, running: false, hasCycleStart: false, hasCycleEnd: false },
    { epoch: 3, running: false, hasCycleStart: true, hasCycleEnd: true },
    { epoch: 3, running: true, hasCycleStart: true, hasCycleEnd: true },
  ])
  expect(controller.isActive()).toBeTrue()
  expect(controller.isPrepared()).toBeTrue()
  await controller.dispose()
})

test("does not let a superseded prepared resume dispose its replacement coordinator", async () => {
  const fixture = createBridge()
  const epoch2PausedTransitionReached = Promise.withResolvers<void>()
  const resumeGate = Promise.withResolvers<void>()
  let transportTail = Promise.resolve()
  const originalSetTransport = fixture.bridge.session.setTransport
  const bridge = {
    ...fixture.bridge,
    session: {
      ...fixture.bridge.session,
      setTransport: (transport: Parameters<typeof originalSetTransport>[0]) => {
        const request = transportTail.then(async () => {
          if (transport.epoch === 2 && !transport.running) {
            epoch2PausedTransitionReached.resolve()
            await resumeGate.promise
          }
          return originalSetTransport(transport)
        })
        transportTail = request.then(() => undefined, () => undefined)
        return request
      },
    },
  }
  const faults: string[] = []
  const controller = createObservedController({
    bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
  const play = controller.start({ ...input().transport, playheadSec: 0.125 })
  await epoch2PausedTransitionReached.promise
  const seek = controller.seekPrepared(0.25)
  resumeGate.resolve()

  await expect(play).resolves.toBe("unavailable")
  await expect(seek).resolves.toBe("started")
  expect(faults).toEqual([])
  expect(controller.isPrepared()).toBeTrue()
  expect(controller.isActive()).toBeFalse()
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(controller.isActive()).toBeTrue()
  await controller.dispose()
})

test("B6d3 a seek requested while a Play waits on a preview start supersedes that Play", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })
  try {
    const preview = controller.ensureLivePreview(0)
    const play = controller.start({ ...input().transport, playheadSec: 0.125 })
    for (let turn = 0; turn < 200 && !controller.isPrepared(); turn++) await Promise.resolve()
    expect(controller.isPrepared()).toBeTrue()
    // The preview has committed and is still starting; the Play waits on it.
    const before = fixture.transports.length
    const seek = controller.seekPrepared(0.25)
    const answers = { preview: await preview, play: await play, seek: await seek }
    const after = fixture.transports.slice(before)
    console.log("B6D3-SEEK-CHAINED-PLAY", JSON.stringify({ answers, after, active: controller.isActive(), faults }))
    expect(answers.seek).toBe("started")
    expect(answers.play).toBe("unavailable")
    expect(controller.isActive()).toBeFalse()
    expect(controller.isPrepared()).toBeTrue()
    expect(after.filter(({ running }) => running)).toEqual([])
    expect(after.at(-1)?.frame).toBe(12_000)
    expect(faults).toEqual([])
  } finally { await controller.dispose() }
})

test("B6d3 a prepared resume disposed once its lookahead is accepted never runs the transport", async () => {
  const fixture = createBridge()
  const held: { listener: (progress: NativeScheduleProgress) => void; progress: NativeScheduleProgress }[] = []
  const acceptanceHeld = Promise.withResolvers<void>()
  let holdNextWindow = false
  let holding = false
  const originalQueueScheduleWindow = fixture.bridge.session.queueScheduleWindow
  const originalOnScheduleProgress = fixture.bridge.session.onScheduleProgress
  const bridge = {
    ...fixture.bridge,
    session: {
      ...fixture.bridge.session,
      // The resume's priming window is accepted, but its acceptance reaches the controller only when the test says so.
      queueScheduleWindow: (bytes: Uint8Array) => {
        if (holdNextWindow) {
          holdNextWindow = false
          holding = true
          queueMicrotask(() => queueMicrotask(() => acceptanceHeld.resolve()))
        }
        return originalQueueScheduleWindow(bytes)
      },
      onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => originalOnScheduleProgress((progress) => {
        if (holding) held.push({ listener, progress })
        else listener(progress)
      }),
    },
  }
  const controller = createObservedController({ bridge, compileSnapshot: async () => compileLivePlaybackSnapshot(input()) })
  try {
    await expect(controller.start(input().transport)).resolves.toBe("started")
    await controller.pause(0.5)
    holdNextWindow = true
    const resume = controller.start({ ...input().transport, playheadSec: 1 })
    await acceptanceHeld.promise
    expect(held.length).toBeGreaterThan(0)
    const before = fixture.transports.length
    // The acceptance and a dispose land in the same turn, before the resume continues.
    holding = false
    for (const { listener, progress } of held.splice(0)) listener(progress)
    const disposal = controller.dispose()
    const answer = await resume
    await disposal
    const after = fixture.transports.slice(before)
    console.log("B6D3-RESUME-DISPOSED-PRIMING", JSON.stringify({ answer, after, active: controller.isActive() }))
    expect(answer).toBe("unavailable")
    expect(after.filter(({ running }) => running)).toEqual([])
    expect(controller.isActive()).toBeFalse()
  } finally { await controller.dispose() }
})
test("B6d4 a fresh start disposed once its lookahead is accepted never runs the transport", async () => {
  const fixture = createBridge()
  const held: { listener: (progress: NativeScheduleProgress) => void; progress: NativeScheduleProgress }[] = []
  const acceptanceHeld = Promise.withResolvers<void>()
  let holdNextWindow = false
  let holding = false
  const originalQueueScheduleWindow = fixture.bridge.session.queueScheduleWindow
  const originalOnScheduleProgress = fixture.bridge.session.onScheduleProgress
  const bridge = {
    ...fixture.bridge,
    session: {
      ...fixture.bridge.session,
      // The start's priming window is accepted, but its acceptance reaches the controller only when the test says so.
      queueScheduleWindow: (bytes: Uint8Array) => {
        if (holdNextWindow) {
          holdNextWindow = false
          holding = true
          queueMicrotask(() => queueMicrotask(() => acceptanceHeld.resolve()))
        }
        return originalQueueScheduleWindow(bytes)
      },
      onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => originalOnScheduleProgress((progress) => {
        if (holding) held.push({ listener, progress })
        else listener(progress)
      }),
    },
  }
  const controller = createObservedController({ bridge, compileSnapshot: async () => compileLivePlaybackSnapshot(input()) })
  try {
    holdNextWindow = true
    const start = controller.start({ ...input().transport, playheadSec: 1 })
    await acceptanceHeld.promise
    expect(held.length).toBeGreaterThan(0)
    const before = fixture.transports.length
    // The acceptance and a dispose land in the same turn, before the start continues.
    holding = false
    for (const { listener, progress } of held.splice(0)) listener(progress)
    const disposal = controller.dispose()
    const answer = await start
    await disposal
    const after = fixture.transports.slice(before)
    console.log("B6D4-FRESH-DISPOSED-PRIMING", JSON.stringify({ answer, after, active: controller.isActive() }))
    expect(answer).toBe("unavailable")
    expect(after.filter(({ running }) => running)).toEqual([])
    expect(controller.isActive()).toBeFalse()
  } finally { await controller.dispose() }
})
test("queues live MIDI notes through the prepared native host while paused", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot({
      ...input(instrumentTrack),
      renderState: {
        fx: {
          masterVolume: 1,
          masterFxInstances: [],
          trackFx: {
            instrument: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } },
          },
        },
        automationEnvelopes: [],
      },
    }),
  })

  await controller.start(input(instrumentTrack).transport)
  await controller.pause(0.5)
  const handle = controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Native live note did not start while paused.")
  controller.releaseLiveMidiNote(handle)
  await Bun.sleep(0)

  expect(fixture.instrumentPayloads).toHaveLength(4)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(0)
  const noteOn = new DataView(fixture.instrumentPayloads[2]!.buffer)
  const noteOff = new DataView(fixture.instrumentPayloads[3]!.buffer)
  expect(noteOn.getUint32(32, true)).toBe(0)
  expect(noteOff.getUint32(32, true)).toBe(0)
  expect(noteOn.getUint32(32, true)).toBe(noteOff.getUint32(32, true))

  await controller.dispose()
  expect(controller.canProcessLiveMidi()).toBeFalse()
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(1)
})

test("shares one in-flight native playback startup across concurrent callers", async () => {
  const fixture = createBridge()
  const compilation = Promise.withResolvers<ReturnType<typeof compileLivePlaybackSnapshot>>()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: () => compilation.promise,
  })

  const first = controller.start(input().transport)
  const second = controller.start(input().transport)
  expect(second).toBe(first)
  compilation.resolve(compileLivePlaybackSnapshot(input()))

  await expect(Promise.all([first, second])).resolves.toEqual(["started", "started"])
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
})

test("project generation changes release retained native assets before rebuilding", async () => {
  const fixture = createBridge()
  let projectGeneration = 1
  const controller = createObservedController({
    bridge: fixture.bridge,
    getProjectGeneration: () => projectGeneration,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  await controller.pause(0.25)
  projectGeneration += 1
  await controller.dispose()
  await controller.ensureLivePreview(0.25)

  expect(fixture.calls.filter((call) => call === "release")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(2)
  expect(controller.isActive()).toBeFalse()
  expect(controller.canProcessLiveMidi()).toBeTrue()
})

test("destroys a native controller idempotently", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...input(),
      transport,
    }),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  await Promise.all([controller.destroy(), controller.destroy(), controller.destroy()])
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(1)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(1)
})

test("starts sessions with non-unity track gain without opening a legacy fallback", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input(sourceTrack(0.5))),
  })

  expect(await controller.start(input().transport)).toBe("started")
  expect(fixture.calls).toContain("begin")
  expect(fixture.calls).toContain("start")
  await controller.dispose()
})

test("rolls back a failed transaction before allowing legacy fallback", async () => {
  const fixture = createBridge("install")
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
  expect(fixture.calls).toEqual(["begin", "configure", "install", "rollback", "stop", "teardown"])
})

test("ignores native host loss before native ownership begins", () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  fixture.emitLoss()

  expect(controller.isActive()).toBeFalse()
  expect(controller.isAvailable()).toBeTrue()
  expect(faults).toEqual([])
  expect(fixture.calls).toEqual([])
})

test("ignores native host loss after native session disposal", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await controller.start(input().transport)
  await controller.dispose()
  fixture.emitLoss()

  expect(controller.isActive()).toBeFalse()
  expect(faults).toEqual([])
})

test("invalidates native ownership before reporting a terminal refill fault", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const longInstrumentTrack: RuntimeTrack = {
    ...instrumentTrack,
    clips: instrumentTrack.clips.map((clip) => ({ ...clip, duration: 10 })),
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      ...nativeInstrumentInput(),
      transport,
      tracks: [longInstrumentTrack],
    }),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.setScheduleFailure(true)
  for (let index = 0; index < 16; index += 1) {
    fixture.emitScheduleProgress({
      revision: 1,
      epoch: 1,
      progressSequence: BigInt(index + 100),
      renderedThroughFrame: BigInt((index + 1) * 48_000),
      acceptedThroughFrame: 96_000n,
      lastAcceptedWindowId: 1n,
      appliedTransportTransitionId: 2n,
      appliedUrgentSequence: 0n,
      appliedProcessorSequence: 0n,
      running: true,
      scheduleComplete: false,
      instrumentCredits: 256,
      sourceCredits: 256,
      automationCredits: 256,
    })
    await Bun.sleep(0)
  }
  await Bun.sleep(200)

  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeFalse()
  expect(faults).toHaveLength(1)

  fixture.setScheduleFailure(false)
  await expect(controller.start(input().transport)).resolves.toBe("started")
  expect(controller.isActive()).toBeTrue()
  await controller.dispose()
})

test("ignores a queued loss from a retired coordinator after replacement", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const retiredLoss = fixture.captureLoss()
    await controller.dispose()
    await expect(controller.start(input().transport)).resolves.toBe("started")
    retiredLoss(`stale retired coordinator loss ${cycle}`)
    expect(controller.isActive()).toBeTrue()
    expect(controller.isAvailable()).toBeTrue()
  }
  expect(faults).toEqual([])
  await controller.dispose()
})

test("host loss reports the fault without starting another backend", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await controller.start(input().transport)
  fixture.emitLoss()
  expect(controller.isActive()).toBeFalse()
  expect(faults).toEqual(["Native playback host connection was lost."])
  expect(controller.isAvailable()).toBeFalse()
  expect(controller.startLiveMidiNote({ trackId: "instrument", pitch: 60, velocity: 0.8 })).toBeUndefined()
  expect(fixture.calls).toEqual(["begin", "configure", "install", "graph", "transport", "commit", "start", "schedule", "transport"])
})

test("rebuilds the full native session on the next start after host loss", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  fixture.emitLoss("The native audio host stopped.")
  await expect(controller.start(input().transport)).resolves.toBe("started")

  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "graph")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "install")).toHaveLength(2)
  expect(fixture.calls.filter((call) => call === "stop")).toHaveLength(0)
  expect(fixture.calls.filter((call) => call === "teardown")).toHaveLength(0)
  await controller.dispose()
})

test("terminates recovery when the rebuilt host is lost again", async () => {
  const fixture = createBridge()
  let recoveryStartCount = 0
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await controller.start(input().transport)
  fixture.emitLoss()
  const originalStart = fixture.bridge.session.start
  fixture.bridge.session.start = async () => {
    const reply = await originalStart()
    recoveryStartCount += 1
    if (recoveryStartCount === 1) fixture.emitLoss("The native audio host stopped again.")
    return reply
  }
  const first = controller.start(input().transport)
  const second = controller.start(input().transport)
  expect(second).toBe(first)

  await expect(first).resolves.toBe("unavailable")
  expect(recoveryStartCount).toBe(1)
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(controller.isPrepared()).toBeFalse()
  await controller.dispose()
})

test("keeps an in-flight start coalesced while host loss invalidates its first generation", async () => {
  const fixture = createBridge()
  const startGate = Promise.withResolvers<void>()
  const originalStart = fixture.bridge.session.start
  fixture.bridge.session.start = async () => {
    fixture.calls.push("start-gate")
    await startGate.promise
    return originalStart()
  }
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  const first = controller.start(input().transport)
  for (let index = 0; index < 20 && !fixture.calls.includes("start-gate"); index += 1) {
    await Promise.resolve()
  }
  expect(fixture.calls).toContain("start-gate")
  fixture.emitLoss("The native audio host stopped.")
  const second = controller.start(input().transport)
  expect(second).toBe(first)
  startGate.resolve()

  await expect(first).resolves.toBe("started")
  expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
  expect(fixture.calls).not.toContain("rollback")
  expect(fixture.calls).not.toContain("teardown")
  await controller.dispose()
})

test("preserves the native host loss reason in the playback fault", async () => {
  const fixture = createBridge()
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await controller.start(input().transport)
  fixture.emitLoss("The native audio host control request timed out.")

  expect(faults).toEqual(["The native audio host control request timed out."])
  expect(controller.isAvailable()).toBeFalse()
})

test("allows a new native session after explicit host recovery", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  await expect(controller.start(input().transport)).resolves.toBe("started")
  fixture.emitLoss("The native audio host stopped.")
  await controller.dispose()
  controller.resetNativeHostConnectionLoss()

  await expect(controller.start(input().transport)).resolves.toBe("started")
  await controller.dispose()
})

test("disables native after a start failure caused by host loss", async () => {
  const fixture = createBridge("begin", false, false, "The native audio host is unavailable.")
  const faults: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  })

  await expect(controller.start(input().transport)).resolves.toBe("unavailable")
  expect(faults).toEqual(["The native audio host is unavailable."])
  expect(controller.isAvailable()).toBeFalse()
  const callsAfterFailure = fixture.calls.length
  await expect(controller.ensureLivePreview(0)).resolves.toBe("unavailable")
  await expect(controller.start(input().transport)).resolves.toBe("unavailable")
  expect(faults.at(-1)).toContain("The native audio host is unavailable")
  expect(fixture.calls).toHaveLength(callsAfterFailure)
})

test("native Complete imports the retained take instead of subscribing to PCM delivery", async () => {
  const fixture = createBridge()
  const imports: string[] = []
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    importRecordingSpool: async ({ take, sessionId }) => {
      imports.push(take.takeId)
      return { version: 1, sessionId, format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1,
        capturedFrames: 128, byteLength: 516, createdAtMs: 1, finalizedAtMs: 2,
        nativeTake: { takeId: "retained-take", scope: { projectId: "local:test", projectGeneration: 0 },
          acknowledgment: { reason: "imported", sessionId, frames: 128, bytes: 516, blocks: 1,
            channelCount: 1, sampleRateHz: 48000, finalized: true } } }
    },
  })
  await controller.start(input().transport)
  await expect(controller.startRecording({ appSessionId: "take-1", projectId: "local:test", projectGeneration: 0, targetTrackId: "track-1",
    layout: "mono", inputChannel: 0, gain: 1, polarity: 1, monitoring: true, punchStartFrame: 120,
  })).resolves.toEqual({ sampleRate: 48000, channelCount: 1, startFrame: 120 })
  await expect(controller.stopRecording()).resolves.toMatchObject({ capturedFrames: 128, finalizedAtMs: 2 })
  expect(imports).toEqual(["retained-take"])
  expect(fixture.recordingTargets).toEqual([nativeGraphNodeId("track-1")])
  expect(controller.isRecording()).toBeFalse()
})

test("recording Finish and delayed import success or failure do not retire the playback owner", async () => {
  for (const importFails of [false, true]) {
    const fixture = createBridge()
    const finishGate = Promise.withResolvers<void>()
    const finishing = Promise.withResolvers<void>()
    const importGate = Promise.withResolvers<void>()
    const importing = Promise.withResolvers<void>()
    const originalStop = fixture.bridge.session.stopRecording
    fixture.bridge.session.stopRecording = async () => {
      finishing.resolve()
      await finishGate.promise
      return originalStop()
    }
    const faults: string[] = []
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
      reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      importRecordingSpool: async ({ sessionId }) => {
        importing.resolve()
        await importGate.promise
        if (importFails) throw new Error("Import failed; native source retained.")
        return { version: 1, sessionId, format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1,
          capturedFrames: 128, byteLength: 516, createdAtMs: 1, finalizedAtMs: 2,
          nativeTake: { takeId: "retained-take", scope: { projectId: "local:test", projectGeneration: 0 },
            acknowledgment: { reason: "imported", sessionId, frames: 128, bytes: 516, blocks: 1,
              channelCount: 1, sampleRateHz: 48000, finalized: true } } }
      },
    })
    try {
      await controller.start(input().transport)
      await controller.startRecording({ appSessionId: "delayed-import", projectId: "local:test", projectGeneration: 0, targetTrackId: "track-1",
        layout: "mono", inputChannel: 0, gain: 1, polarity: 1, monitoring: true, punchStartFrame: 120 })
      const first = controller.stopRecording()
      void first.catch(() => undefined)
      expect(controller.stopRecording()).toBe(first)
      await finishing.promise
      expect(controller.isActive()).toBeTrue()
      expect(controller.isRecording()).toBeTrue()
      finishGate.resolve()
      await importing.promise
      expect(controller.isActive()).toBeTrue()
      expect(controller.isPrepared()).toBeTrue()
      expect(controller.isRecording()).toBeTrue()
      const cleanup = controller.cancelRecording()
      expect(fixture.calls).not.toContain("recording-cancel")
      importGate.resolve()
      if (importFails) await expect(first).rejects.toThrow("Import failed; native source retained.")
      else await expect(first).resolves.toMatchObject({ capturedFrames: 128 })
      await cleanup
      expect(controller.isRecording()).toBeFalse()
      expect(controller.isActive()).toBeTrue()
      expect(controller.isPrepared()).toBeTrue()
      expect(fixture.calls.filter((call) => call === "recording-stop")).toHaveLength(1)
      expect(fixture.calls).not.toContain("stop")
      expect(fixture.calls).not.toContain("teardown")
      expect(faults).toEqual([])
      await controller.pause(0)
      expect(controller.isActive()).toBeFalse()
      expect(controller.isPrepared()).toBeTrue()
      expect(await controller.start(input().transport)).toBe("started")
      expect(controller.isActive()).toBeTrue()
    } finally {
      finishGate.resolve()
      importGate.resolve()
      await controller.dispose()
    }
  }
})

test("delayed Finish beyond two seconds cannot be cancelled by cleanup or inactive queued-zero", async () => {
  const fixture = createBridge()
  const finish = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  const originalStop = fixture.bridge.session.stopRecording
  fixture.bridge.session.stopRecording = async () => {
    stopping.resolve()
    fixture.emitRecordingStatus({ generation: 1, sessionId: 1n, active: false, configured: true, fatal: false,
      availableBlocks: 32, queuedBlocks: 0, capturedFrames: 128, droppedFrames: 0, droppedBlocks: 0,
      timelineFrame: 248, rms: 0, peak: 0, spool: { state: 1, error: 0, systemError: 0,
        writtenFrames: 128, writtenBlocks: 1, writtenBytes: 516, sampleRateHz: 48000, channelCount: 1,
        published: false, partialRetained: true } })
    await finish.promise
    return originalStop()
  }
  let imported = false
  const controller = createObservedController({ bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    importRecordingSpool: async ({ sessionId }) => {
      imported = true
      return { version: 1, sessionId, format: "planar-float32-blocks", sampleRate: 48000, channelCount: 1,
        capturedFrames: 128, byteLength: 516, createdAtMs: 1, finalizedAtMs: 2,
        nativeTake: { takeId: "retained-take", scope: { projectId: "local:test", projectGeneration: 0 },
          acknowledgment: { reason: "imported", sessionId, frames: 128, bytes: 516, blocks: 1,
            channelCount: 1, sampleRateHz: 48000, finalized: true } } }
    },
  })
  await controller.start(input().transport)
  await controller.startRecording({ appSessionId: "delayed", projectId: "local:test", projectGeneration: 0, targetTrackId: "track-1",
    layout: "mono", inputChannel: 0, gain: 1, polarity: 1, monitoring: true, punchStartFrame: 120 })
  const result = controller.stopRecording()
  await stopping.promise
  const cleanup = controller.cancelRecording()
  await Bun.sleep(2100)
  expect(imported).toBeFalse()
  expect(fixture.calls).not.toContain("recording-cancel")
  finish.resolve()
  await result
  await cleanup
  expect(imported).toBeTrue()
})

test("project switch during native Finish refuses import and never cancels the accepted finish", async () => {
  const fixture = createBridge()
  const finish = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  const originalStop = fixture.bridge.session.stopRecording
  fixture.bridge.session.stopRecording = async () => { stopping.resolve(); await finish.promise; return originalStop() }
  let project = "local:test"
  let imported = false
  const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => project,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
    importRecordingSpool: async () => { imported = true; throw new Error("must not import") },
  })
  await controller.start(input().transport)
  await controller.startRecording({ appSessionId: "switch", projectId: project, projectGeneration: 0, targetTrackId: "track-1",
    layout: "mono", inputChannel: 0, gain: 1, polarity: 1, monitoring: true, punchStartFrame: 120 })
  const result = controller.stopRecording()
  await stopping.promise
  project = "local:other"
  finish.resolve()
  await expect(result).rejects.toThrow("scope")
  expect(imported).toBeFalse()
  expect(fixture.calls).not.toContain("recording-cancel")
})

test("cleanup during verified readiness cannot resurrect a cancelled recording", async () => {
  const fixture = createBridge()
  const configured = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const configure = fixture.bridge.session.configureRecording
  fixture.bridge.session.configureRecording = async (configuration) => { configured.resolve(); await ready.promise; return configure(configuration) }
  const controller = createObservedController({ bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  await controller.start(input().transport)
  const start = controller.startRecording({ appSessionId: "cancelled-start", projectId: "local:test", projectGeneration: 0, targetTrackId: "track-1",
    layout: "mono", inputChannel: 0, gain: 1, polarity: 1, monitoring: true, punchStartFrame: 120 })
  await configured.promise
  await controller.cancelRecording()
  ready.resolve()
  void start.catch(() => undefined)
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  expect(fixture.calls).not.toContain("recording-start")
  await expect(start).rejects.toThrow("scope")
})

test("M auto-punch proof failure reports recording failure without cancelling published capture or losing VST playback", async () => {
  const fixture = createBridge(); const failures: string[] = []
  const controller = createObservedController({ bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()) })
  await controller.start(input().transport)
  await controller.startRecording({ appSessionId: "proof-fail", projectId: "local:test", projectGeneration: 0, targetTrackId: "track-1",
    layout: "mono", inputChannel: 0, gain: 1, polarity: 1, monitoring: false, punchStartFrame: 120, punchEndFrame: 248,
    onFailure: (error) => { failures.push(error.message); void controller.cancelRecording() } })
  fixture.emitRecordingFailure({ generation: 1, sessionId: 1n, message: "Complete proof failed; native source retained." })
  await Promise.resolve()
  expect(failures).toEqual(["Complete proof failed; native source retained."])
  expect(controller.isActive()).toBeTrue()
  expect(controller.isAvailable()).toBeTrue()
  expect(controller.isRecording()).toBeFalse()
  expect(fixture.calls).not.toContain("recording-cancel")
})

test("does not require a browser audio engine when the native bridge is absent", async () => {
  const controller = createObservedController({
    bridge: undefined,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })

  expect(await controller.start(input().transport)).toBe("unavailable")
})

// DV01 boundary (§6.1): a patch answer of a running host is a claim, a refusal or a loss as its typed reply says, and
// a parameter failure is a refusal or a loss as its kind says. Written red at step 0, green with the ledger and the
// controller delivery of milestone 2.
describe("DV01 boundary witnesses", () => {
  const twoUtilities = () => {
    const first = createDefaultUtilityParams()
    const snapshotInput = utilityPlaybackInput()
    return {
      first,
      snapshotInput,
      compileSnapshot: async () => compileLivePlaybackSnapshot({
        ...snapshotInput,
        renderState: {
          ...snapshotInput.renderState,
          fx: {
            ...snapshotInput.renderState.fx,
            trackFx: {
              track: {
                instances: [
                  { id: "utility:1", kind: "utility" as const, params: { version: 1 as const, state: first } },
                  { id: "utility:2", kind: "utility" as const, params: { version: 1 as const, state: first } },
                ],
              },
            },
          },
        },
      }),
    }
  }

  test("a parameter batch native reports unavailable is unavailable, not a refusal", async () => {
    const fixture = createBridge()
    const snapshotInput = utilityPlaybackInput()
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
    })
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    fixture.bridge.session.queueParameterEvents = async () => ({ ok: false, error: "audio session is unavailable", kind: "unavailable" })
    await expect(controller.deliverProcessor(fixtureParameterEdit({
      instanceId: "utility:1",
      values: [{ parameterId: "utility.pan", value: 0.25 }],
    })).settled).resolves.toEqual({ state: "unavailable" })
    await controller.dispose()
  })

  test("a patch native refuses while the host runs is not taken as claimed", async () => {
    const fixture = createBridge()
    const snapshotInput = utilityPlaybackInput()
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
    })
    await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
    fixture.bridge.session.queueProcessorStatePatch = async () => ({ ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 })
    const from = createDefaultUtilityParams()
    await expect(controller.deliverProcessor(fixturePatchEdit({
      payload: utilityCommit("utility:1", from, { ...from, gainDb: -3 }),
      bpm: 120,
    })).settled).resolves.toMatchObject({ state: "refused" })
    await controller.dispose()
  })

  test("a patch that was never delivered while the host runs is not taken as claimed", async () => {
    const fixture = createBridge()
    const snapshotInput = utilityPlaybackInput()
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
    })
    await expect(controller.start(snapshotInput.transport)).resolves.toBe("started")
    fixture.bridge.session.queueProcessorStatePatch = async () => ({ ok: false, error: "The native audio session is unavailable.", kind: "unavailable" })
    const from = createDefaultUtilityParams()
    await expect(controller.deliverProcessor(fixturePatchEdit({
      payload: utilityCommit("utility:1", from, { ...from, gainDb: -3 }),
      bpm: 120,
    })).settled).resolves.toMatchObject({ state: "unavailable" })
    await controller.dispose()
  })

  test("another target's patch stays unsent while a claimed patch is unresolved", async () => {
    const fixture = createBridge()
    const sent: Uint8Array[] = []
    fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
      sent.push(bytes)
      return { ok: true, outcome: "claimed", token: "9007199254740993" }
    }
    const { first, compileSnapshot } = twoUtilities()
    const controller = createObservedController({ bridge: fixture.bridge, compileSnapshot })
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    void controller.deliverProcessor(fixturePatchEdit({ payload: utilityCommit("utility:1", first, { ...first, gainDb: -1 }), bpm: 120 })).settled
    void controller.deliverProcessor(fixturePatchEdit({ payload: utilityCommit("utility:2", first, { ...first, pan: 0.25 }), bpm: 120 })).settled
    await Bun.sleep(0)
    await Bun.sleep(0)
    // Native holds at most one claim: until it reports token 9007199254740993 the second target must not be sent.
    expect(sent).toHaveLength(1)
    await controller.dispose()
  })
})

// DV01 boundary (§6.1): every controller witness the design lists beyond the four above. They drive the real
// controller through the bridge fixture and assert sends, notices, prepares and what the old entries answer.
describe("DV01 boundary witnesses, section 6.1 controller", () => {
  const turns = async () => { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve() }
  type Watched<T> = { value?: T }
  const watch = <T>(promise: Promise<T>) => {
    const box: Watched<T> = {}
    void promise.then((value) => { box.value = value })
    return box
  }
  const withGain = (gainDb: number) => ({ ...createDefaultUtilityParams(), gainDb })
  const patchFor = (instanceId: string, gainDb: number) => ({
    payload: utilityCommit(instanceId, createDefaultUtilityParams(), withGain(gainDb)),
    bpm: 120,
  })
  const prepares = (fixture: ReturnType<typeof createBridge>) => fixture.calls.filter((call) => call === "revision-prepare").length
  const twoUtilities = () => {
    const first = createDefaultUtilityParams()
    const snapshotInput = utilityPlaybackInput()
    return {
      compileSnapshot: async () => compileLivePlaybackSnapshot({
        ...snapshotInput,
        renderState: { ...snapshotInput.renderState, fx: { ...snapshotInput.renderState.fx, trackFx: { track: { instances: [
          { id: "utility:1", kind: "utility" as const, params: { version: 1 as const, state: first } },
          { id: "utility:2", kind: "utility" as const, params: { version: 1 as const, state: first } },
        ] } } } },
      }),
    }
  }
  const utilityEdit = (order: number, gainDb: number) => ({
    id: `edit-${order}`, order, target: { nodeId: "track", instanceId: "utility:1", kindId: 1, incarnation: 1 },
    // The allocator captures the encoded state and timing beside the params: they are what lets the ladder patch it.
    content: {
      params: withGain(gainDb), state: encodeUtilityProcessorState(withGain(gainDb)), values: { "utility.gainDb": gainDb },
      timing: nativeBuiltInPatchTiming(patchFor("utility:1", gainDb).payload),
    },
  })
  const gainRequest = (order: number, gainDb: number) => ({
    instanceId: "utility:1", values: [{ parameterId: "utility.gainDb", value: gainDb }], edit: utilityEdit(order, gainDb),
  })
  // Native answers every state patch with a definite refusal; the payloads are recorded as the fixture would.
  const refusePatches = (fixture: ReturnType<typeof createBridge>) => {
    fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
      fixture.statePatchPayloads.push(bytes)
      return { ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 }
    }
  }
  const quietController = (fixture: ReturnType<typeof createBridge>, faults: unknown[][] = []) => createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async () => compileLivePlaybackSnapshot(utilityPlaybackInput()),
    reportFault: (...args: unknown[]) => { faults.push(args) },
  })
  // Configure the requested bytes, then put a different proven live override over them.
  // This makes the measured request a parameter carrier, while its ladder still carries truthful whole state.
  const primeParameterCarrier = async (fixture: ReturnType<typeof createBridge>, controller: ReturnType<typeof quietController>) => {
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -3))).settled;
    await controller.deliverProcessor(fixtureParameterEdit({
      instanceId: "utility:1", edit: processorEdit(1), values: [{ parameterId: "utility.gainDb", value: 0 }],
    })).settled;
    fixture.builtInParameterPayloads.length = 0;
    fixture.statePatchPayloads.length = 0;
  };

  // Real persisted adapter, owner, registry and controller. Only the native bridge and persistence are controlled here.
  // Decode the wire at the bridge, independently of the registration's requested content.
  const mountedPanel = async (
    save: (value: number, context?: { projectId?: string; userId?: string; projectGeneration?: number }) => Promise<ParameterSaveResult> = async () => ({ kind: "committed", through: 5 }),
    projected = false,
    structuralValues: ReadonlySet<number> = new Set(),
    paramsFor?: (value: number) => ReturnType<typeof createDefaultUtilityParams>,
    persistContext?: { projectId: string; userId: string },
  ) => {
    const fixture = createBridge()
    const registry = createProcessorEditRegistry(() => 120)
    const faults: unknown[][] = []
    const base = utilityPlaybackInput()
    registry.observe(base.renderState.fx)
    const [row, setRow] = createSignal(0)
    const [through, setThrough] = createSignal(1)
    let heard = 0
    let heardSwap = false
    const heardParameters = new Map<number, number>([[1, 0], [2, 0]])
    const overrides = new Set<number>()
    let installedState = encodeUtilityProcessorState(createDefaultUtilityParams())
    const installState = (state: Uint8Array, reset: boolean) => {
      if (reset) overrides.clear()
      const view = new DataView(state.buffer, state.byteOffset, state.byteLength)
      for (const [target, offset] of [[1, 4], [2, 16], [3, 20], [4, 24]]) {
        if (target !== undefined && offset !== undefined && !overrides.has(target)) heardParameters.set(target, view.getFloat32(offset, true))
      }
      heard = heardParameters.get(1) ?? 0
      heardSwap = view.getUint32(32, true) !== 0
      installedState = state.slice()
    }
    let mode: "applied" | "refused" | "unconfirmed" | "claimed" = "applied"
    let patchGate: Promise<NativeProcessorPatchReply> | undefined
    let claimedState: { token: string; state: Uint8Array } | undefined
    const patches: number[] = []
    const patchSwaps: boolean[] = []
    const events: string[] = []
    const deliveries: { value: number; edit: LiveProcessorEditIdentity; gesture: ProcessorDelivery["gesture"]; answer?: ProcessorDeliveryOutcome }[] = []
    const histories: string[] = []
    const prepare = fixture.bridge.session.revisions.prepare
    let publicationFrame = 0n
    let publicationState: Uint8Array | undefined
    fixture.bridge.session.revisions.prepare = async request => {
      publicationFrame = request.requestedPublicationFrame ?? 0n
      // Independently decode the fake host's actual graph wire, not the desired callback.
      const view = new DataView(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength)
      const version = view.getUint32(12, true)
      expect([3, 4, 5]).toContain(version)
      const nodeBytes = version === 5 ? 140 : version === 4 ? 136 : 132
      let offset = 36 + view.getUint32(20, true) * nodeBytes + view.getUint32(24, true) * 48
      for (let index = 0; index < view.getUint32(28, true); index++) {
        const size = view.getUint32(offset + 16, true)
        if (view.getUint32(offset + 8, true) === 1) publicationState = request.bytes.slice(offset + 48, offset + 48 + size)
        offset += 48 + size + view.getUint32(offset + 36, true) * 4
      }
      return prepare(request)
    }
    fixture.bridge.session.revisions.publish = async () => {
      const proof = fixture.revisionReply("published")
      if (!proof.ok) throw new Error("Missing panel publication proof")
      if (publicationState) {
        const previous = new DataView(installedState.buffer, installedState.byteOffset, installedState.byteLength)
        const next = new DataView(publicationState.buffer, publicationState.byteOffset, publicationState.byteLength)
        const reset = [0, 8, 12, 28, 32, 36].some(offset => previous.getUint32(offset, true) !== next.getUint32(offset, true))
        installState(publicationState, reset)
      }
      return { ...proof, revision: { ...proof.revision, preparedRevision: 0, publicationFrame,
        transportEpoch: fixture.transportContexts.at(-1)?.epoch } }
    }
    fixture.bridge.session.revisions.inspect = fixture.bridge.session.revisions.publish
    const paramsOf = (value: number): ReturnType<typeof createDefaultUtilityParams> => paramsFor ? paramsFor(value)
      : projected && !structuralValues.has(value) ? withGain(value) : { ...createDefaultUtilityParams(),
        gainDb: value, polarity: value === -1 ? "invert" : "normal",
        inputMode: value === -2 ? "mono-sum" : "stereo", dcBlock: value === -3, swap: value === -4 || value === 9 }
    let desiredParams = createDefaultUtilityParams()
    const effectiveInput = () => ({ ...base, renderState: { ...base.renderState, fx: { ...base.renderState.fx,
      trackFx: { ...base.renderState.fx.trackFx, track: { ...base.renderState.fx.trackFx?.track,
        instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: desiredParams } } satisfies AudioEffectRuntimeInstance] } },
    } } })
    const controller = createObservedController({
      bridge: fixture.bridge,
      getProjectId: () => "local_project",
      getProcessorTarget: registry.target,
      ...(projected && { getDesiredProcessorState: (_snapshot: Parameters<typeof compileDesiredNativeProcessorState>[0], rate: number) => {
        const current = compileLivePlaybackSnapshot(effectiveInput())
        if (!current.supported) throw new Error("Panel desired snapshot unsupported")
        return compileDesiredNativeProcessorState(current.snapshot, rate, registry.sequence())
      } }),
      compileSnapshot: async transport => compileLivePlaybackSnapshot({ ...effectiveInput(), transport }),
      reportFault: (...args: unknown[]) => { faults.push(args) },
    })
    fixture.bridge.session.queueProcessorStatePatch = async bytes => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      expect(view.getUint32(20, true)).toBe(1)
      expect(view.getUint32(28, true)).toBe(40)
      const value = view.getFloat32(60, true)
      patches.push(value)
      const swap = view.getUint32(88, true) !== 0
      patchSwaps.push(swap)
      const reply: NativeProcessorPatchReply = patchGate ? await patchGate : mode === "applied" ? { ok: true, outcome: "applied" }
        : mode === "claimed" ? { ok: true, outcome: "claimed", token: "77" }
          : mode === "unconfirmed" ? { ok: false, kind: "unconfirmed", error: "Reply lost" }
            : { ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 }
      if (reply.ok && reply.outcome === "applied") installState(bytes.slice(56, 96), true)
      else if (reply.ok && reply.outcome === "claimed") claimedState = { token: reply.token, state: bytes.slice(56, 96) }
      return reply
    }
    const resolvePatch = fixture.emitPatchResolution
    fixture.emitPatchResolution = (token, result = 0) => {
      if (claimedState?.token === token) {
        if (result === 0) installState(claimedState.state, true)
        claimedState = undefined
      }
      resolvePatch(token, result)
    }
    await expect(controller.start(base.transport)).resolves.toBe("started")
    const queueParameters = fixture.bridge.session.queueParameterEvents
    fixture.bridge.session.queueParameterEvents = async bytes => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      // This bridge applies the parameter payload before emitting the matching progress proof.
      for (let index = 0; index < view.getUint32(0, true); index++) {
        const offset = 20 + index * 20
        const target = view.getUint32(offset + 8, true), value = view.getFloat32(offset + 16, true)
        heardParameters.set(target, value)
        overrides.add(target)
        if (target === 1) heard = value
      }
      return queueParameters(bytes)
    }
    let dispose = () => {}
    let applyGate: Promise<"skipped"> | undefined
    const panel = createRoot(end => {
      dispose = end
      return createPersistedEffectState<number, number>({
        targetId: () => "track", row, readQueryParams: value => value, readQueryThrough: through,
        createInitialParams: () => 0, serializeParams: String, applyToEngine: () => applyGate ?? "skipped",
        allocateEdit: (_target, _from, value) => {
          // Patch-policy fixtures change a real non-live field with each scalar state. The mapped-only
          // fixture keeps the default structure and must use the parameter carrier instead.
          const params = paramsOf(value)
          desiredParams = params
          return registry.allocate(utilityCommit("utility:1", params, params))
        },
        registerDelivery: (_target, value, edit, gesture) => {
          if (!edit) throw new Error("Missing panel edit")
          const delivery: typeof deliveries[number] = { value, edit, gesture }
          deliveries.push(delivery); events.push(`register:${value}`)
          const registration = controller.deliverProcessor(edit, gesture)
          void registration.settled.then(answer => { delivery.answer = answer })
          return registration
        },
        persistParams: async (_target, value, context) => { events.push(`save:${value}`); return save(value, context) },
        createPersistContext: () => persistContext ?? {},
        history: (_target, from, to) => { histories.push(`${from}->${to}`) },
      })
    })
    await panel.flushPending()
    deliveries.length = 0; patches.length = 0; events.length = 0
    const observe = (value: number, stamp: number) => {
      // Carry row content and provenance in one owner observation.
      panel.syncRemoteForTarget("track", value, stamp)
      setThrough(stamp); setRow(value)
    }
    const tick = async (holder: ParameterGestureHolder, value: number) => {
      panel.gestureOwner.tick(holder, () => panel.update(() => value))
      await turns()
    }
    return { fixture, controller, panel, registry, faults, patches, deliveries, histories, events, tick, observe,
      desire: (value: number) => {
        desiredParams = paramsOf(value)
        return registry.allocate(utilityCommit("utility:1", desiredParams, desiredParams))
      },
      heard: () => heard, heardSwap: () => heardSwap, patchSwaps, heardParameters, mode: (next: typeof mode) => { mode = next },
      gate: (next?: Promise<NativeProcessorPatchReply>) => { patchGate = next },
      gateApply: (next?: Promise<"skipped">) => { applyGate = next },
      dispose: async () => { dispose(); await controller.dispose() },
    }
  }
  test("STEP5 NC B13 foreign B crosses captured A and equals old baseline", async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...withGain(value), swap: value === 9 }));
    const held = Promise.withResolvers<void>();
    try {
      f.panel.setForTarget("track", 9);
      await f.panel.flushPending(); await turns();
      f.observe(9, 5);
      await f.panel.flushPending(); await turns();
      const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-21")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
      const prepare = f.fixture.bridge.session.revisions.prepare;
      let entered = false;
      f.fixture.bridge.session.revisions.prepare = async request => {
        const reply = await prepare(request);
        entered = true;
        await held.promise;
        return reply;
      };
      const publication = (candidateCompile.release(), candidateAdoption);
      await turns();
      expect(entered).toBeTrue();
      f.observe(0, 20);
      await f.panel.flushPending(); await turns();
      held.resolve();
      expect(await publication).toMatchObject({ status: "adopted" });
      await turns();
      console.log("STEP5 NC B13", JSON.stringify({ heard: f.heard(), swap: f.heardSwap(),
        patches: f.patches, outcomes: f.deliveries.map(row => row.answer) }));
      expect(f.heard()).toBe(0);
      expect(f.heardSwap()).toBeFalse();
      expect(f.panel.params()).toBe(0);
      expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" });
    } finally { held.resolve(); await f.dispose(); }
  });

  for (const scenario of ["B9-untouched", "B10-unsent-id", "B11-after-publication", "B12-before-adoption", "B14-patch-revert"]) {
    test(`STEP5 NC ${scenario} real foreign row delivery`, async () => {
      const params = (value: number) => scenario === "B10-unsent-id"
        ? { ...withGain(-3), pan: value === -6 ? 0.4 : 0 }
        : scenario === "B14-patch-revert" ? { ...withGain(value), swap: value === 9 } : withGain(value);
      const f = await mountedPanel(undefined, true, new Set(), params);
      try {
        if (scenario === "B10-unsent-id") {
          f.panel.setForTarget("track", -3);
          await f.panel.flushPending(); await turns();
        } else if (scenario === "B11-after-publication") {
          f.desire(-3);
          expect(await f.controller.adoptSchedule(migrationIntent("public-migration-9"), true)).toMatchObject({ status: "adopted" });
          await turns();
        } else if (scenario === "B14-patch-revert") {
          f.panel.setForTarget("track", 9);
          await f.panel.flushPending(); await turns();
          expect(f.patches).toEqual([9]);
          f.observe(9, 5);
          await f.panel.flushPending(); await turns();
        }
        const before = f.fixture.builtInParameterPayloads.length;
        const patches = f.patches.length;
        const value = scenario === "B14-patch-revert" ? 0 : -6;
        f.observe(value, 20);
        await f.panel.flushPending(); await turns();
        console.log("STEP5 NC", JSON.stringify({ scenario, parameterBatches: f.fixture.builtInParameterPayloads.length - before,
          patches: f.patches.length - patches, heard: f.heard(), pan: f.heardParameters.get(2),
          outcome: f.deliveries.at(-1)?.answer }));
        expect(f.panel.params()).toBe(value);
        expect(f.heard()).toBe(scenario === "B10-unsent-id" ? -3 : value);
        expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" });
        if (scenario === "B10-unsent-id") expect(f.heardParameters.get(2)).toBeCloseTo(0.4);
        if (scenario === "B14-patch-revert") {
          expect(f.patches.length - patches).toBe(1);
          expect(f.heardSwap()).toBeFalse();
        } else {
          expect(f.fixture.builtInParameterPayloads.length - before).toBe(1);
          expect(f.patches.length - patches).toBe(0);
        }
      } finally { await f.dispose(); }
    });
  }

  const promoted = <Evidence,>(name: string, evidence: Evidence) => {
    if (process.env.DV01_3B1_REPORT === "1") console.log(`DV01-3B1 ${JSON.stringify({
      name, location: "src/lib/desktop/native-playback-controller.test.ts", evidence,
      status: "green", failure: null, expectedFailure: null, standIn: null, flip: "Actual panel registration and native bridge proof",
    })}`)
  }

  for (const harmful of [true, false]) test(`3B1 panel close below a different key's publication floor, harmful=${harmful}`, async () => {
    const f = await mountedPanel(undefined, true)
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -1)
    if (!harmful) await f.tick(holder, 0)
    const before = f.fixture.builtInParameterPayloads.length
    const held = Promise.withResolvers<"skipped">()
    f.gateApply(held.promise)
    f.panel.gestureOwner.cancel(holder)
    await turns()
    const closeOrder = f.registry.target("track", "utility:1")?.latest?.order
    const other = f.registry.allocate(utilityCommit("utility:other", withGain(0), withGain(0)))
    if (closeOrder === undefined || !other) throw new Error("Missing below-floor identities")
    expect(closeOrder).toBeLessThan(other.order)
    expect(await f.controller.adoptSchedule(migrationIntent("public-migration-10"), true)).toMatchObject({ status: "adopted" })
    expect(f.heard()).toBe(harmful ? -1 : 0)
    f.gateApply()
    held.resolve("skipped")
    const drain = await f.panel.flushPending()
    await turns()
    expect(f.heard()).toBe(0)
    expect(f.fixture.builtInParameterPayloads.length - before).toBe(harmful ? 1 : 0)
    expect(f.patches).toEqual([])
    expect(f.deliveries.at(-1)?.edit.order).toBe(closeOrder)
    expect(f.deliveries.at(-1)?.gesture?.holds).toBeFalse()
    expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" })
    expect(drain.unanswered).toEqual([])
    expect(f.histories).toEqual([])
    const afterClose = f.fixture.builtInParameterPayloads.length
    f.desire(-5)
    expect(await f.controller.adoptSchedule(migrationIntent("public-migration-11"), true)).toMatchObject({ status: "adopted" })
    expect(f.heard()).toBe(-5)
    expect(f.fixture.builtInParameterPayloads.length - afterClose).toBe(1)
    promoted(`Below-floor panel close ${harmful ? "harmful" : "benign"}`, { closeOrder, publicationFloor: other.order, otherKey: other.target.instanceId,
      additionalCloseBatches: harmful ? 1 : 0, closedToken: f.deliveries.at(-1)?.gesture, finalReconcile: f.heard() })
    await f.dispose()
  })

  test("3B1 panel drain retains queued release, actual admission and unanswered receipt independently", async () => {
    const projectId = `3b1-panel-retention-${crypto.randomUUID()}`, userId = "user"
    const originalFetch = globalThis.fetch
    let online = false
    globalThis.fetch = Object.assign(async () => online
      ? Response.json({ status: "applied", effectId: "row", revision: 5 })
      : new Response("offline", { status: 503 }), { preconnect: originalFetch.preconnect })
    let entryId: string | undefined
    const f = await mountedPanel(async value => {
      const result = await publishDurableEffectsOperation({ projectId, userId,
        operation: { kind: "effects.setUtilityParams", payload: {
          trackId: "track", instanceId: "utility:1", params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: value } },
        } } })
      if (result.kind !== "admitted") throw new Error(`Expected actual durable admission: ${JSON.stringify(result)}`)
      entryId = result.entryId
      return result
    }, false, new Set(), undefined, { projectId, userId })
    try {
      const portable = Promise.withResolvers<"skipped">()
      f.gateApply(portable.promise)
      f.mode("claimed")
      f.panel.setForTarget("track", -3)
      let drained = false
      const queued = f.panel.flushPending().then(result => { drained = true; return result })
      await turns()
      expect(drained).toBeFalse()
      expect(f.events).toEqual([])
      expect(f.panel.params()).toBe(-3)
      f.gateApply()
      portable.resolve("skipped")
      const admitted = await queued
      expect(admitted.admitted).toHaveLength(1)
      expect(admitted.unanswered).toHaveLength(1)
      expect(f.deliveries[0]?.answer).toBeUndefined()
      expect(f.histories).toEqual([])
      if (!entryId) throw new Error("Missing retained admission")
      expect(await readSharedOutboxOperation(projectId, userId, entryId)).toMatchObject({ status: "pending" })
      online = true
      await flushSharedOutbox(projectId, userId, { retryFailed: true })
      await f.panel.flushPending()
      f.observe(-3, 5)
      const onlyReceipt = await f.panel.flushPending()
      expect(onlyReceipt.admitted).toEqual([])
      // The committed echo is already installed by the release; it creates no second receipt.
      expect(onlyReceipt.unanswered).toHaveLength(1)
      expect(f.deliveries.map(delivery => delivery.value)).toEqual([-3])
      expect(f.patches).toEqual([-3])
      expect(f.panel.readProvisionalForTarget("track")).toBeUndefined()
      expect(f.histories).toEqual(["0->-3"])
      expect(await readSharedOutboxOperation(projectId, userId, entryId)).toEqual({ status: "missing" })
      f.fixture.emitPatchResolution("77", 0)
      await turns()
      expect(await f.panel.flushPending()).toEqual({ admitted: [], unanswered: [] })
      expect(f.heard()).toBe(-3)
      expect(f.deliveries[0]?.answer).toEqual({ state: "applied" })
      await flushSharedOutbox(projectId, userId, { retryFailed: true })
      expect(f.histories).toEqual(["0->-3"])
      promoted("R3-6 unanswered-receipt retention/drain", { queuedBeforeApply: true, admittedAndUnanswered: [admitted.admitted.length, admitted.unanswered.length],
        pendingAfterCommit: onlyReceipt.unanswered.length, consumed: "missing", finalDrain: await f.panel.flushPending(), finalGain: f.heard(), histories: f.histories })
    } finally { globalThis.fetch = originalFetch; await f.dispose() }
  })

  test("3B1 admitted panel completions stay bound across project switch and remove-readd, and consume once", async () => {
    const a = `3b1-admitted-a-${crypto.randomUUID()}`, b = `3b1-admitted-b-${crypto.randomUUID()}`
    const [projectId, setProjectId] = createSignal(a)
    const originalFetch = globalThis.fetch
    const allowed = new Set<number>()
    globalThis.fetch = Object.assign(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const operation = z.object({ payload: z.object({ params: z.object({ state: z.object({ gainDb: z.number() }) }) }) })
        .parse(JSON.parse(String(init?.body)))
      const value = operation.payload.params.state.gainDb
      return allowed.has(value) ? Response.json({ status: "applied", effectId: "row", revision: 5 })
        : new Response("offline", { status: 503 })
    }, { preconnect: originalFetch.preconnect })
    const writes: { value: number; projectId: string; userId: string; entryId: string }[] = []
    const f = await mountedPanel(async (value, context) => {
      if (!context?.projectId || !context.userId) throw new Error("Missing captured admission scope")
      const result = await publishDurableEffectsOperation({ projectId: context.projectId, userId: context.userId,
        operation: { kind: "effects.setUtilityParams", payload: {
          trackId: "track", instanceId: "utility:1", params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: value } },
        } } })
      if (result.kind !== "admitted") throw new Error("Expected durable admission")
      writes.push({ value, projectId: context.projectId, userId: context.userId, entryId: result.entryId })
      return result
    }, true, new Set(), undefined, { get projectId() { return projectId() }, get userId() { return projectId() === a ? "user-a" : "user-b" } })
    const originalDelete = IDBObjectStore.prototype.delete
    const consumed: string[] = []
    IDBObjectStore.prototype.delete = function(key) {
      if (this.name === "syncState") for (const write of writes) {
        if (key === `shared-outbox-completion:${write.projectId}:${write.userId}:${write.entryId}`) consumed.push(write.entryId)
      }
      return originalDelete.call(this, key)
    }
    try {
      f.panel.setForTarget("track", -1)
      expect((await f.panel.flushPending()).admitted).toHaveLength(1)
      setProjectId(b)
      await turns()
      f.observe(0, 1)
      await f.panel.flushPending()
      f.panel.setForTarget("track", -2)
      expect((await f.panel.flushPending()).admitted).toHaveLength(1)
      const [oldProject, oldLife] = writes
      if (!oldProject || !oldLife) throw new Error("Missing ended admission bindings")
      expect([oldProject.projectId, oldProject.userId, oldLife.projectId, oldLife.userId]).toEqual([a, "user-a", b, "user-b"])
      f.panel.syncRemoteForTarget("track", undefined)
      await f.panel.flushPending()
      f.observe(0, 2)
      await f.panel.flushPending()
      f.panel.setForTarget("track", -3)
      const retained = await f.panel.flushPending()
      const current = writes[2]
      if (!current) throw new Error("Missing new-lifetime admission")
      expect(retained.admitted).toEqual([{ target: "track", entryId: current.entryId }])
      allowed.add(-1); allowed.add(-2)
      await flushSharedOutbox(a, "user-a", { retryFailed: true })
      await flushSharedOutbox(b, "user-b", { retryFailed: true })
      await f.panel.flushPending()
      expect(f.panel.params()).toBe(-3)
      expect(f.heard()).toBe(-3)
      expect(f.histories).toEqual([])
      expect(consumed).toEqual([])
      expect(await readSharedOutboxOperation(a, "user-a", oldProject.entryId)).toMatchObject({ status: "applied" })
      expect(await readSharedOutboxOperation(b, "user-b", oldLife.entryId)).toMatchObject({ status: "applied" })
      expect(await readSharedOutboxOperation(b, "user-b", current.entryId)).toMatchObject({ status: "pending" })
      allowed.add(-3)
      await flushSharedOutbox(b, "user-b", { retryFailed: true })
      await f.panel.flushPending()
      f.observe(-3, 5)
      await f.panel.flushPending()
      await flushSharedOutbox(b, "user-b", { retryFailed: true })
      await flushSharedOutbox(b, "user-b", { retryFailed: true })
      expect(consumed).toEqual([current.entryId])
      expect(f.histories).toEqual(["0->-3"])
      expect(f.panel.readProvisionalForTarget("track")).toBeUndefined()
      expect(await f.panel.flushPending()).toEqual({ unanswered: [], admitted: [] })
      promoted("P admitted old-project/remove-readd binding and exact consume-once", { writes: writes.map(write => ({ value: write.value, scope: write.projectId === a ? "A" : "B", user: write.userId })),
        endedCompletionsConsumed: 0, currentCompletionsConsumed: consumed.length, finalHistory: f.histories, finalGain: f.heard() })
    } finally { IDBObjectStore.prototype.delete = originalDelete; globalThis.fetch = originalFetch; await f.dispose() }
  })

  test("3B1 real audio adapter carries each key revision and consumes a positive equal stamp", async () => {
    const projectId = `cloud-per-key-${crypto.randomUUID()}`
    const db = convexTest(schema, { "./_generated/api.ts": () => import("../../../convex/_generated/api") })
    const params = (gainDb: number) => ({ version: 1, state: { ...createDefaultUtilityParams(), gainDb } } satisfies ReturnType<typeof AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams>)
    const initialRows = await db.run(async ctx => {
      for (const [index, instanceId] of ["utility:a", "utility:b"].entries()) await ctx.db.insert("effects", {
        projectId, targetType: "master", type: "utility", instanceId, index, params: params(0), createdAt: 1, revision: index ? 100 : 1,
      })
      return await ctx.db.query("effects").collect()
    })
    const [rows, setRows] = createSignal(initialRows)
    const fixture = createBridge()
    const registry = createProcessorEditRegistry(() => 120)
    const base = utilityPlaybackInput()
    const controller = createObservedController({ bridge: fixture.bridge,
      getProcessorTarget: registry.target,
      compileSnapshot: async () => compileLivePlaybackSnapshot({ ...base, renderState: { ...base.renderState,
        fx: { ...base.renderState.fx, masterFxInstances: ["utility:a", "utility:b"].map(id => ({ id, kind: "utility", params: params(0) })) } } }),
    })
    expect(await controller.start(base.transport)).toBe("started")
    const originalFetch = globalThis.fetch
    globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = z.object({ payload: z.object({ instanceId: z.string() }) }).parse(JSON.parse(String(init?.body)))
      return Response.json({ status: "applied", effectId: "row", revision: request.payload.instanceId === "utility:a" ? 6 : 101 })
    }, { preconnect: originalFetch.preconnect })
    const deliveries: ProcessorDeliveryOutcome[] = []
    const history: string[] = []
    let dispose = () => {}
    const device = createRoot(end => {
      dispose = end
      return createEffectsPanelAudioDevice({ audioEngine: () => new AudioEngine(), projectId: () => projectId, userId: () => "user",
        roomEffects: rows, canWriteCurrentTargetEffects: () => true, usesLegacyAudioEngine: () => false,
        allocateProcessorEdit: registry.allocate,
        deliverProcessor: (edit, gesture) => {
          const result = controller.deliverProcessor(edit, gesture)
          void result.settled.then(answer => deliveries.push(answer))
          return result
        },
        onEffectParamsCommitted: payload => { history.push(payload.instanceId ?? "") },
      }, () => "master", () => undefined)
    })
    const read = (id: string) => {
      const row = device.snapshotExportRows(["master"]).find(row => row.instanceId === id)
      return z.object({ state: z.object({ gainDb: z.number() }) }).parse(row?.params).state.gainDb
    }
    const publish = (gain: number, revision: number) => setRows(rows => rows.map(row =>
      row.instanceId === "utility:a" ? { ...row, params: params(gain), revision } : row))
    try {
      await device.flushPending()
      device.utility.changeInstance("utility:a", () => params(1))
      device.utility.changeInstance("utility:b", () => params(2))
      await device.flushPending()
      publish(7, 5); await device.flushPending()
      expect([read("utility:a"), read("utility:b")]).toEqual([1, 2])
      publish(7, 6); await device.flushPending()
      // The observed row is still 7, but its positive stamp now covers our write.
      expect(read("utility:a")).toBe(7)
      publish(1, 5); await device.flushPending()
      expect(read("utility:a")).toBe(7)
      const beforeEqual = deliveries.length
      publish(7, 7); await device.flushPending()
      expect(deliveries.length).toBe(beforeEqual)
      expect([read("utility:a"), read("utility:b")]).toEqual([7, 2])
      setRows(rows => rows.map(row => row.instanceId === "utility:b" ? { ...row, params: params(2), revision: 101 } : row))
      await device.flushPending()
      setRows(rows => rows.map(row => row.instanceId === "utility:b" ? { ...row, params: params(8), revision: 102 } : row))
      await device.flushPending()
      expect([read("utility:a"), read("utility:b")]).toEqual([7, 8])
      expect(history.sort()).toEqual(["utility:a", "utility:b"])
      expect(deliveries.every(answer => answer.state === "applied")).toBeTrue()
      promoted("P per-key revision propagation and positive equal stamps", { initialRevisions: [1, 100], commits: [6, 101],
        staleA: "7@5 retained own 1", equalA: "7@6 consumes own 1; equal 7@7 adds no dispatch", finalValues: [read("utility:a"), read("utility:b")], history })
    } finally { globalThis.fetch = originalFetch; dispose(); await controller.dispose() }
  })

  test("3B1 local returned writes reach both normalized consumers through one held view", async () => {
    const projectId = `project:3b1-returned-${crypto.randomUUID()}`
    const initial = { kind: "sampler", instanceId: "sampled:local", params: { ...createDefaultSamplerParams(), polyphony: 16 } } satisfies TrackInstrumentParams
    const utility = (gainDb: number) => ({ version: 1, state: { ...createDefaultUtilityParams(), gainDb } } satisfies ReturnType<typeof AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams>)
    await setLocalEffect(projectId, "instrument", "instrument", initial)
    await setLocalEffectInstance(projectId, "instrument", "utility", utility(0), { instanceId: "utility:local" })
    const [view, setView] = createSignal<LocalEffectsView>()
    let held = false
    const pending: Array<() => void> = []
    const reads: number[] = []
    const owner = createLocalEffectsViewOwner({ currentProjectId: () => projectId,
      list: async id => {
        const captured = await listLocalEffects(id)
        if (held) await new Promise<void>(resolve => pending.push(resolve))
        return captured
      },
      publish: next => { if (next) reads.push(next.through); setView(next) },
      fail: error => { if (error) throw error },
    })
    owner.sync()
    await owner.reload()
    const currentView = () => untrack(view)
    const oldThrough = currentView()?.through ?? 0
    const source = { view, reload: owner.reload, watchReloads: owner.watchReloads }
    const engine = new AudioEngine(), sampler = createSamplerBufferSync(), drum = createDrumRackBufferSync()
    const track = { id: "instrument", name: "Sampler", kind: "instrument", volume: 1, clips: [] } satisfies RuntimeTrack
    const controller = createObservedController({ bridge: undefined, compileSnapshot: async () => ({ supported: false, reasons: ["No host in local row witness"] }) })
    const registry = createProcessorEditRegistry(() => 120)
    const received: number[] = []
    const answers: ProcessorDeliveryOutcome[] = []
    let dispose = () => {}
    const f = createRoot(end => {
      dispose = end
      const instrument = createEffectsPanelInstrumentDevice({ audioEngine: () => engine, projectId: () => projectId,
        userId: () => undefined, playheadSec: () => 0, localEffectsView: source, usesLegacyAudioEngine: () => false,
        samplerBufferSync: sampler, drumRackBufferSync: drum, allocateProcessorEdit: registry.allocate,
        joinPublication: join => {
          const registration = controller.joinPublication(join)
          void registration.settled.then(answer => answers.push(answer))
          return registration
        },
      }, () => track.id, () => track, () => track)
      const audio = createEffectsPanelAudioDevice({ audioEngine: () => engine, projectId: () => projectId,
        userId: () => undefined, roomEffects: () => undefined, localEffectsView: source, usesLegacyAudioEngine: () => false,
        canWriteCurrentTargetEffects: () => true, allocateProcessorEdit: registry.allocate, deliverProcessor: controller.deliverProcessor,
      }, () => track.id, () => track)
      const sync = useEffectsPanelAudioSync({ audioEngine: () => engine, projectId: () => projectId,
        isOpen: () => true, currentTargetId: () => track.id, tracks: () => [track], sidechainRoutes: () => [],
        roomEffects: () => undefined, roomEffectsStatus: () => "pending", roomEffectsError: () => undefined,
        usesLegacyAudioEngine: () => false, localEffectsView: source, samplerBufferSync: sampler, drumRackBufferSync: drum,
        syncInstrumentForTarget: (target, params, through) => { received.push(through ?? 0); instrument.syncRemoteInstrumentForTarget(target, params, through) },
        syncArpeggiatorForTarget: instrument.arp.syncRemoteForTarget,
      })
      return { instrument, audio, sync }
    })
    const gain = () => z.object({ state: z.object({ gainDb: z.number() }) }).parse(f.audio.snapshotExportRows(["instrument"])[0]?.params).state.gainDb
    const polyphony = () => { const next = f.instrument.readInstrumentForTarget(track.id); return next?.kind === "sampler" ? next.params.polyphony : undefined }
    try {
      await f.audio.flushPending(); await f.instrument.flushPending()
      // Start an actual stale read before the writes; later notifications use the same owner.
      held = true
      const stale = owner.reload()
      await turns()
      f.audio.utility.changeInstance("utility:local", () => utility(-2))
      f.instrument.setInstrumentForTarget(track.id, { ...initial, params: { ...initial.params, polyphony: 24 } })
      await f.audio.flushPending(); await f.instrument.flushPending(); await turns()
      expect([gain(), polyphony()]).toEqual([-2, 24])
      pending.shift()?.()
      await stale
      await f.audio.flushPending(); await f.instrument.flushPending()
      expect([gain(), polyphony()]).toEqual([-2, 24])
      // Real returned rows are already in IndexedDB while the shared publication is held.
      const stored = await listLocalEffects(projectId)
      expect(stored.find(row => row.instanceId === "utility:local")?.params).toEqual(utility(-2))
      expect(stored.find(row => row.effect === "instrument")?.params).toEqual({ ...initial, params: { ...initial.params, polyphony: 24 } })
      held = false
      for (const release of pending.splice(0)) release()
      await source.reload(); await f.sync.flushPending(); await f.audio.flushPending(); await f.instrument.flushPending()
      expect(currentView()?.through).toBeGreaterThan(oldThrough)
      expect(received.at(-1)).toBe(currentView()?.through)
      await setLocalEffectInstance(projectId, track.id, "utility", utility(7), { instanceId: "utility:local" })
      await setLocalEffect(projectId, track.id, "instrument", { ...initial, params: { ...initial.params, polyphony: 8 } })
      await source.reload(); await f.sync.flushPending(); await f.audio.flushPending(); await f.instrument.flushPending()
      expect([gain(), polyphony()]).toEqual([7, 8])
      expect(answers.every(answer => answer.state === "unavailable")).toBeTrue()
      promoted("local-save-returns-row both normalized consumers", { oneView: true, oldThrough, through: currentView()?.through,
        normalizedThrough: received.at(-1), heldDrafts: [-2, 24], finalValues: [gain(), polyphony()], publicationSequences: reads })
    } finally { for (const release of pending) release(); dispose(); owner.dispose(); sampler.dispose(); drum.dispose(); await controller.dispose() }
  })

  test("3B1 whole registry content gets four mapped dispatches and a no-dispatch terminal close", async () => {
    const f = await mountedPanel(undefined, true)
    const heldCompile = holdCompile(f.controller)
    const heldAdoption = f.controller.adoptSchedule(migrationIntent("gesture-held-four"), true)
    await heldCompile.entered
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    for (const value of [-1, -2, -3, 0]) await f.tick(holder, value)
    expect(f.fixture.builtInParameterPayloads).toHaveLength(4)
    expect(f.patches).toEqual([])
    expect(f.heard()).toBe(0)
    expect(f.deliveries.every(delivery => delivery.answer?.state === "applied")).toBeTrue()
    f.panel.gestureOwner.end(holder)
    const drain = await f.panel.flushPending()
    expect(drain.unanswered).toEqual([])
    expect(f.fixture.builtInParameterPayloads).toHaveLength(4)
    expect(f.patches).toEqual([])
    expect(f.histories).toEqual([])
    const token = f.deliveries[0]?.gesture?.token
    if (!token) throw new Error("Missing no-dispatch panel token")
    expect(f.deliveries.at(-1)?.gesture).toEqual({ token, holds: false })
    promoted("R2-B3 no-dispatch panel token close", { candidate: "staged", dispatches: f.fixture.builtInParameterPayloads.length, outcomes: f.deliveries.map(delivery => delivery.answer), close: f.deliveries.at(-1)?.gesture })
    await f.dispose(); heldCompile.release(); await heldAdoption
  })

  for (const terminal of ["end", "cancel"] satisfies readonly ("end" | "cancel")[]) test(`3B1 multi-field panel ${terminal} clears one token without a fifth native dispatch`, async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...withGain(value), pan: value / 10 }))
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    for (const value of [-1, -2, -3, 0]) {
      await f.tick(holder, value)
      expect(f.heard()).toBe(value)
      expect(f.heardParameters.get(2)).toBeCloseTo(value / 10)
    }
    const token = f.deliveries[0]?.gesture?.token
    if (!token) throw new Error("Missing multi-field panel token")
    expect(f.deliveries.every(delivery => delivery.gesture?.holds && delivery.gesture.token === token)).toBeTrue()
    expect(f.fixture.builtInParameterPayloads.map(bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true))).toEqual([2, 2, 2, 2])
    f.panel.gestureOwner[terminal](holder)
    const drain = await f.panel.flushPending()
    expect(f.deliveries.at(-1)?.gesture).toEqual({ token, holds: false })
    expect(f.panel.gestureOwner.isOpen(holder)).toBeFalse()
    expect(f.fixture.builtInParameterPayloads).toHaveLength(4)
    expect(f.patches).toEqual([])
    expect(drain.unanswered).toEqual([])
    expect(f.histories).toEqual([])
    // A later desired-model change has no panel delivery. Reconciliation must no
    // longer be fenced by the closed token, even though native retained its old overrides.
    f.desire(-5)
    const adopted = await f.controller.adoptSchedule(migrationIntent("gesture-multi-field"), true)
    expect(adopted).toEqual({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(-5)
    expect(f.heardParameters.get(2)).toBeCloseTo(-0.5)
    expect(f.fixture.builtInParameterPayloads).toHaveLength(5)
    promoted(`Multi-field panel token clear ${terminal}`, { dispatchesAtClose: 4, fields: [1, 2], close: f.deliveries.at(-1)?.gesture, reconciledGain: f.heard(), outcomes: f.deliveries.map(delivery => delivery.answer) })
    await f.dispose()
  })

  test("3B1 a late old mapped proof cannot answer the panel close queued behind different content", async () => {
    const f = await mountedPanel(undefined, true)
    const apply = f.fixture.bridge.session.queueParameterEvents
    const queued: Uint8Array[] = []
    f.fixture.bridge.session.queueParameterEvents = async bytes => {
      queued.push(bytes)
      return { ok: true }
    }
    // The bridge admits four FIFO batches but applies none until explicitly released.
    for (const value of [-1, 0, -3, 0]) {
      f.panel.setForTarget("track", value)
      await f.panel.flushPending()
    }
    expect(queued).toHaveLength(4)
    expect(f.deliveries[3]?.answer).toBeUndefined()
    for (const bytes of queued.slice(0, 2)) { await apply(bytes); await turns() }
    expect(f.heard()).toBe(0)
    // Old A was heard, but B is still ahead of this request's A. Its own carrier remains unanswered.
    expect(f.deliveries[3]?.answer).toBeUndefined()
    expect((await f.panel.flushPending()).unanswered).toHaveLength(1)
    for (const bytes of queued.slice(2)) { await apply(bytes); await turns() }
    expect(f.heard()).toBe(0)
    expect(f.deliveries[3]?.answer).toEqual({ state: "applied" })
    expect((await f.panel.flushPending()).unanswered).toEqual([])
    await f.dispose()
  })

  test("3B1 a mixed-carrier gesture waits for its earlier mapped application before patching and closes on cancel", async () => {
    const f = await mountedPanel(undefined, true, new Set([9]))
    const heldCompile = holdCompile(f.controller)
    const heldAdoption = f.controller.adoptSchedule(migrationIntent("gesture-held-2"), true)
    await heldCompile.entered
    const apply = f.fixture.bridge.session.queueParameterEvents
    const queued: Uint8Array[] = []
    f.fixture.bridge.session.queueParameterEvents = async bytes => { queued.push(bytes); return { ok: true } }
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -1)
    await f.tick(holder, 9)
    expect(queued).toHaveLength(1)
    expect(f.patches).toEqual([])
    const bytes = queued[0]
    if (!bytes) throw new Error("Missing admitted parameter batch")
    await apply(bytes); await turns()
    expect(f.patches).toEqual([9])
    expect(f.heard()).toBe(9)
    const token = f.deliveries[0]?.gesture?.token
    if (!token) throw new Error("Missing mixed-carrier gesture token")
    expect(f.deliveries.slice(0, 2).every(delivery => delivery.gesture?.holds && delivery.gesture.token === token)).toBeTrue()
    f.panel.gestureOwner.cancel(holder)
    const drain = await f.panel.flushPending()
    expect(f.deliveries.at(-1)?.gesture).toEqual({ token, holds: false })
    expect(f.heard()).toBe(0)
    expect(f.patches).toEqual([9, 0])
    expect(drain.unanswered).toEqual([])
    expect(f.histories).toEqual([])
    promoted("R2-B3 mixed-carrier panel token close", { candidate: "staged", batches: queued.length, patches: f.patches, close: f.deliveries.at(-1)?.gesture, outcomes: f.deliveries.map(delivery => delivery.answer) })
    await f.dispose(); heldCompile.release(); await heldAdoption
  })

  test("3B1 returning to installed content supersedes an older refused panel carrier", async () => {
    const f = await mountedPanel(undefined, true)
    // A staged candidate makes the admission refusal transient, not an immediate patch-ladder attempt.
    const heldCompile = holdCompile(f.controller)
    const heldAdoption = f.controller.adoptSchedule(migrationIntent("gesture-held-3"), true)
    await heldCompile.entered
    const apply = f.fixture.bridge.session.queueParameterEvents
    let attempts = 0, refused = true
    f.fixture.bridge.session.queueParameterEvents = async bytes => {
      attempts++
      if (refused) return { ok: false, kind: "refused", error: "parameter-admission-rejected" }
      return apply(bytes)
    }
    f.panel.setForTarget("track", -4)
    await f.panel.flushPending()
    expect(f.heard()).toBe(0)
    expect(f.deliveries[0]?.answer).toBeUndefined()
    const before = attempts
    refused = false
    f.panel.setForTarget("track", 0)
    const drain = await f.panel.flushPending()
    expect(attempts).toBe(before + 1)
    expect(f.heard()).toBe(0)
    expect(f.deliveries[0]?.answer).toEqual({ state: "superseded", by: f.deliveries[1]?.edit.order })
    expect(f.deliveries[1]?.answer).toEqual({ state: "applied" })
    expect(drain.unanswered).toEqual([])
    await f.dispose(); heldCompile.release(); await heldAdoption
  })

  test("3B1 equal mapped values with panel structure change select exactly one native patch", async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...createDefaultUtilityParams(), swap: value !== 0 }))
    f.panel.setForTarget("track", 1)
    const drain = await f.panel.flushPending()
    expect(f.fixture.builtInParameterPayloads).toEqual([])
    expect(f.patches).toEqual([0])
    expect(f.patchSwaps).toEqual([true])
    expect(f.heardSwap()).toBeTrue()
    expect(f.heard()).toBe(0)
    expect(f.deliveries[0]?.answer).toEqual({ state: "applied" })
    expect(f.histories).toEqual(["0->1"])
    expect(drain.unanswered).toEqual([])
    promoted("A3 structural native selector through panel", { mappedBatches: 0, patches: f.patches, installedSwap: f.heardSwap(), outcome: f.deliveries[0]?.answer })
    await f.dispose()
  })

  test("3B1 an adopted old panel gesture cannot fence a re-created registry target", async () => {
    const f = await mountedPanel(undefined, true)
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -1)
    expect(f.heard()).toBe(-1)
    expect(await f.controller.adoptSchedule(migrationIntent("public-migration-13"), true)).toMatchObject({ status: "adopted" })
    const old = f.registry.target("track", "utility:1")
    if (!old) throw new Error("Missing old panel target")
    // Publication consumed the old desired entry, but the native history slot
    // and its open token outlive that ledger entry. Reset only renderer membership.
    f.registry.reset()
    const fresh = f.desire(0)
    if (!fresh) throw new Error("Missing re-created panel target")
    expect(fresh.target.incarnation).not.toBe(old.incarnation)
    expect(await f.controller.adoptSchedule(migrationIntent("public-migration-14"), true)).toMatchObject({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(0)
    expect(f.fixture.builtInParameterPayloads).toHaveLength(2)
    expect(f.patches).toEqual([])
    expect(f.histories).toEqual([])
    await f.dispose()
  })


  test("3B1 a declined structural panel registration cannot become an applied receipt", async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...createDefaultUtilityParams(), swap: value !== 0 }))
    f.mode("refused")
    f.panel.setForTarget("track", 1)
    const drain = await f.panel.flushPending()
    expect(f.fixture.builtInParameterPayloads).toEqual([])
    expect(f.patches).toEqual([0])
    expect(f.patchSwaps).toEqual([true])
    expect(f.heardSwap()).toBeFalse()
    expect(f.deliveries[0]?.answer).toEqual({ state: "refused", reason: "invalid" })
    expect(f.events).toEqual(["register:1", "save:1"])
    expect(f.histories).toEqual(["0->1"])
    expect(f.panel.params()).toBe(1)
    expect(drain.unanswered).toEqual([])
    promoted("A3 declined native registration", { installedSwap: f.heardSwap(), outcome: f.deliveries[0]?.answer, history: f.histories })
    await f.dispose()
  })

  test("3B1 a whole edit missing one live field must patch instead of claiming partial parameter proof", async () => {
    const f = await mountedPanel(undefined, true)
    const params = { ...withGain(-2), pan: -0.25 }
    const edit = f.registry.allocate(utilityCommit("utility:1", params, params))
    if (!edit) throw new Error("Missing whole registry edit")
    const values = Object.fromEntries(Object.entries(edit.content.values ?? {}).filter(([id]) => id !== "utility.pan"))
    const registration = f.controller.deliverProcessor({ ...edit, content: { ...edit.content, values } })
    expect(await registration.settled).toEqual({ state: "applied" })
    expect(f.fixture.builtInParameterPayloads).toEqual([])
    expect(f.patches).toEqual([-2])
    expect(f.heard()).toBe(-2)
    expect(f.heardParameters.get(2)).toBe(-0.25)
    expect(f.histories).toEqual([])
    await f.dispose()
  })

  test("3B1 publication changes structure with equal mapped values, and panel cancel restores it once", async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...withGain(0), swap: value === 9 }))
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, 1)
    f.desire(9)
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-22")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

    const nativePrepare = f.fixture.bridge.session.revisions.prepare
    let captured = false
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    f.fixture.bridge.session.revisions.prepare = async request => {
      const reply = await nativePrepare(request)
      captured = true
      await held
      return reply
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await turns()
    expect(captured).toBeTrue()
    await f.tick(holder, 2)
    expect(f.patches).toEqual([])
    expect(f.fixture.builtInParameterPayloads).toEqual([])
    release()
    expect(await publication).toEqual({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(0)
    expect(f.heardSwap()).toBeTrue()
    expect(f.patches).toEqual([])
    f.panel.gestureOwner.cancel(holder)
    const drain = await f.panel.flushPending()
    expect(f.heard()).toBe(0)
    expect(f.heardSwap()).toBeFalse()
    expect(f.patches).toEqual([0])
    expect(f.patchSwaps).toEqual([false])
    expect(f.fixture.builtInParameterPayloads).toEqual([])
    expect(drain.unanswered).toEqual([])
    expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" })
    expect(f.deliveries.at(-1)?.gesture?.holds).toBeFalse()
    expect(f.histories).toEqual([])
    promoted("N2 publication structure through panel", { gain: f.heard(), finalSwap: f.heardSwap(), patchSwaps: f.patchSwaps, parameterBatches: f.fixture.builtInParameterPayloads.length, close: f.deliveries.at(-1)?.gesture, outcomes: f.deliveries.map(delivery => delivery.answer) })
    await f.dispose()
  })

  test("3B1 an equal publication cannot answer a panel close behind a different pending parameter batch", async () => {
    const f = await mountedPanel(undefined, true)
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-23")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const nativePrepare = f.fixture.bridge.session.revisions.prepare
    const heldPrepare = Promise.withResolvers<void>()
    let captured = false
    f.fixture.bridge.session.revisions.prepare = async request => {
      const reply = await nativePrepare(request)
      captured = true
      await heldPrepare.promise
      return reply
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await turns()
    expect(captured).toBeTrue()
    const nativeParameters = f.fixture.bridge.session.queueParameterEvents
    const queued: Uint8Array[] = []
    f.fixture.bridge.session.queueParameterEvents = async bytes => { queued.push(bytes); return { ok: true } }
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -2)
    f.panel.gestureOwner.cancel(holder)
    await f.panel.flushPending()
    const closeDelivery = f.deliveries.at(-1)
    expect(queued).toHaveLength(2)
    expect(closeDelivery?.answer).toBeUndefined()
    heldPrepare.resolve()
    expect(await publication).toEqual({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(0)
    expect(closeDelivery?.answer).toBeUndefined()
    const [different, close] = queued
    if (!different || !close) throw new Error("Missing ordered native batches")
    await nativeParameters(different)
    await turns()
    expect(f.heard()).toBe(-2)
    expect(closeDelivery?.answer).toBeUndefined()
    await nativeParameters(close)
    await turns()
    expect(f.heard()).toBe(0)
    expect(closeDelivery?.answer).toEqual({ state: "applied" })
    expect((await f.panel.flushPending()).unanswered).toEqual([])
    expect(f.histories).toEqual([])
    await f.dispose()
  })

  test("3B1 equal adoption proves a panel close after coalescing its unsent structural predecessor", async () => {
    const f = await mountedPanel(undefined, true, new Set([-2]))
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-24")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const prepare = f.fixture.bridge.session.revisions.prepare
    const captured = Promise.withResolvers<void>(), publicationGate = Promise.withResolvers<void>()
    const patchGate = Promise.withResolvers<NativeProcessorPatchReply>()
    f.fixture.bridge.session.revisions.prepare = async request => {
      const reply = await prepare(request)
      captured.resolve()
      await publicationGate.promise
      return reply
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await captured.promise
    f.gate(patchGate.promise)
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -2)
    f.panel.gestureOwner.cancel(holder)
    await f.panel.flushPending()
    const close = f.deliveries.at(-1)
    expect(close?.answer).toBeUndefined()
    publicationGate.resolve()
    expect(await publication).toEqual({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(0)
    // Unlike the parameter-lane race above, the structural predecessor was
    // still unsent and the close replaced it before this publication adopted.
    // Native's actual equal content can therefore prove the close now.
    expect(f.patches).not.toContain(-2)
    expect(close?.answer).toEqual({ state: "applied" })
    f.gate()
    patchGate.resolve({ ok: true, outcome: "applied" })
    await turns()
    expect(f.heard()).toBe(0)
    expect(close?.answer).toEqual({ state: "applied" })
    expect(f.histories).toEqual([])
    await f.dispose()
  })

  test("3B1 equal adoption with different queued content cannot heal the panel incident", async () => {
    const f = await mountedPanel(undefined, true)
    const apply = f.fixture.bridge.session.queueParameterEvents
    const refuse = async (): Promise<NativeDeliveryReply> => ({ ok: false, kind: "refused", error: "parameter-admission-rejected" })
    f.fixture.bridge.session.queueParameterEvents = refuse
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -3)
    expect(f.faults).toHaveLength(1)
    f.desire(0)
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-25")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const prepare = f.fixture.bridge.session.revisions.prepare
    const captured = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.fixture.bridge.session.revisions.prepare = async request => {
      const reply = await prepare(request)
      captured.resolve()
      await release.promise
      return reply
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await captured.promise
    const queued: Uint8Array[] = []
    f.fixture.bridge.session.queueParameterEvents = async bytes => { queued.push(bytes); return { ok: true } }
    await f.tick(holder, -2)
    f.panel.gestureOwner.cancel(holder)
    await f.panel.flushPending()
    expect(queued).toHaveLength(2)
    release.resolve()
    expect(await publication).toEqual({ status: "adopted" })
    expect(f.heard()).toBe(0)
    expect(f.deliveries.at(-1)?.answer).toBeUndefined()
    f.mode("refused")
    f.fixture.bridge.session.queueParameterEvents = refuse
    f.panel.setForTarget("track", -4)
    await f.panel.flushPending(); await turns()
    expect(f.faults).toHaveLength(1)
    for (const batch of queued) await apply(batch)
    await turns()
    expect(f.faults).toHaveLength(1)
    f.mode("applied")
    f.fixture.bridge.session.queueParameterEvents = apply
    f.panel.setForTarget("track", -5)
    await f.panel.flushPending(); await turns()
    expect(f.heard()).toBe(-5)
    f.mode("refused")
    f.fixture.bridge.session.queueParameterEvents = refuse
    f.panel.setForTarget("track", -6)
    await f.panel.flushPending(); await turns()
    expect(f.faults).toHaveLength(2)
    await f.dispose()
  })

  test("3B1 restated publication replays an unanswered whole panel edit by patch, not parameters alone", async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...withGain(value === 9 ? 0 : value), swap: value === 9 }))
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    f.desire(9)
    const candidateCompile = holdCompile(f.controller)
    const candidateIntent = migrationIntent("migration-26")
    const candidateAdoption = f.controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))
    const nativePrepare = f.fixture.bridge.session.revisions.prepare
    const heldPrepare = Promise.withResolvers<void>()
    let captured = false
    f.fixture.bridge.session.revisions.prepare = async request => {
      const reply = await nativePrepare(request)
      captured = true
      await heldPrepare.promise
      return reply
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await turns()
    expect(captured).toBeTrue()
    const nativeParameters = f.fixture.bridge.session.queueParameterEvents
    let parameterAttempts = 0
    f.fixture.bridge.session.queueParameterEvents = async () => { parameterAttempts++; return { ok: true } }
    await f.tick(holder, -2)
    expect(parameterAttempts).toBe(1)
    expect(f.deliveries.at(-1)?.answer).toBeUndefined()
    const heldPatch = Promise.withResolvers<NativeProcessorPatchReply>()
    f.gate(heldPatch.promise)
    heldPrepare.resolve()
    expect(await publication).toEqual({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(0)
    expect(f.heardSwap()).toBeTrue()
    expect(f.patches).toEqual([-2])
    expect(parameterAttempts).toBe(1)
    expect(f.deliveries.at(-1)?.answer).toBeUndefined()
    heldPatch.resolve({ ok: true, outcome: "applied" })
    await turns()
    expect(f.heard()).toBe(-2)
    expect(f.heardSwap()).toBeFalse()
    expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" })
    expect(f.histories).toEqual([])
    f.fixture.bridge.session.queueParameterEvents = nativeParameters
    f.gate()
    f.panel.gestureOwner.cancel(holder)
    expect((await f.panel.flushPending()).unanswered).toEqual([])
    expect(f.heard()).toBe(0)
    await f.dispose()
  })

  test("3B1 a foreign panel row reconciles non-live structure despite equal mapped values", async () => {
    const f = await mountedPanel(undefined, true, new Set(), value => ({ ...createDefaultUtilityParams(), swap: value !== 0 }))
    f.observe(1, 6)
    const drain = await f.panel.flushPending()
    expect(f.panel.params()).toBe(1)
    expect(f.fixture.builtInParameterPayloads).toEqual([])
    expect(f.patches).toEqual([0])
    expect(f.patchSwaps).toEqual([true])
    expect(f.heardSwap()).toBeTrue()
    expect(f.deliveries[0]?.answer).toEqual({ state: "applied" })
    expect(f.events).toEqual(["register:1"])
    expect(f.histories).toEqual([])
    expect(drain.unanswered).toEqual([])
    promoted("R2-B6b panel full-structure reconciliation", { mappedBatches: 0, installedSwap: f.heardSwap(), outcome: f.deliveries[0]?.answer, history: f.histories })
    await f.dispose()
  })

  test("3B1 a refused panel restore recovers through actual native adoption without a caller retry", async () => {
    const f = await mountedPanel(undefined, true, new Set([-1]))
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -1)
    expect(f.heard()).toBe(-1)
    f.mode("refused")
    f.panel.gestureOwner.cancel(holder)
    const failed = await f.panel.flushPending()
    expect(f.deliveries.at(-1)?.answer).toEqual({ state: "refused", reason: "invalid" })
    expect(f.heard()).toBe(-1)
    expect(f.panel.params()).toBe(0)
    expect(f.histories).toEqual([])
    expect(f.faults).toHaveLength(1)
    expect(failed.unanswered).toEqual([])
    const registrations = f.deliveries.length
    expect(await f.controller.adoptSchedule(migrationIntent("public-migration-15"), true)).toMatchObject({ status: "adopted" })
    await turns()
    expect(f.heard()).toBe(0)
    expect(f.deliveries).toHaveLength(registrations)
    expect(f.histories).toEqual([])
    expect(f.faults).toHaveLength(1)
    // Adoption's current-desired proof closes the old incident and re-arms it.
    f.panel.setForTarget("track", -1)
    await f.panel.flushPending()
    expect(f.faults).toHaveLength(2)
    promoted("R7-2 refused restore recovery through panel", { registrationsAtRecovery: registrations, patches: f.patches, recoveredGain: 0, noticesAfterNextFailure: f.faults.length })
    await f.dispose()
  })

  test("3B1 a declined mapped panel release exhausts its one retry and patch ladder, then adoption recovers it", async () => {
    const f = await mountedPanel(undefined, true)
    let attempts = 0
    f.fixture.bridge.session.queueParameterEvents = async () => {
      attempts++
      return { ok: false, kind: "refused", error: "parameter-admission-rejected" }
    }
    f.mode("refused")
    const prepares = () => f.fixture.calls.filter(call => call === "revision-prepare").length
    const before = prepares()
    f.panel.setForTarget("track", -1)
    const failed = await f.panel.flushPending()
    expect(attempts).toBe(2)
    expect(f.patches).toEqual([-1])
    expect(prepares()).toBe(before)
    expect(f.faults).toHaveLength(1)
    expect(f.deliveries[0]?.answer).toEqual({ state: "refused", reason: "invalid" })
    expect(f.heard()).toBe(0)
    expect(f.panel.params()).toBe(-1)
    expect(f.histories).toEqual(["0->-1"])
    expect(failed.unanswered).toEqual([])
    const registrations = f.deliveries.length
    expect(await f.controller.adoptSchedule(migrationIntent("public-migration-16"), true)).toMatchObject({ status: "adopted" })
    expect(f.heard()).toBe(-1)
    expect(f.deliveries).toHaveLength(registrations)
    expect(f.histories).toEqual(["0->-1"])
    expect(f.faults).toHaveLength(1)
    promoted("N5 native panel decline/recovery", { parameterAttempts: attempts, ladderPatches: f.patches.length, preparesBeforeRecovery: before, registrations, recoveredGain: f.heard(), history: f.histories })
    await f.dispose()
  })

  test("3B1 a failed release under G2 delivers G2 content with G2 identity and token", async () => {
    const failed = Promise.withResolvers<ParameterSaveResult>()
    const f = await mountedPanel(() => failed.promise)
    f.panel.setForTarget("track", -3)
    await turns()
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -2)
    failed.reject(new Error("Save refused"))
    await turns()
    const holding = f.deliveries.filter(delivery => delivery.gesture?.holds)
    expect(holding.length).toBeGreaterThan(0)
    for (const delivery of holding) {
      const bytes = delivery.edit.content.state
      if (!bytes) throw new Error("Missing encoded whole state")
      expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(4, true)).toBe(delivery.value)
      expect(delivery.value).toBe(-2)
      expect(delivery.gesture?.token).toBe(holding[0]?.gesture?.token)
    }
    expect(f.heard()).toBe(-2)
    promoted("G2 repair content matches its encoded identity", { holding: holding.length, heard: f.heard() })
    f.panel.gestureOwner.cancel(holder)
    await expect(f.panel.flushPending()).rejects.toThrow("A released parameter edit failed")
    await f.dispose()
  })

  test("3B1 an old cancel queued behind a save holds the new gesture token and its effective value", async () => {
    const saved = Promise.withResolvers<ParameterSaveResult>()
    const f = await mountedPanel(() => saved.promise)
    const first = new ParameterGestureHolder(), second = new ParameterGestureHolder()
    f.panel.gestureOwner.open(first)
    await f.tick(first, -1)
    const oldToken = f.deliveries[0]?.gesture?.token
    f.panel.gestureOwner.once(() => f.panel.update(() => -3))
    await turns()
    f.panel.gestureOwner.cancel(first)
    f.panel.gestureOwner.open(second)
    await f.tick(second, -2)
    expect(f.deliveries.map(delivery => delivery.value)).toEqual([-1, -3])
    saved.resolve({ kind: "committed", through: 5 })
    await turns()
    const restores = f.deliveries.slice(2)
    expect(restores).toHaveLength(2)
    expect(restores.map(delivery => delivery.value)).toEqual([-2, -2])
    expect(restores.every(delivery => delivery.gesture?.holds && delivery.gesture.token !== oldToken)).toBe(true)
    expect(restores[0]?.gesture?.token).toBe(restores[1]?.gesture?.token)
    expect(f.heard()).toBe(-2)
    promoted("R7-1 holding G2 token", { values: restores.map(delivery => delivery.value), sameToken: restores[0]?.gesture?.token === restores[1]?.gesture?.token, heard: f.heard() })
    f.panel.gestureOwner.cancel(second)
    await f.panel.flushPending()
    await f.dispose()
  })

  for (const mode of ["refused", "unconfirmed"] satisfies readonly ("refused" | "unconfirmed")[]) {
    test(`3B1 native ${mode} is preserved through the panel without vetoing save or history`, async () => {
      const f = await mountedPanel()
      f.mode(mode)
      f.panel.setForTarget("track", -3)
      const drain = await f.panel.flushPending()
      expect(f.deliveries).toHaveLength(1)
      expect(f.deliveries[0]?.answer?.state).toBe(mode)
      expect(f.events).toEqual(["register:-3", "save:-3"])
      expect(f.histories).toEqual(["0->-3"])
      expect(f.panel.params()).toBe(-3)
      expect(f.heard()).toBe(0)
      expect(f.faults).toHaveLength(1)
      expect(drain.unanswered).toEqual([])
      promoted(`R4-1 native ${mode} at panel boundary`, { outcome: f.deliveries[0]?.answer, heard: f.heard(), history: f.histories })
      await f.dispose()
    })
  }

  test("3B1 claimed panel receipt is retained and reported, then matching resolution settles it once", async () => {
    const f = await mountedPanel()
    f.mode("claimed")
    f.panel.setForTarget("track", -3)
    const first = await f.panel.flushPending()
    expect(first.unanswered).toHaveLength(1)
    expect(f.deliveries[0]?.answer).toBeUndefined()
    expect(f.heard()).toBe(0)
    expect(f.histories).toEqual(["0->-3"])
    f.fixture.emitPatchResolution("76", 0)
    await turns()
    expect(f.deliveries[0]?.answer).toBeUndefined()
    f.fixture.emitPatchResolution("77", 0)
    await turns()
    expect(f.deliveries[0]?.answer).toEqual({ state: "applied" })
    expect(f.heard()).toBe(-3)
    expect((await f.panel.flushPending()).unanswered).toEqual([])
    expect(f.patches).toEqual([-3])
    expect(f.histories).toEqual(["0->-3"])
    promoted("N4 claimed native panel receipt", { pending: first.unanswered.length, resolved: f.deliveries[0]?.answer, patches: f.patches })
    await f.dispose()
  })

  test("3B1 installed A, pending B, panel requests A after B and never suppresses its logical close", async () => {
    const f = await mountedPanel()
    const pending = Promise.withResolvers<NativeProcessorPatchReply>()
    f.gate(pending.promise)
    f.panel.setForTarget("track", -3)
    await f.panel.flushPending()
    expect(f.patches).toEqual([-3])
    f.panel.setForTarget("track", 0)
    const before = await f.panel.flushPending()
    expect(f.deliveries).toHaveLength(2)
    expect(before.unanswered).toHaveLength(2)
    f.gate()
    pending.resolve({ ok: true, outcome: "applied" })
    await turns()
    expect(f.patches).toEqual([-3, 0])
    expect(f.heard()).toBe(0)
    expect(f.panel.params()).toBe(0)
    // B really installed before its ACK. Its own proof is applied, not retroactively called superseded.
    expect(f.deliveries[0]?.answer).toEqual({ state: "applied" })
    expect(f.deliveries[1]?.answer).toEqual({ state: "applied" })
    promoted("R3-A3b/R3-A6 panel installed-A/pending-B/request-A", { patches: f.patches, outcomes: f.deliveries.map(delivery => delivery.answer) })
    await f.dispose()
  })

  test("3B1 a newer panel delivery supersedes a queued native receipt with its actual order", async () => {
    const f = await mountedPanel()
    const pending = Promise.withResolvers<NativeProcessorPatchReply>()
    f.gate(pending.promise)
    f.panel.setForTarget("track", -1)
    await f.panel.flushPending()
    f.panel.setForTarget("track", -3)
    await f.panel.flushPending()
    f.panel.setForTarget("track", -2)
    await f.panel.flushPending()
    expect(f.patches).toEqual([-1])
    expect(f.deliveries[1]?.answer).toBeUndefined()
    f.gate()
    pending.resolve({ ok: true, outcome: "applied" })
    await turns()
    expect(f.patches).toEqual([-1, -2])
    expect(f.deliveries[1]?.answer).toEqual({ state: "superseded", by: f.deliveries[2]?.edit.order })
    expect(f.deliveries[2]?.answer).toEqual({ state: "applied" })
    expect(f.heard()).toBe(-2)
    expect(f.panel.params()).toBe(-2)
    expect(f.histories).toEqual(["0->-1", "-1->-3", "-3->-2"])
    promoted("R6-1 native superseded(by) at panel boundary", { patches: f.patches, outcomes: f.deliveries.map(delivery => delivery.answer) })
    await f.dispose()
  })

  test("3B1 a foreign row wins over a held native restore and late old proof", async () => {
    const f = await mountedPanel()
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -1)
    const pending = Promise.withResolvers<NativeProcessorPatchReply>()
    f.gate(pending.promise)
    f.panel.gestureOwner.cancel(holder)
    await f.panel.flushPending()
    expect(f.patches).toEqual([-1, 0])
    f.observe(9, 6)
    await f.panel.flushPending()
    expect(f.panel.params()).toBe(9)
    expect(f.histories).toEqual([])
    expect(f.deliveries.at(-1)?.answer).toBeUndefined()
    f.gate()
    pending.resolve({ ok: true, outcome: "applied" })
    await turns()
    expect(f.patches).toEqual([-1, 0, 9])
    expect(f.heard()).toBe(9)
    expect(f.panel.params()).toBe(9)
    f.panel.setForTarget("track", 0)
    await f.panel.flushPending()
    expect(f.histories).toEqual(["9->0"])
    promoted("A1 native held restore proof after foreign row", { patches: f.patches, history: f.histories, heard: f.heard() })
    await f.dispose()
  })

  test("3B1 current panel proof heals an incident and re-arms its next failure", async () => {
    const f = await mountedPanel()
    f.mode("refused")
    f.panel.setForTarget("track", -1)
    await f.panel.flushPending()
    expect(f.faults).toHaveLength(1)
    f.panel.setForTarget("track", -2)
    await f.panel.flushPending()
    expect(f.faults).toHaveLength(1)
    f.mode("applied")
    f.panel.setForTarget("track", -3)
    await f.panel.flushPending()
    expect(f.heard()).toBe(-3)
    expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" })
    f.mode("refused")
    f.panel.setForTarget("track", -4)
    await f.panel.flushPending()
    expect(f.faults).toHaveLength(2)
    expect(f.histories).toEqual(["0->-1", "-1->-2", "-2->-3", "-3->-4"])
    promoted("Panel current-desired incident healing control", { notices: f.faults.length, heard: f.heard(), history: f.histories })
    await f.dispose()
  })

  test("3B1 two panel targets share one incident until full recovery and session loss re-arms it", async () => {
    const fixture = createBridge()
    const source = twoUtilities()
    const registry = createProcessorEditRegistry(() => 120)
    const compiled = await source.compileSnapshot()
    if (!compiled.supported) throw new Error("Missing two-target snapshot")
    registry.observe(compiled.snapshot.mixer.fx)
    const faults: NativePlaybackFault[] = []
    const controller = createObservedController({
      bridge: fixture.bridge, compileSnapshot: source.compileSnapshot,
      getProcessorTarget: registry.target,
      reportFault: fault => { faults.push(fault) },
    })
    let refuse = true
    const heard = new Map<number, number>()
    const attempts: number[] = []
    fixture.bridge.session.queueProcessorStatePatch = async bytes => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const value = view.getFloat32(60, true)
      attempts.push(value)
      if (refuse) return { ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 }
      heard.set(view.getUint32(16, true), value)
      return { ok: true, outcome: "applied" }
    }
    await controller.start(utilityPlaybackInput().transport)
    const histories: string[] = []
    const answers: ProcessorDeliveryOutcome[] = []
    let dispose = () => {}
    const panels = createRoot(end => {
      dispose = end
      return ["utility:1", "utility:2"].map(instanceId => createPersistedEffectState<number, number>({
        targetId: () => "track", row: () => 0, readQueryParams: row => row,
        createInitialParams: () => 0, serializeParams: String, applyToEngine: () => "skipped",
        allocateEdit: (_target, _from, value) => {
          const params: ReturnType<typeof createDefaultUtilityParams> = { ...withGain(value),
            dcBlock: (Math.abs(value) & 2) === 0, swap: value % 2 !== 0, polarity: value <= -4 ? "invert" : "normal" }
          return registry.allocate(utilityCommit(instanceId, params, params))
        },
        registerDelivery: (_target, _value, edit, gesture) => {
          if (!edit) throw new Error("Missing two-target panel edit")
          const registration = controller.deliverProcessor(edit, gesture)
          void registration.settled.then(answer => { answers.push(answer) })
          return registration
        },
        persistParams: () => ({ kind: "committed-unordered" }),
        history: (_target, from, to) => { histories.push(`${instanceId}:${from}->${to}`) },
      }))
    })
    const a = panels[0], b = panels[1]
    if (!a || !b) throw new Error("Missing panel targets")
    await Promise.all(panels.map(panel => panel.flushPending()))
    await turns()
    answers.length = 0
    const notices = () => faults.filter(fault => fault.kind === "delivery-refused").length
    a.setForTarget("track", -1); b.setForTarget("track", -1)
    await Promise.all(panels.map(panel => panel.flushPending()))
    await turns()
    expect(notices()).toBe(1)
    expect(heard.size).toBe(0)
    refuse = false
    a.setForTarget("track", -2); await a.flushPending()
    await turns()
    expect([...heard.values()]).toEqual([-2])
    refuse = true
    a.setForTarget("track", -3); await a.flushPending()
    await turns()
    expect(notices()).toBe(1)
    refuse = false
    a.setForTarget("track", -4); b.setForTarget("track", -2)
    await Promise.all(panels.map(panel => panel.flushPending()))
    await turns()
    expect([...heard.values()].sort()).toEqual([-2, -4])
    refuse = true
    a.setForTarget("track", -5); await a.flushPending()
    await turns()
    expect(notices()).toBe(2)
    const installedBeforeSessionLoss = [...heard.values()]
    fixture.emitLoss("Native playback host connection was lost.")
    await turns()
    await controller.start(utilityPlaybackInput().transport)
    b.setForTarget("track", -3); await b.flushPending()
    await turns()
    expect(notices()).toBe(3)
    expect(histories).toHaveLength(8)
    expect(answers.some(answer => answer.state === "applied")).toBeTrue()
    expect(answers.filter(answer => answer.state === "refused")).toHaveLength(5)
    promoted("R2-A1 panel multi-target incident membership", { notices: notices(), partialRecoveryNotices: 1, fullRecoveryNotices: 2, afterSessionLossNotices: 3, installedBeforeSessionLoss, histories, outcomes: answers, attempts })
    dispose()
    await controller.dispose()
  })

  test("3B1 an actual late old panel proof cannot heal a newer failure, but current proof does", async () => {
    const f = await mountedPanel(undefined, true)
    const apply = f.fixture.bridge.session.queueParameterEvents
    let oldBatch: Uint8Array | undefined
    let refuse = true
    f.fixture.bridge.session.queueParameterEvents = async bytes => {
      if (!oldBatch) { oldBatch = bytes; return { ok: true } }
      return refuse ? { ok: false, kind: "refused", error: "parameter-admission-rejected" } : apply(bytes)
    }
    const holder = new ParameterGestureHolder()
    f.panel.gestureOwner.open(holder)
    await f.tick(holder, -1)
    expect(f.heard()).toBe(0)
    expect(f.deliveries[0]?.answer).toBeUndefined()
    await f.tick(holder, -2)
    expect(f.deliveries[1]?.answer).toEqual({ state: "refused", reason: "native-refused" })
    expect(f.faults).toHaveLength(1)
    // Release the actual older FIFO batch and its matching native progress, not
    // an invented sequence. The current desired value is still the failed -2.
    if (!oldBatch) throw new Error("Missing old admitted panel batch")
    await apply(oldBatch)
    await turns()
    expect(f.heard()).toBe(-1)
    expect(f.deliveries[0]?.answer).toEqual({ state: "superseded", by: f.deliveries[1]?.edit.order })
    await f.tick(holder, -3)
    expect(f.faults).toHaveLength(1)
    refuse = false
    await f.tick(holder, -4)
    expect(f.heard()).toBe(-4)
    expect(f.deliveries.at(-1)?.answer).toEqual({ state: "applied" })
    refuse = true
    await f.tick(holder, -5)
    expect(f.faults).toHaveLength(2)
    expect(f.histories).toEqual([])
    promoted("R4-2d native panel incident healing", { oldAppliedGain: -1, noticesAfterOldProof: 1, currentAppliedGain: -4, noticesAfterNextFailure: f.faults.length, outcomes: f.deliveries.map(delivery => delivery.answer) })
    refuse = false
    f.panel.gestureOwner.cancel(holder)
    await f.panel.flushPending()
    await f.dispose()
  })

  test("paused-claim-resolves-by-token: a claim resolves by its token while paused and quiet, with no incident", async () => {
    const fixture = createBridge()
    const faults: unknown[][] = []
    fixture.bridge.session.queueProcessorStatePatch = async () => ({ ok: true, outcome: "claimed", token: "7" })
    const controller = quietController(fixture, faults)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    const answer = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -3))).settled)
    await turns()
    expect(answer.value).toBeUndefined()
    fixture.emitPatchResolution("7", 0)
    await turns()
    expect(answer.value).toEqual({ state: "applied" })
    expect(faults).toEqual([])
    await controller.dispose()
  })

  test("consecutive-claims-quiet: the second claim is sent only after the first resolves, each answered once", async () => {
    const fixture = createBridge()
    const sent: Uint8Array[] = []
    fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
      sent.push(bytes)
      return { ok: true, outcome: "claimed", token: String(sent.length + 6) }
    }
    const controller = quietController(fixture)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    const first = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -1))).settled)
    // Submitted together, two patches of one target coalesce to the latest before the lane sends; the second claim
    // exists only once the first is in flight.
    await turns()
    const second = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -2))).settled)
    await turns()
    expect(sent).toHaveLength(1)
    fixture.emitPatchResolution("7", 0)
    await turns()
    expect(first.value).toEqual({ state: "applied" })
    expect(sent).toHaveLength(2)
    expect(second.value).toBeUndefined()
    fixture.emitPatchResolution("8", 0)
    await turns()
    expect(second.value).toEqual({ state: "applied" })
    await controller.dispose()
  })

  test("progress-before-reply: a resolution frame that arrives before the claimed reply settles it once", async () => {
    const fixture = createBridge()
    const reply = Promise.withResolvers<NativeProcessorPatchReply>()
    const entered = Promise.withResolvers<void>()
    fixture.bridge.session.queueProcessorStatePatch = () => { entered.resolve(); return reply.promise }
    const controller = quietController(fixture)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    const answer = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -3))).settled)
    await entered.promise
    fixture.emitPatchResolution("7", 7)
    reply.resolve({ ok: true, outcome: "claimed", token: "7" })
    await turns()
    // The claim's own result was a failure: a claim is not an application.
    expect(answer.value).toMatchObject({ state: "refused" })
    await controller.dispose()
  })

  test("alternating-results-coherent: each claim is answered with its own result", async () => {
    const fixture = createBridge()
    let tokens = 0
    fixture.bridge.session.queueProcessorStatePatch = async () => ({ ok: true, outcome: "claimed", token: String(++tokens) })
    const controller = quietController(fixture)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    const handled: boolean[] = []
    for (let index = 0; index < 4; index += 1) {
      const answer = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -1 - index))).settled)
      await turns()
      fixture.emitPatchResolution(String(index + 1), index % 2 === 0 ? 0 : 7)
      await turns()
      handled.push(answer.value?.state === "applied")
    }
    expect(handled).toEqual([true, false, true, false])
    await controller.dispose()
  })

  test("lost-claimed-reply-blocking-token: the resend is told the blocking token; prepare and another target stay unsent", async () => {
    const fixture = createBridge()
    const sent: Uint8Array[] = []
    const replies: Array<() => Promise<NativeProcessorPatchReply>> = [
      () => Promise.reject(new Error("The native audio host control request timed out.")),
      async () => ({ ok: true, outcome: "refused", refusal: "claim-pending", coreResult: 0, token: "9" }),
    ]
    fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
      sent.push(bytes)
      return (replies.shift() ?? (async () => ({ ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 })))()
    }
    const controller = createObservedController({ bridge: fixture.bridge, compileSnapshot: twoUtilities().compileSnapshot })
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    const baseline = prepares(fixture)
    const first = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -1))).settled)
    await turns()
    expect(sent).toHaveLength(2)
    void controller.deliverProcessor(fixturePatchEdit(patchFor("utility:2", -2))).settled
    await turns()
    expect(sent).toHaveLength(2)
    expect(prepares(fixture)).toBe(baseline)
    fixture.emitPatchResolution("9", 0)
    await turns()
    expect(sent.length).toBeGreaterThan(2)
    // The lost attempt is never certified by another claim's resolution, and the reconcile that followed was refused:
    // a refusal after a lost attempt is not a refusal.
    expect(first.value).toEqual({ state: "unconfirmed" })
    await controller.dispose()
  })

  for (const lostReply of [false, true]) for (const end of ["release", "loss"]) {
    test(`W57 claim fence lost=${lostReply}, ${end}: two targets and newest desired before absolute publication`, async () => {
      const fixture = createBridge()
      const sent: Uint8Array[] = []
      let claimReleased = false
      fixture.bridge.session.queueProcessorStatePatch = async bytes => {
        sent.push(bytes.slice())
        if (sent.length === 1) {
          if (lostReply) throw new Error("Lost status, existing one-resend controller boundary")
          return { ok: true, outcome: "claimed", token: "9" }
        }
        if (!claimReleased) return { ok: true, outcome: "refused", refusal: "claim-pending", token: "9", coreResult: 0 }
        return { ok: true, outcome: "applied" }
      }
      let keep = new Set(["track"])
      const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
        getKeepLatencyNodeIds: () => keep, compileSnapshot: twoUtilities().compileSnapshot })
      try {
        await controller.ensureLivePreview(0)
        const baseline = prepares(fixture)
        const first = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -1))).settled)
        await turns()
        const blockedSends = sent.length
        const newest = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -9))).settled)
        const other = watch(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:2", -4))).settled)
        keep = new Set()
        const publication = watch(controller.updateKeepLatency())
        await turns()
        expect(prepares(fixture)).toBe(baseline)
        expect(sent.length).toBe(blockedSends)
        expect(publication.value).toBeUndefined()
        if (end === "loss") {
          fixture.emitLoss("W57 owning session lost")
          await turns()
          const commands = fixture.calls.slice()
          fixture.emitPatchResolution("9", 0)
          await turns()
          expect(fixture.calls).toEqual(commands)
          expect(prepares(fixture)).toBe(baseline)
          expect(newest.value).toEqual({ state: "unavailable" })
          expect(other.value).toEqual({ state: "unavailable" })
        } else {
          claimReleased = true
          fixture.emitPatchResolution("9", 0)
          await turns()
          expect(prepares(fixture)).toBe(baseline + 1)
          expect(publication.value).toEqual({ handled: true })
          expect(newest.value).toEqual({ state: "applied" })
          expect(other.value).toEqual({ state: "applied" })
          const graphs = fixture.graphPayloads.at(-1)
          if (!graphs) throw new Error("Missing absolute publication")
          const gains = [...decodeGraph(graphs).processors.values()].filter(processor => processor.kind === 1)
            .map(processor => new DataView(processor.state.buffer, processor.state.byteOffset).getFloat32(4, true))
          expect(gains).toEqual([-9, -4])
          expect(sent.slice(blockedSends).map(bytes => new DataView(bytes.buffer).getFloat32(60, true))).not.toContain(-1)
        }
        step7Evidence(`W57-${lostReply}-${end}`, { first, newest, other, publication, sends: sent.length, prepares: prepares(fixture) })
      } finally { fixture.emitLoss("W57 cleanup"); await controller.dispose() }
    })
  }

  test("prepare-and-other-target-unsent-behind-claim: a prepare and another target's patch wait for the claim's resolution", async () => {
    const fixture = createBridge()
    const sent: Uint8Array[] = []
    fixture.bridge.session.queueProcessorStatePatch = async (bytes) => {
      sent.push(bytes)
      return { ok: true, outcome: "claimed", token: "7" }
    }
    let keepLatency = new Set(["track"])
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getKeepLatencyNodeIds: () => keepLatency,
      compileSnapshot: twoUtilities().compileSnapshot,
    })
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    void controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -3))).settled
    await turns()
    expect(sent).toHaveLength(1)
    const baseline = prepares(fixture)
    keepLatency = new Set()
    const published = watch(controller.updateKeepLatency())
    void controller.deliverProcessor(fixturePatchEdit(patchFor("utility:2", -4))).settled
    await turns()
    expect(prepares(fixture)).toBe(baseline)
    expect(sent).toHaveLength(1)
    expect(published.value).toBeUndefined()
    fixture.emitPatchResolution("7", 0)
    await turns()
    expect(prepares(fixture)).toBe(baseline + 1)
    expect(published.value).toEqual({ handled: true })
    await controller.dispose()
  })

  test("quiet-paused-parameter-refusal: two parameter sends, then one ladder patch, one notice, no prepare", async () => {
    const fixture = createBridge()
    const faults: unknown[][] = []
    const controller = quietController(fixture, faults)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    await primeParameterCarrier(fixture, controller);
    refusePatches(fixture)
    fixture.bridge.session.queueParameterEvents = async bytes => {
      fixture.builtInParameterPayloads.push(bytes);
      return { ok: false, kind: "refused", error: "no" };
    };
    const baseline = prepares(fixture)
    await controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled
    await turns()
    expect(fixture.builtInParameterPayloads).toHaveLength(2)
    expect(fixture.statePatchPayloads).toHaveLength(1)
    expect(faults).toHaveLength(1)
    expect(prepares(fixture)).toBe(baseline)
    await controller.dispose()
  })

  test("lost-then-refused-is-unconfirmed: a lost attempt followed by a refusal is not a refusal", async () => {
    const fixture = createBridge()
    const controller = quietController(fixture)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    await primeParameterCarrier(fixture, controller);
    // Bounded: a controller that retries without a limit must fail the assertion below, not hang the run.
    let attempts = 0
    fixture.bridge.session.queueParameterEvents = async (): Promise<NativeDeliveryReply> => {
      attempts += 1
      if (attempts === 1) throw new Error("The native audio host control request timed out.")
      return attempts > 6 ? { ok: true } : { ok: false, error: "no", kind: "refused" }
    }
    // Today a lost send is awaited with no deadline, so read the answer without awaiting it.
    const answer = watch(controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled)
    await turns()
    expect(answer.value).toMatchObject({ state: "unconfirmed" })
    await controller.dispose()
  })

  test("late-old-proof-after-newer-failure: a stale proof keeps the incident open and adds no notice", async () => {
    const fixture = createBridge("built-in-parameter")
    refusePatches(fixture)
    const faults: unknown[][] = []
    const controller = quietController(fixture, faults)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    await controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled
    await turns()
    expect(faults).toHaveLength(1)
    // Native reports an old applied sequence, then another edit fails: the incident is still the same one.
    fixture.emitScheduleProgress({
      revision: 1, epoch: 1, progressSequence: 900n, renderedThroughFrame: 0n, acceptedThroughFrame: 0n, lastAcceptedWindowId: 0n,
      appliedTransportTransitionId: 0n, appliedUrgentSequence: 0n, appliedProcessorSequence: 1n, running: false, scheduleComplete: false,
      instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    })
    await controller.deliverProcessor(fixtureParameterEdit(gainRequest(12, -4)), fixtureGesture(gainRequest(12, -4), false)).settled
    await turns()
    expect(faults).toHaveLength(1)
    await controller.dispose()
  })

  test("recovery-after-target-retirement: a retired target is unavailable and leaves the incident, which then closes", async () => {
    const fixture = createBridge()
    const faults: unknown[][] = []
    refusePatches(fixture)
    const state = createDefaultUtilityParams()
    const both = [
      { id: "utility:1", kind: "utility" as const, params: { version: 1 as const, state } },
      { id: "utility:2", kind: "utility" as const, params: { version: 1 as const, state } },
    ]
    let instances = both
    const base = utilityPlaybackInput()
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getProcessorTarget: (_nodeId, instanceId) => instances.some(instance => instance.id === instanceId) ? { kindId: 1, incarnation: 1 } : undefined,
      compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
        ...base, transport,
        renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { track: { instances } } } },
      }),
      reportFault: (...args: unknown[]) => { faults.push(args) },
    })
    await expect(controller.start(base.transport)).resolves.toBe("started")
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -1))).settled
    await turns()
    expect(faults).toHaveLength(1)
    instances = both.slice(1)
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-27")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

    acknowledgeStagedPublication(fixture)
    await expect((candidateCompile.release(), candidateAdoption)).resolves.toMatchObject({ status: "adopted" })
    await expect(controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -2))).settled).resolves.toMatchObject({ state: "unavailable" })
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:2", -3))).settled
    await turns()
    // The only failing target left the incident when it retired, so the incident closed: a new one notifies.
    expect(faults).toHaveLength(2)
    await controller.dispose()
  })

  test("unprepared-is-unavailable: nothing is registered or sent before the graph is prepared", async () => {
    const fixture = createBridge()
    const controller = quietController(fixture)
    await expect(controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled).resolves.toMatchObject({ state: "unavailable" })
    expect(fixture.builtInParameterPayloads).toHaveLength(0)
    expect(fixture.statePatchPayloads).toHaveLength(0)
    await controller.dispose()
  })

  test("configure-calls-real-callback: the desired projection is read with (configured snapshot, sample rate) after capture and start", async () => {
    const fixture = createBridge()
    const seen: Array<{ snapshotSeen: boolean; sampleRate: number }> = []
    const controller = createObservedController({
      bridge: fixture.bridge,
      compileSnapshot: async () => compileLivePlaybackSnapshot(utilityPlaybackInput()),
      getDesiredProcessorState: (snapshot, sampleRate) => {
        fixture.calls.push("desired-projection")
        seen.push({ snapshotSeen: snapshot.tracks.length > 0, sampleRate })
        return { sequence: 1, graph: { version: audioCoreContractVersion, revision: 1, contractHash: "", nodes: [], edges: [], masterNodeId: "master", assets: [] }, instruments: new Map() }
      },
    })
    await expect(controller.start(utilityPlaybackInput().transport)).resolves.toBe("started")
    // The projection after the session started is the configure ingest (C5); the one in a prepare precedes it.
    const afterStart = fixture.calls.slice(fixture.calls.indexOf("start")).includes("desired-projection")
    expect(afterStart).toBeTrue()
    expect(seen.every((entry) => entry.snapshotSeen && entry.sampleRate === 48_000)).toBeTrue()
    await controller.dispose()
  })

  test("configure-stale-start-ingests-nothing: a start superseded after the session started reads no desired projection", async () => {
    const fixture = createBridge()
    let projectId = "local_project"
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => projectId,
      compileSnapshot: async () => compileLivePlaybackSnapshot(utilityPlaybackInput()),
      getDesiredProcessorState: () => {
        fixture.calls.push("desired-projection")
        return { sequence: 1, graph: { version: audioCoreContractVersion, revision: 1, contractHash: "", nodes: [], edges: [], masterNodeId: "master", assets: [] }, instruments: new Map() }
      },
    })
    const setTransport = fixture.bridge.session.setTransport
    let transports = 0
    fixture.bridge.session.setTransport = async (...args) => {
      const reply = await setTransport(...args)
      // The second transport is the run command, the last step before the configure ingest.
      if (++transports === 2) projectId = "other_project"
      return reply
    }
    await expect(controller.start(utilityPlaybackInput().transport)).resolves.toBe("unavailable")
    expect(fixture.calls.slice(fixture.calls.indexOf("start")).includes("desired-projection")).toBeFalse()
    await controller.dispose()
  })

  test("configure-reconciles-edit-after-capture: content edited after the compile read its snapshot is sent once the session started", async () => {
    const fixture = createBridge()
    const base = utilityPlaybackInput()
    const edited = compileLivePlaybackSnapshot({ ...base, renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: {
      track: { instances: [{ id: "utility:1", kind: "utility", params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: -6 } } }] } } } } })
    if (!edited.supported) throw new Error("Missing edited snapshot")
    const projection = compileLiveNativeProjection({ tracks: edited.snapshot.tracks, bpm: 120, sampleRateHz: 48000, revision: 1, epoch: 1,
      firstSequence: 1, fx: edited.snapshot.mixer.fx })
    if (!projection.supported) throw new Error("Missing edited projection")
    const registry = createProcessorEditRegistry(() => 120)
    registry.observe(edited.snapshot.mixer.fx)
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getProcessorTarget: registry.target,
      compileSnapshot: async () => compileLivePlaybackSnapshot(base),
      getDesiredProcessorState: () => ({ sequence: 5, graph: projection.graph, instruments: new Map() }),
    })
    await expect(controller.start(base.transport)).resolves.toBe("started")
    await turns()
    expect(fixture.statePatchPayloads.length + fixture.builtInParameterPayloads.length).toBeGreaterThan(0)
    await controller.dispose()
  })

  test("preview-across-session-end-is-accepted: a preview whose send was out when the session ended is no rejection", async () => {
    const fixture = createBridge()
    const held = Promise.withResolvers<{ ok: true }>()
    const controller = quietController(fixture)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    fixture.bridge.session.queueParameterEvents = () => held.promise
    const answer = watch(Promise.resolve(controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -9)), fixtureGesture(gainRequest(11, -9), true)).settled))
    await turns()
    await controller.dispose()
    held.resolve({ ok: true })
    await turns()
    expect(answer.value).toMatchObject({ state: "applied" })
  })

  test("incident-aggregation: one notice per incident across targets; it closes only when every target recovered", async () => {
    const fixture = createBridge()
    const faults: unknown[][] = []
    refusePatches(fixture)
    const controller = createObservedController({
      bridge: fixture.bridge, compileSnapshot: twoUtilities().compileSnapshot,
      reportFault: (...args: unknown[]) => { faults.push(args) },
    })
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -1))).settled
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:2", -2))).settled
    await turns()
    // Two targets failed in one incident: one notice.
    expect(faults).toHaveLength(1)
    // The notice is sent when the first target joins; the second joins the same incident silently.
    expect(faults[0]?.[0]).toEqual({ kind: "delivery-refused", targets: 1 })
    expect(faults[0]?.[1]).toEqual({ retainPlayback: true })
    // One target recovers: the incident stays open and a further failure adds no notice.
    fixture.bridge.session.queueProcessorStatePatch = async () => appliedPatch
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -3))).settled
    refusePatches(fixture)
    await controller.deliverProcessor(fixturePatchEdit(patchFor("utility:1", -4))).settled
    await turns()
    expect(faults).toHaveLength(1)
    await controller.dispose()
  })

  test("typed-fault-forwarding: a delivery incident reaches reportFault as a typed fault with retainPlayback", async () => {
    const fixture = createBridge("built-in-parameter")
    refusePatches(fixture)
    const faults: unknown[][] = []
    const controller = quietController(fixture, faults)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    await controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled
    await turns()
    expect(faults[0]?.[0]).toMatchObject({ kind: "delivery-refused", targets: 1 })
    expect(faults[0]?.[1]).toEqual({ retainPlayback: true })
    await controller.dispose()
  })

  test("old-panel-no-duplicate: a refused delivery through the old panel entries sends once per the policy and notifies once", async () => {
    const fixture = createBridge("built-in-parameter")
    const faults: unknown[][] = []
    refusePatches(fixture)
    const controller = quietController(fixture, faults)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    const result = await controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled
    // The panel treats a refused answer as terminal: it must not send again, and the incident is the only notice.
    expect(result).toMatchObject({ state: "refused" })
    const sends = fixture.builtInParameterPayloads.length + fixture.statePatchPayloads.length
    await controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled
    await turns()
    expect(fixture.builtInParameterPayloads.length + fixture.statePatchPayloads.length).toBe(sends)
    expect(faults).toHaveLength(1)
    await controller.dispose()
  })

  test("equal-content-distinct-reservations: two requests for one content are two receipts, one dispatch, both applied", async () => {
    const fixture = createBridge()
    const controller = quietController(fixture)
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    await primeParameterCarrier(fixture, controller);
    const first = watch(controller.deliverProcessor(fixtureParameterEdit(gainRequest(11, -3)), fixtureGesture(gainRequest(11, -3), false)).settled)
    const second = watch(controller.deliverProcessor(fixtureParameterEdit(gainRequest(12, -3)), fixtureGesture(gainRequest(12, -3), false)).settled)
    await turns()
    // The edit ids differ and decide nothing: the second request joins the dispatch already carrying its content.
    expect(fixture.builtInParameterPayloads).toHaveLength(1)
    expect(first.value).toMatchObject({ state: "applied" })
    expect(second.value).toMatchObject({ state: "applied" })
    await controller.dispose()
  })

  const synthController = (fixture: ReturnType<typeof createBridge>, faults: unknown[][] = []) => createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...nativeInstrumentInput(), transport }),
    reportFault: (...args: unknown[]) => { faults.push(args) },
  })
  const synthRequest = (order: number, value: number) => ({
    instanceId: "synth:1", values: [{ parameterId: "synth.outputGain", value }],
    edit: { id: `synth-${order}`, order, target: { nodeId: "instrument", instanceId: "synth:1", kindId: 18, incarnation: 1 },
      content: { params: createDefaultSynthParams() } },
  })

  test("quiet-paused-urgent-refusal: two urgent sends, one notice, no prepare", async () => {
    const fixture = createBridge(undefined, false, true)
    const faults: unknown[][] = []
    const controller = synthController(fixture, faults)
    await expect(controller.start(nativeInstrumentInput().transport)).resolves.toBe("started")
    fixture.bridge.session.queueInstrumentEvents = async (bytes) => {
      fixture.instrumentPayloads.push(bytes)
      return { ok: false, error: "no", kind: "refused" }
    }
    const baseline = prepares(fixture)
    const sendsBefore = fixture.instrumentPayloads.length
    await controller.deliverProcessor(fixtureParameterEdit(synthRequest(11, 0.5)), fixtureGesture(synthRequest(11, 0.5), false)).settled
    await turns()
    expect(fixture.instrumentPayloads.length - sendsBefore).toBe(2)
    expect(faults).toHaveLength(1)
    expect(prepares(fixture)).toBe(baseline)
    await controller.dispose()
  })

  test("urgent-refusal-recovers: one retry from the completion applies the edit with no notice", async () => {
    const fixture = createBridge(undefined, false, true)
    const faults: unknown[][] = []
    const controller = synthController(fixture, faults)
    await expect(controller.start(nativeInstrumentInput().transport)).resolves.toBe("started")
    const queue = fixture.bridge.session.queueInstrumentEvents
    let refusals = 1
    fixture.bridge.session.queueInstrumentEvents = (bytes) => refusals-- > 0
      ? Promise.resolve<NativeDeliveryReply>({ ok: false, error: "no", kind: "refused" })
      : queue(bytes)
    const sendsBefore = fixture.instrumentPayloads.length
    await expect(controller.deliverProcessor(fixtureParameterEdit(synthRequest(11, 0.5)), fixtureGesture(synthRequest(11, 0.5), false)).settled).resolves.toMatchObject({ state: "applied" })
    expect(fixture.instrumentPayloads.length - sendsBefore).toBe(1)
    expect(faults).toEqual([])
    await controller.dispose()
  })
})

// DV01 boundary, round 2 (§1.2 rule 1, ruling M2-B decision b): a latency publication that fails is classified by the
// typed status of its prepare, publish or inspect reply, never by text. Only a definite refusal is `refused`; a session
// that is not available is `unavailable` (no incident); a lost or thrown reply is `unconfirmed`.
describe("DV01 publication failure classification", () => {
  const turns = async () => { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve() }
  const from = { ...createDefaultSpectralParams(), fftSize: 512 } satisfies ReturnType<typeof createDefaultSpectralParams>
  const queueLatencyPatch = (controller: ReturnType<typeof createNativePlaybackController>) => controller.deliverProcessor(fixturePatchEdit({
    bpm: 120, payload: {
      effect: "spectral", instanceId: "spectral:1", targetId: "track",
      from: { version: 1, state: from }, to: { version: 1, state: { ...from, fftSize: 4096 } },
    },
  })).settled
  const startLatencyController = async (faults: unknown[][]) => {
    const fixture = createBridge("runtime-revision-progress")
    const snapshotInput: LivePlaybackSnapshotInput = {
      ...input(), tracks: [sourceTrack(), { ...sourceTrack(), id: "parallel", clips: [] }], renderState: { fx: { masterVolume: 1, masterFxInstances: [],
        trackFx: { track: { instances: [{ id: "spectral:1", kind: "spectral", params: { version: 1, state: from } }] } } },
        automationEnvelopes: [] },
    }
    const controller = createObservedController({
      bridge: fixture.bridge, getProjectId: () => "local_project",
      getKeepLatencyNodeIds: () => new Set(["track"]),
      compileSnapshot: async () => compileLivePlaybackSnapshot(snapshotInput),
      reportFault: (...args: unknown[]) => { faults.push(args) },
    })
    await expect(controller.ensureLivePreview(0)).resolves.toBe("started")
    return { fixture, controller }
  }

  test("publication-refused-is-refused: a refused prepare refuses the folded patch and notifies once", async () => {
    const faults: unknown[][] = []
    const { fixture, controller } = await startLatencyController(faults)
    fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "any text", kind: "refused" })
    await expect(queueLatencyPatch(controller)).resolves.toMatchObject({ state: "refused" })
    await turns()
    expect(faults).toHaveLength(1)
    expect(faults[0]?.[0]).toMatchObject({ kind: "delivery-refused" })
    await controller.dispose()
  })

  test("publication-unavailable-is-unavailable: an unavailable session is not a refusal and raises no notice", async () => {
    const faults: unknown[][] = []
    const { fixture, controller } = await startLatencyController(faults)
    fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "The native audio session is unavailable.", kind: "unavailable" })
    await expect(queueLatencyPatch(controller)).resolves.toMatchObject({ state: "unavailable" })
    await turns()
    expect(faults).toEqual([])
    await controller.dispose()
  })

  test("publication-text-never-classifies: the same text with a different kind is classified by the kind", async () => {
    const faults: unknown[][] = []
    const { fixture, controller } = await startLatencyController(faults)
    fixture.bridge.session.revisions.prepare = async () => ({ ok: false, error: "The native audio host refused the request.", kind: "unavailable" })
    await expect(queueLatencyPatch(controller)).resolves.toMatchObject({ state: "unavailable" })
    expect(faults).toEqual([])
    await controller.dispose()
  })

  test("publication-retire-failure-keeps-applied: native published the graph, so a failed retirement does not unapply the patch", async () => {
    const faults: unknown[][] = []
    const { fixture, controller } = await startLatencyController(faults)
    const retire = fixture.bridge.session.revisions.retire
    fixture.bridge.session.revisions.retire = async (request) => {
      await retire(request)
      return { ok: false, error: "The native audio session is unavailable.", kind: "unavailable" }
    }
    await expect(queueLatencyPatch(controller)).resolves.toMatchObject({ state: "applied" })
    await turns()
    expect(faults).toEqual([])
    await controller.dispose()
  })

  for (const lost of ["thrown", "typed"]) {
    test(`publication-unconfirmed-is-unconfirmed: a ${lost} prepare reply is unconfirmed and notifies once`, async () => {
      const faults: unknown[][] = []
      const { fixture, controller } = await startLatencyController(faults)
      fixture.bridge.session.revisions.prepare = lost === "thrown"
        ? async () => { throw new Error("The native audio host control request timed out.") }
        : async () => ({ ok: false, error: "timed out", kind: "unconfirmed" })
      await expect(queueLatencyPatch(controller)).resolves.toMatchObject({ state: "unconfirmed" })
      await turns()
      expect(faults).toHaveLength(1)
      expect(faults[0]?.[0]).toMatchObject({ kind: "delivery-unconfirmed" })
      await controller.dispose()
    })
  }
})

test("seek resends once after a claimed publication retires", async () => {
  const fixture = createBridge("runtime-revision-progress")
  let desired = nativeInstrumentInput()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
  })
  const publishEntered = Promise.withResolvers<void>()
  const refusalReturned = Promise.withResolvers<void>()
  let published = false
  let transportRefused = false
  let before = 0
  let transportCount = 0
  const sendTransport = fixture.bridge.session.setTransport
  try {
    await expect(controller.start(desired.transport)).resolves.toBe("started")
    before = fixture.calls.length
    transportCount = fixture.transports.length
    desired = { ...desired, tracks: [{
      ...instrumentTrack, clips: instrumentTrack.clips.map((clip) => ({ ...clip, duration: 30 })),
    }] }
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-28")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))


    acknowledgeStagedPublication(fixture)
    fixture.bridge.session.revisions.publish = async () => {
      publishEntered.resolve()
      return fixture.revisionReply("publish-pending")
    }
    fixture.bridge.session.revisions.inspect = async () =>
      fixture.revisionReply(published ? "published" : "publish-pending")
    fixture.bridge.session.revisions.rollback = async () => fixture.revisionReply("publish-pending")
    fixture.bridge.session.setTransport = async (transport) => {
      if (!transport.running && transport.epoch > 1 && !transportRefused) {
        transportRefused = true
        refusalReturned.resolve()
        return { ok: false, error: "publication callback owns the revision", kind: "refused" }
      }
      return sendTransport(transport)
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await publishEntered.promise
    const seek = controller.seekPrepared(0)
    await refusalReturned.promise
    published = true
    fixture.emitScheduleProgress({
      revision: 2, epoch: fixture.transportContexts.at(-1)?.epoch ?? 2, progressSequence: 100n,
      renderedThroughFrame: 0n, acceptedThroughFrame: 0n, lastAcceptedWindowId: 0n,
      appliedTransportTransitionId: 0n, appliedUrgentSequence: 0n, appliedProcessorSequence: 0n,
      running: false, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    })
    await expect(seek).resolves.toBe("started")
    await publication
    expect(fixture.transports.length).toBe(transportCount + 2)
    expect(fixture.calls.slice(before)).not.toContain("stop")
    expect(fixture.calls.slice(before)).not.toContain("teardown")
    expect(controller.isPrepared()).toBeTrue()
    expect(controller.isActive()).toBeTrue()
  } finally {
    await controller.dispose()
  }
})

test("seek does not retry a refusal without a deferred publication", async () => {
  const fixture = createBridge()
  const controller = createObservedController({
    bridge: fixture.bridge,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(), transport }),
  })
  await expect(controller.start(input().transport)).resolves.toBe("started")
  let refusals = 0
  const sendTransport = fixture.bridge.session.setTransport
  fixture.bridge.session.setTransport = async (transport) => {
    if (!transport.running && transport.epoch > 1) {
      refusals += 1
      return { ok: false, error: "ordinary transport refusal", kind: "refused" }
    }
    return sendTransport(transport)
  }
  await expect(controller.seekPrepared(0.25)).rejects.toThrow("ordinary transport refusal")
  expect(refusals).toBe(1)
  await controller.dispose()
})

test("seek loss during the publication wait ends without a resend", async () => {
  const fixture = createBridge("runtime-revision-progress")
  let desired = nativeInstrumentInput()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
  })
  const publishEntered = Promise.withResolvers<void>()
  const refusalReturned = Promise.withResolvers<void>()
  let transportRefused = false
  let transportAttempts = 0
  const sendTransport = fixture.bridge.session.setTransport
  try {
    await expect(controller.start(desired.transport)).resolves.toBe("started")
    desired = { ...desired, tracks: [{
      ...instrumentTrack, clips: instrumentTrack.clips.map((clip) => ({ ...clip, duration: 30 })),
    }] }
    const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-29")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))


    acknowledgeStagedPublication(fixture)
    fixture.bridge.session.revisions.publish = async () => {
      publishEntered.resolve()
      return fixture.revisionReply("publish-pending")
    }
    fixture.bridge.session.revisions.inspect = async () => fixture.revisionReply("publish-pending")
    fixture.bridge.session.revisions.rollback = async () => fixture.revisionReply("publish-pending")
    fixture.bridge.session.setTransport = async (transport) => {
      transportAttempts += 1
      if (!transport.running && transport.epoch > 1 && !transportRefused) {
        transportRefused = true
        refusalReturned.resolve()
        return { ok: false, error: "publication callback owns the revision", kind: "refused" }
      }
      return sendTransport(transport)
    }
    const publication = (candidateCompile.release(), candidateAdoption)
    await publishEntered.promise
    const seek = controller.seekPrepared(0)
    await refusalReturned.promise
    fixture.emitLoss("Native playback host connection was lost.")
    await expect(seek).resolves.not.toBe("started")
    expect(transportAttempts).toBe(1)
    await publication.catch(() => undefined)
  } finally {
    await controller.dispose()
  }
})

for (const end of ["loss", "dispose"]) {
  for (const status of ["published", "publish-pending"]) {
    test(`seek ${end} while the handoff inspect returns ${status} ends without a resend`, async () => {
      const fixture = createBridge("runtime-revision-progress")
      let desired = nativeInstrumentInput()
      const controller = createObservedController({
        bridge: fixture.bridge, getProjectId: () => "local_project",
        compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...desired, transport }),
      })
      const publishEntered = Promise.withResolvers<void>()
      const inspectEntered = Promise.withResolvers<void>()
      const releaseInspect = Promise.withResolvers<void>()
      let transportRefused = false
      let transportAttempts = 0
      let disposing: Promise<void> | undefined
      const sendTransport = fixture.bridge.session.setTransport
      try {
        await expect(controller.start(desired.transport)).resolves.toBe("started")
        desired = { ...desired, tracks: [{
          ...instrumentTrack, clips: instrumentTrack.clips.map((clip) => ({ ...clip, duration: 30 })),
        }] }
        const candidateCompile = holdCompile(controller)
    const candidateIntent = migrationIntent("migration-30")
    const candidateAdoption = controller.adoptSchedule(candidateIntent, true)
    const candidateCompilation = await candidateCompile.entered
    if (!candidateCompilation.supported) throw new Error(candidateCompilation.reasons.join("; "))

        acknowledgeStagedPublication(fixture)
        fixture.bridge.session.revisions.publish = async () => {
          publishEntered.resolve()
          return fixture.revisionReply("publish-pending")
        }
        fixture.bridge.session.revisions.inspect = async () => {
          if (!transportRefused) return fixture.revisionReply("publish-pending")
          inspectEntered.resolve()
          await releaseInspect.promise
          return fixture.revisionReply(status === "published" ? "published" : "publish-pending")
        }
        fixture.bridge.session.revisions.rollback = async () => fixture.revisionReply("publish-pending")
        fixture.bridge.session.setTransport = async (transport) => {
          transportAttempts += 1
          if (!transport.running && transport.epoch > 1 && !transportRefused) {
            transportRefused = true
            return { ok: false, error: "publication callback owns the revision", kind: "refused" }
          }
          return sendTransport(transport)
        }
        const publication = (candidateCompile.release(), candidateAdoption)
        await publishEntered.promise
        const seek = controller.seekPrepared(0)
        await inspectEntered.promise
        if (end === "loss") fixture.emitLoss("Native playback host connection was lost.")
        else disposing = controller.dispose()
        releaseInspect.resolve()
        await expect(seek).resolves.not.toBe("started")
        expect(transportAttempts).toBe(1)
        await publication.catch(() => undefined)
      } finally {
        await disposing
        await controller.dispose()
      }
    })
  }
}

for (const latencyPending of [false, true]) test(`STEP7B4 reader-check/reply race ${latencyPending ? "bounds latency frame retries" : "does not strand retirement"}`, async () => {
  const fixture = createBridge("runtime-revision-progress")
  const retire = fixture.bridge.session.revisions.retire
  let attempts = 0
  fixture.bridge.session.revisions.retire = async request => {
    attempts++
    if (attempts > (latencyPending ? 3 : 2)) return retire(request)
    const reply = fixture.revisionReply("retirement-not-safe")
    if (!reply.ok) return reply
    // The callback completes between native's reader check and reply load
    // (audio-host.cpp:3174, 3194), so the first crossing can still be reader-blocked.
    return { ...reply, revision: { ...reply.revision,
      transportEpoch: fixture.transports.at(-1)?.epoch ?? 1,
      renderEpoch: attempts === 1 ? 10n : 11n,
      progressFrame: attempts === 1 ? 0n : 512n } }
  }
  let desired = new Set<string>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => desired,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  try {
    expect(await controller.start({ ...input().transport, state: "playing" })).toBe("started")
    expect(controller.isActive()).toBe(true)
    desired = new Set(["track"])
    await expect(controller.updateKeepLatency()).resolves.toEqual({ handled: true })
    await step7Turns()
    expect(attempts).toBe(1)
    const progress: NativeScheduleProgress = {
      revision: 2, epoch: fixture.transports.at(-1)?.epoch ?? 1,
      progressSequence: 100n, renderedThroughFrame: 512n,
      acceptedThroughFrame: 8192n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
      appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: true,
      scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    }
    fixture.emitScheduleProgress(progress)
    await step7Turns()
    expect(attempts).toBe(2)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 101n })
    await step7Turns()
    expect(attempts).toBe(2)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 102n, renderedThroughFrame: 1024n })
    await step7Turns()
    expect(attempts).toBe(3)
    for (let index = 1; index < 21; index++) {
      fixture.emitScheduleProgress({ ...progress, progressSequence: 102n + BigInt(index),
        renderedThroughFrame: 1024n + BigInt(index * 512) })
      await step7Turns()
    }
    expect(attempts).toBe(3)
    if (latencyPending) {
      fixture.emitScheduleProgress({ ...progress, progressSequence: 123n, renderedThroughFrame: 12288n,
        latencyCompletionGeneration: 1n })
      await step7Turns()
      expect(attempts).toBe(4)
    }
  } finally { await controller.dispose() }
})

test("STEP7B3 not-safe retirement re-arms a passed reader boundary", async () => {
  const fixture = createBridge()
  const retire = fixture.bridge.session.revisions.retire
  let attempts = 0
  fixture.bridge.session.revisions.retire = async request => {
    attempts++
    if (attempts > 4) return retire(request)
    const reply = fixture.revisionReply("retirement-not-safe")
    if (!reply.ok) return reply
    return { ...reply, revision: { ...reply.revision, transportEpoch: 1,
      renderEpoch: attempts >= 3 ? 11n : 10n,
      progressFrame: attempts === 1 ? 0n : attempts === 2 ? 2048n : attempts === 3 ? 2560n : 3072n } }
  }
  let desired = new Set<string>()
  const controller = createObservedController({
    bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => desired,
    compileSnapshot: async () => compileLivePlaybackSnapshot(input()),
  })
  try {
    await controller.ensureLivePreview(0)
    desired = new Set(["track"])
    await expect(controller.updateKeepLatency()).resolves.toEqual({ handled: true })
    await step7Turns()
    expect(attempts).toBe(1)
    const progress: NativeScheduleProgress = {
      revision: 2, epoch: 1, progressSequence: 100n, renderedThroughFrame: 2048n,
      acceptedThroughFrame: 8192n, lastAcceptedWindowId: 1n, appliedTransportTransitionId: 1n,
      appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: false,
      scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
    }
    fixture.emitScheduleProgress(progress)
    await step7Turns()
    expect(attempts).toBe(2)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 101n })
    await step7Turns()
    expect(attempts).toBe(2)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 102n, renderedThroughFrame: 2560n })
    await step7Turns()
    expect(attempts).toBe(3)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 103n, renderedThroughFrame: 3072n })
    await step7Turns()
    expect(attempts).toBe(4)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 104n, renderedThroughFrame: 3584n,
      latencyCompletionGeneration: 1n })
    await step7Turns()
    expect(attempts).toBe(5)
    fixture.emitScheduleProgress({ ...progress, progressSequence: 105n, renderedThroughFrame: 4096n,
      latencyCompletionGeneration: 1n })
    await step7Turns()
    expect(attempts).toBe(5)
  } finally { await controller.dispose() }
})

test("STEP7B3 retirement readiness survives seek epoch", async () => {
  const f = await step7Host()
  try {
    await f.act({ kind: "sample", value: 1 })
    await f.act({ kind: "submit-schedule", mode: "asset" }); await f.advance()
    const predecessor = f.fixture.state().activeRevision
    await f.act({ kind: "sample", value: 0 })
    await f.act({ kind: "submit-schedule", mode: "remove" })
    await f.until(() => f.fixture.state().activeRevision !== predecessor)
    await f.act({ kind: "deliver-progress" })
    await f.controls()
    const before = f.fixture.state()
    step7Evidence("STEP7B3-RETIRE-SEEK-BEFORE", before)
    expect(before.retiredRevision).toBe(predecessor)
    expect(before.leases.every(lease => !lease.reclaimed)).toBe(true)
    expect(before.waiters.every(waiter => waiter.settled)).toBe(true)
    await f.act({ kind: "seek", value: 0 })
    await f.advance()
    for (let index = 0; index < 20; index++) {
      await f.act({ kind: "render-block" }); await f.act({ kind: "deliver-progress" }); await f.controls()
    }
    await f.act({ kind: "reclaim" })
    const after = f.fixture.state()
    step7Evidence("STEP7B3-RETIRE-SEEK-AFTER", after)
    expect(after.retiredRevision).toBeUndefined()
    expect(after.counts.retire).toBe((before.counts.retire ?? 0) + 1)
    expect(after.assets).toEqual([])
    expect(after.leases.every(lease => lease.reclaimed && lease.releases === 1)).toBe(true)
    await f.act({ kind: "deliver-progress" })
    await f.controls()
    expect(f.fixture.state().counts.retire).toBe(after.counts.retire)
  } finally { await f.close() }
})

// C0f item 1: a staged live publication binds native's runtime revision to the prepared graph only. The prepared
// snapshot keeps the renderer's compile revision, so the next Play resumes the paused graph instead of rebuilding it.
test("C0F Pause then Play after a staged live publication resumes the paused graph warm", async () => {
  const fixture = createBridge("runtime-revision-progress")
  const base = nativeInstrumentInput()
  const compiledRevisions: number[] = []
  const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
    compileSnapshot: async (transport) => {
      const compiled = compileLivePlaybackSnapshot({ ...base, transport })
      if (compiled.supported) compiledRevisions.push(compiled.snapshot.revision)
      return compiled
    } })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    acknowledgeStagedPublication(fixture)
    expect(await controller.adoptSchedule(migrationIntent("c0f-staged"), true)).toEqual({ status: "adopted" })
    expect(fixture.calls).toContain("stage-prepare")
    await controller.pause(1)
    const mark = fixture.calls.length
    const resumed = controller.start({ ...base.transport, playheadSec: 1 })
    await step7Turns()
    expect(fixture.calls.slice(mark).filter((call) =>
      ["stop", "teardown", "begin", "configure", "graph", "commit", "start"].includes(call))).toEqual([])
    expect(await resumed).toBe("started")
    expect(fixture.calls.slice(mark)).toEqual(["transport"])
    expect(new Set(compiledRevisions)).toEqual(new Set([base.revision ?? 1]))
  } finally { await controller.dispose() }
})

// C0g F1: Timeline's rebuild request bumps the renderer's compile revision before anything publishes
// (rebuildPlaybackBackend). When its adoption finds the prepared content unchanged, Pause then Play must still resume
// the paused graph. A content change while paused at a newer revision still prepares.
const c0gResume = async (options: { bump: boolean; pausedEdit: boolean }) => {
  const fixture = createBridge("runtime-revision-progress")
  const base = nativeInstrumentInput()
  let revision = base.revision ?? 1
  let tracks = base.tracks
  const compiledRevisions: number[] = []
  const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
    fingerprintSnapshot: (snapshot) => JSON.stringify({ ...snapshot, revision: undefined, processorStateSequence: undefined,
      transport: { ...snapshot.transport, playheadSec: undefined, state: undefined } }),
    compileSnapshot: async (transport) => {
      const compiled = compileLivePlaybackSnapshot({ ...base, revision, transport, tracks })
      if (compiled.supported) compiledRevisions.push(compiled.snapshot.revision)
      return compiled
    } })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    acknowledgeStagedPublication(fixture)
    tracks = [...base.tracks, { id: "c0g-added", name: "Added", volume: 1, clips: [] }]
    const staged = await controller.adoptSchedule(migrationIntent("c0g-staged"), true)
    if (options.bump) revision += 1
    const explicit = await controller.adoptSchedule(migrationIntent("c0g-explicit"), true)
    await controller.pause(1)
    if (options.pausedEdit) {
      revision += 1
      tracks = [...tracks, { id: "c0g-paused", name: "Paused", volume: 1, clips: [] }]
      // The fixture's progress reports the runtime revision it is given; the prepared graph carries the compile revision.
      fixture.setRuntimeRevision(revision)
    }
    const mark = fixture.calls.length
    const resumed = controller.start({ ...base.transport, playheadSec: 1 })
    await step7Turns()
    const after = fixture.calls.slice(mark)
    return { staged, explicit, result: await resumed, after, compiledRevisions }
  } finally { await controller.dispose() }
}
const c0gCold = ["stop", "teardown", "begin", "configure", "graph", "commit", "start"]

test("C0G Pause then Play after an unchanged adoption at a newer compile revision resumes the paused graph warm", async () => {
  const outcome = await c0gResume({ bump: true, pausedEdit: false })
  console.log("C0G-F1-CT", JSON.stringify(outcome))
  expect({ staged: outcome.staged, explicit: outcome.explicit, result: outcome.result,
    cold: outcome.after.filter((call) => c0gCold.includes(call)), after: outcome.after, revisions: [...new Set(outcome.compiledRevisions)] })
    .toEqual({ staged: { status: "adopted" }, explicit: { status: "unchanged" }, result: "started", cold: [], after: ["transport"],
      revisions: [1, 2] })
})

test("C0G Pause then Play after an unchanged adoption at the same compile revision resumes warm (control)", async () => {
  const outcome = await c0gResume({ bump: false, pausedEdit: false })
  console.log("C0G-F1-CT-A3", JSON.stringify(outcome))
  expect({ explicit: outcome.explicit, result: outcome.result, after: outcome.after, revisions: [...new Set(outcome.compiledRevisions)] })
    .toEqual({ explicit: { status: "unchanged" }, result: "started", after: ["transport"], revisions: [1] })
})

test("C0G a content change while paused after an unchanged adoption still prepares", async () => {
  const outcome = await c0gResume({ bump: true, pausedEdit: true })
  console.log("C0G-F1-CT-PAUSED-EDIT", JSON.stringify(outcome))
  expect({ explicit: outcome.explicit, result: outcome.result, cold: outcome.after.filter((call) => c0gCold.includes(call)),
    revisions: [...new Set(outcome.compiledRevisions)] })
    .toEqual({ explicit: { status: "unchanged" }, result: "started", cold: c0gCold, revisions: [1, 2, 3] })
})

// A latency record captures its snapshot before an `unchanged` adoption raises the compile revision; its proof lands after
// the adoption. The proof's snapshot write must not move the prepared revision back.
test("C0G Pause then Play after a latency proof that lands behind an unchanged adoption at a newer revision resumes warm", async () => {
  const fixture = createBridge("runtime-revision-progress")
  const base = { ...input(), tracks: [sourceTrack(), { ...sourceTrack(), id: "parallel", clips: [] }] }
  let revision = base.revision ?? 1
  const gate = Promise.withResolvers<void>()
  const publish = fixture.bridge.session.revisions.publish
  fixture.bridge.session.revisions.publish = async (request) => { await gate.promise; return publish(request) }
  const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
    fingerprintSnapshot: (snapshot) => JSON.stringify({ ...snapshot, revision: undefined, processorStateSequence: undefined,
      transport: { ...snapshot.transport, playheadSec: undefined, state: undefined } }),
    compileSnapshot: async (transport) => {
      const compiled = compileLivePlaybackSnapshot({ ...base, revision, transport })
      return compiled.supported
        ? { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: nativeAttachmentPlan } } : compiled
    } })
  try {
    expect(await controller.start(base.transport)).toBe("started")
    const instanceId = nativeAttachmentPlan.attachments[0]?.instanceId
    const generation = instanceId === undefined ? undefined : controller.attachmentGeneration(instanceId)
    if (instanceId === undefined || generation === undefined) throw new Error("Missing attachment")
    const latency = controller.publishAttachmentLatency({ instanceId, generation, latencyFrames: 2048 })
    await step7Turns()
    revision += 1
    expect(await controller.adoptSchedule(migrationIntent("latency-behind-unchanged"), true)).toEqual({ status: "unchanged" })
    gate.resolve()
    expect(await latency).toEqual({ handled: true })
    await controller.pause(1)
    const mark = fixture.calls.length
    const resumed = controller.start({ ...base.transport, playheadSec: 1 })
    await step7Turns()
    const cold = fixture.calls.slice(mark).filter((call) => c0gCold.includes(call))
    expect(await resumed).toBe("started")
    expect(cold).toEqual([])
  } finally { gate.resolve(); await controller.dispose() }
})

// C0h: Chromium's AudioBuffer is a platform object that structuredClone refuses ("AudioBuffer object could not be
// cloned"). Bun clones a class instance as a plain object, so an own function property stands in for that refusal.
class C0hUncloneableAudioBuffer extends TestAudioBuffer {
  readonly platformObject = () => undefined
}
const c0hLatencyPreview = () => {
  const fixture = createBridge("runtime-revision-progress")
  let keep = new Set<string>()
  const faults: NativePlaybackFault[] = []
  const track = { ...sourceTrack(), clips: sourceTrack().clips.map((clip) => ({ ...clip, buffer: new C0hUncloneableAudioBuffer() })) }
  const controller = createObservedController({ bridge: fixture.bridge, getProjectId: () => "local_project",
    getKeepLatencyNodeIds: () => keep, reportFault: (fault) => { faults.push(fault) },
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ ...input(track), transport }) })
  return { fixture, controller, faults, arm: () => { keep = new Set(["track"]) },
    close: async () => { fixture.emitLoss("C0H cleanup"); await controller.dispose() } }
}

test("C0H the clip buffer stand-in is refused by structuredClone where the plain test buffer is not", () => {
  expect(() => structuredClone(new TestAudioBuffer())).not.toThrow()
  expect(() => structuredClone(new C0hUncloneableAudioBuffer())).toThrow()
})

test("C0H a Keep Latency change on a prepared preview with a buffered clip publishes", async () => {
  const f = c0hLatencyPreview()
  try {
    expect(await f.controller.ensureLivePreview(0)).toBe("started")
    const mark = f.fixture.calls.length
    f.arm()
    const result = await f.controller.updateKeepLatency()
    console.log("C0H-KEEP-PREPARED", JSON.stringify({ result, calls: f.fixture.calls.slice(mark), faults: f.faults }))
    expect(result).toEqual({ handled: true })
    expect(f.fixture.calls.slice(mark)).toContain("revision-publish")
    expect(f.faults).toEqual([])
  } finally { await f.close() }
})

// C0e: the record-arm right after the reload lands while the paused preview starts, after its graph published with
// the old membership and before its post-prime Keep Latency update.
test("C0H a Keep Latency change landing while a preview with a buffered clip starts does not fail the start", async () => {
  const f = c0hLatencyPreview()
  const start = f.fixture.bridge.session.start
  f.fixture.bridge.session.start = () => { f.arm(); return start() }
  try {
    const result = await f.controller.ensureLivePreview(0)
    console.log("C0H-KEEP-START", JSON.stringify({ result, calls: f.fixture.calls, faults: f.faults }))
    expect(result).toBe("started")
    expect(f.fixture.calls.slice(f.fixture.calls.indexOf("start"))).toContain("revision-publish")
    expect(f.faults).toEqual([])
  } finally { await f.close() }
})

describe("LAT1 late seam binding", () => {
  type Lat1Fixture = Awaited<ReturnType<typeof step7LatencyFixture>>
  type Lat1Native = { progress: bigint; seam: bigint; status: NativeGraphRevisionStatus["status"]; epoch: number
    progressAt: (seam: bigint) => bigint; misses: number; advanceOnBind: bigint; refuseBinds: number; passSeamAfterBind: boolean; confirmSeam: boolean }
  type Lat1Event = { kind: "prepare" | "inspect" | "publish"; frame?: bigint; armed?: boolean; progress: bigint; windows: number }
  // A fake native that applies the rebase and seam rules of audio-host.cpp PublishGraphRevision.
  const lat1Host = (f: Lat1Fixture, blockFrames: bigint) => {
    const events: Lat1Event[] = []
    const native: Lat1Native = {
      progress: 0n, seam: 0n, status: "prepared", epoch: 1, progressAt: seam => seam - 15n * blockFrames,
      misses: 0, advanceOnBind: 0n, refuseBinds: 0, passSeamAfterBind: false, confirmSeam: true }
    const reply = (status = native.status): NativeRevisionReply => ({ ok: true, hostPid: 123, hostGeneration: 7,
      revision: { status, continuity: "accepted", requestedRevision: 2, activeRevision: status === "published" ? 2 : 1,
        preparedRevision: status === "published" ? 0 : 2, retiredRevision: 0, renderEpoch: 1n, transportEpoch: native.epoch,
        publicationFrame: status === "published" ? native.seam : 0n, requestedPublicationFrame: native.confirmSeam ? native.seam : 0n,
        progressFrame: native.progress } })
    const note = (kind: Lat1Event["kind"], frame?: bigint, armed?: boolean) =>
      events.push({ kind, frame, armed, progress: native.progress, windows: f.fixture.schedulePayloads.length })
    const revisions = f.fixture.bridge.session.revisions
    const prepare = revisions.prepare
    revisions.prepare = async request => {
      if (request.requestedPublicationFrame !== undefined) {
        native.seam = request.requestedPublicationFrame
        native.progress = native.progressAt(native.seam)
      }
      note("prepare", request.requestedPublicationFrame)
      await prepare(request)
      native.status = "prepared"
      return reply()
    }
    revisions.publish = async request => {
      const frame = request.requestedPublicationFrame
      if (frame === undefined) { note("publish"); native.status = "published"; return reply() }
      const armed = frame === native.seam
      note("publish", frame, armed)
      if (!armed) {
        // A bind native refuses as stale: progress moved on by one block, the bank keeps its seam.
        if (native.refuseBinds > 0) { native.refuseBinds--; native.progress += blockFrames; return reply("invalid-revision") }
        native.progress += native.advanceOnBind
        native.advanceOnBind = 0n
        if (frame <= native.progress || (frame - native.progress) % blockFrames !== 0n) return reply("invalid-revision")
        native.seam = frame
        native.status = "prepared"
        // A slow renderer or IPC: native plays through the bound seam before the armed Publish arrives.
        if (native.passSeamAfterBind) { native.passSeamAfterBind = false; native.progress = frame }
        return reply()
      }
      if (native.misses > 0) { native.misses--; native.progress = native.seam }
      native.status = native.seam <= native.progress ? "rebase-required" : "publish-pending"
      return reply()
    }
    revisions.inspect = async () => { note("inspect"); return reply() }
    return { events, native, publishes: () => events.filter(event => event.kind === "publish") }
  }
  const lat1Run = async (blockFrames = 512, sampleRateHz = 48_000) => {
    const f = await step7LatencyFixture(false, sampleRateHz, blockFrames)
    const host = lat1Host(f, BigInt(blockFrames))
    await f.controller.start(input().transport)
    host.events.length = 0
    return { f, ...host }
  }
  let lat1Sequence = 900
  const lat1Pump = async (f: Lat1Fixture, count: number) => {
    for (let index = 0; index < count; index++) { f.progress(lat1Sequence++); await step7Turns() }
  }
  const stagedHeaders = (f: Lat1Fixture, from: number) => f.fixture.schedulePayloads.slice(from)
    .filter(bytes => new DataView(bytes.buffer).getUint32(60, true) === 2)
    .map(bytes => new DataView(bytes.buffer).getBigUint64(16, true))
  const rollbacks = (f: Lat1Fixture) => f.fixture.calls.filter(call => call === "revision-rollback").length

  test("LAT1 1: a bind at the provisional seam is skipped and never arms the Publish early", async () => {
    const h = await lat1Run()
    h.native.progressAt = seam => seam - 3n * 512n
    step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-1")))
    try {
      await step7Turns()
      expect(h.events.map(event => event.kind).slice(0, 3)).toEqual(["prepare", "inspect", "publish"])
      expect(h.publishes().map(event => [event.frame, event.armed])).toEqual([[h.events[0]?.frame, true]])
    } finally { await h.f.close() }
  })

  test("LAT1 4, 8, 13: the seam binds to fresh native progress plus 3 blocks, after hydration and before any staging", async () => {
    const h = await lat1Run()
    step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-4")))
    try {
      await step7Turns()
      const prepare = h.events[0]
      const bind = h.publishes()[0]
      expect(h.events.map(event => event.kind).slice(0, 3)).toEqual(["prepare", "inspect", "publish"])
      expect(bind?.armed).toBe(false)
      const bound = bind?.frame ?? 0n
      expect(bound).toBe((prepare?.progress ?? 0n) + 3n * 512n)
      expect(bind?.windows).toBe(prepare?.windows)
      const headers = stagedHeaders(h.f, prepare?.windows ?? 0)
      expect(headers.length).toBeGreaterThan(0)
      expect(new Set(headers)).toEqual(new Set([bound]))
      expect(h.publishes().map(event => [event.frame, event.armed])).toEqual([[bound, false], [bound, true]])
    } finally { await h.f.close() }
  })

  test("LAT1 2: a bind refused for stale progress re-inspects and rebinds without failing", async () => {
    const h = await lat1Run()
    h.native.advanceOnBind = 10n * 512n
    const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-2")))
    try {
      await step7Turns()
      const progress = h.events[0]?.progress ?? 0n
      expect(h.events.map(event => event.kind).slice(0, 5)).toEqual(["prepare", "inspect", "publish", "inspect", "publish"])
      expect(h.publishes().map(event => [event.frame, event.armed])).toEqual([
        [progress + 3n * 512n, false], [progress + 13n * 512n, false], [progress + 13n * 512n, true]])
      expect(answer.answers).toBe(0)
      expect(rollbacks(h.f)).toBe(0)
    } finally { await h.f.close() }
  })

  test("LAT1 2: a host that does not confirm the provisional seam gets no bind", async () => {
    const h = await lat1Run()
    h.native.confirmSeam = false
    step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-2-confirm")))
    try {
      await step7Turns()
      expect(h.events.map(event => event.kind).slice(0, 3)).toEqual(["prepare", "inspect", "publish"])
      expect(h.publishes().map(event => [event.frame, event.armed])).toEqual([[h.events[0]?.frame, true]])
    } finally { await h.f.close() }
  })

  test("LAT1 3: the bind leaves the publication withdrawable", async () => {
    const h = await lat1Run()
    const gate = Promise.withResolvers<void>()
    const queue = h.f.fixture.bridge.session.queueScheduleWindow
    h.f.fixture.bridge.session.queueScheduleWindow = async bytes => {
      if (new DataView(bytes.buffer).getUint32(60, true) === 2) await gate.promise
      return queue(bytes)
    }
    const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-3")))
    try {
      await step7Turns()
      expect(h.publishes().map(event => event.armed)).toEqual([false])
      void h.f.controller.seekPrepared(0)
      await step7Turns()
      expect(answer.value?.status).toBe("superseded")
      expect(h.publishes().map(event => event.armed)).toEqual([false])
    } finally { gate.resolve(); await h.f.close() }
  })

  type Lat1Run = Awaited<ReturnType<typeof lat1Run>>
  // `retained`: the cancelling action keeps the prepared graph (seek and pause); Stop and a project switch retire it themselves.
  const lat1Cancels: { name: string; retained: boolean; run: (h: Lat1Run) => Promise<void> }[] = [
    { name: "seek", retained: true, run: async h => { await h.f.controller.seekPrepared(0) } },
    { name: "pause", retained: true, run: h => h.f.controller.pause(1) },
    { name: "stop", retained: false, run: async h => { await h.f.controller.dispose(undefined, "stop") } },
    { name: "project switch", retained: false, run: async h => { await h.f.controller.dispose(undefined, "project-switch") } },
  ]
  const lat1Holds: ("inspect" | "publish")[] = ["inspect", "publish"]
  for (const hold of lat1Holds)
    for (const { name: cancel, retained, run } of lat1Cancels)
      test(`LAT1 3: a ${cancel} while the bind's ${hold} reply is in flight ends the publication with nothing armed`, async () => {
        const h = await lat1Run()
        const gate = Promise.withResolvers<void>()
        const reached = Promise.withResolvers<void>()
        let holding = true
        const hold1 = async () => { if (holding) { holding = false; reached.resolve(); await gate.promise } }
        const revisions = h.f.fixture.bridge.session.revisions
        const { inspect, publish } = revisions
        if (hold === "inspect") revisions.inspect = async request => { const reply = await inspect(request); await hold1(); return reply }
        else revisions.publish = async request => { const reply = await publish(request); await hold1(); return reply }
        const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent(`LAT1-3-${hold}-${cancel}`)))
        try {
          await reached.promise
          // The seek and pause transitions wait on the host's transport ACK, which this fake does not send; the adoption's end is what
          // is observed, and the host is closed with the transition pending.
          void run(h).catch(() => undefined)
          await step7Turns()
          const sent = h.publishes().length
          gate.resolve()
          await step7Turns()
          await lat1Pump(h.f, 3)
          expect(answer.answers).toBe(1)
          expect(answer.value?.status).toBe("superseded")
          expect(h.publishes()).toHaveLength(sent)
          expect(h.publishes().filter(event => event.armed)).toEqual([])
          expect(h.native.status).not.toBe("published")
          expect(rollbacks(h.f)).toBe(0)
          expect(h.f.controller.isPrepared()).toBe(retained)
          if (!retained) expect(h.f.fixture.calls).toContain("stop")
        } finally { gate.resolve(); await h.f.close() }
      })

  test("LAT1 2: a bind refused twice falls back to the provisional seam and publishes once", async () => {
    const h = await lat1Run()
    h.native.refuseBinds = 2
    const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-2-twice")))
    try {
      await step7Turns()
      const progress = h.events[0]?.progress ?? 0n
      const provisional = h.events[0]?.frame ?? 0n
      expect(h.events.map(event => event.kind).slice(0, 5)).toEqual(["prepare", "inspect", "publish", "inspect", "publish"])
      expect(h.publishes().map(event => [event.frame, event.armed])).toEqual([
        [progress + 3n * 512n, false], [progress + 4n * 512n, false], [provisional, true]])
      expect(rollbacks(h.f)).toBe(0)
      expect(answer.answers).toBe(0)
      h.native.status = "published"
      h.native.progress = h.native.seam
      h.f.fixture.setRuntimeRevision(2)
      await lat1Pump(h.f, 2)
      expect(new Set(stagedHeaders(h.f, h.events[0]?.windows ?? 0))).toEqual(new Set([provisional]))
      expect(answer.value).toEqual({ status: "adopted" })
      expect(rollbacks(h.f)).toBe(0)
    } finally { await h.f.close() }
  })

  test("LAT1 3, 6: the bind is not a retry; eight misses grow the lead and end in one rollback", async () => {
    const h = await lat1Run()
    h.native.misses = Number.POSITIVE_INFINITY
    const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-6")))
    try {
      await step7Turns()
      await lat1Pump(h.f, 24)
      const moves = h.publishes().filter(event => !event.armed).map(event => event.frame)
      expect(h.publishes().filter(event => event.armed)).toHaveLength(5)
      expect(moves.slice(1).map((frame, index) => Number((frame ?? 0n) - (moves[index] ?? 0n)) / 512)).toEqual([6, 24, 96, 128])
      expect(rollbacks(h.f)).toBe(1)
      expect(answer.answers).toBe(1)
      expect(answer.value?.status).toBe("failed")
    } finally { await h.f.close() }
  })

  test("LAT1 2, 3: a refused bind spends no resubmit; the growth and the eight-resubmit budget start from zero", async () => {
    const h = await lat1Run()
    h.native.advanceOnBind = 10n * 512n
    h.native.misses = Number.POSITIVE_INFINITY
    const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-2-3")))
    try {
      await step7Turns()
      await lat1Pump(h.f, 24)
      const moves = h.publishes().filter(event => !event.armed).map(event => event.frame)
      const progress = h.events[0]?.progress ?? 0n
      expect(moves.slice(0, 2)).toEqual([progress + 3n * 512n, progress + 13n * 512n])
      expect(moves.slice(2).map((frame, index) => Number((frame ?? 0n) - (moves[index + 1] ?? 0n)) / 512)).toEqual([6, 24, 96, 128])
      expect(h.publishes().filter(event => event.armed)).toHaveLength(5)
      expect(rollbacks(h.f)).toBe(1)
      expect(answer.value?.status).toBe("failed")
    } finally { await h.f.close() }
  })

  test("LAT1 5: a seam passed before the Publish rebases once at twice the lead and publishes once", async () => {
    const h = await lat1Run()
    h.native.passSeamAfterBind = true
    const answer = step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-5")))
    try {
      await step7Turns()
      await lat1Pump(h.f, 6)
      const bound = h.publishes()[0]?.frame ?? 0n
      expect(h.publishes().map(event => [event.frame, event.armed])).toEqual([
        [bound, false], [bound, true], [bound + 6n * 512n, false], [bound + 6n * 512n, true]])
      expect(new Set(stagedHeaders(h.f, h.events[0]?.windows ?? 0))).toEqual(new Set([bound, bound + 6n * 512n]))
      h.native.status = "published"
      h.native.progress = h.native.seam
      h.f.fixture.setRuntimeRevision(2)
      await lat1Pump(h.f, 2)
      expect(answer.value).toEqual({ status: "adopted" })
      expect(answer.answers).toBe(1)
      expect(rollbacks(h.f)).toBe(0)
    } finally { await h.f.close() }
  })

  test("LAT1 7: a transport epoch change seen at the bind sends no Publish", async () => {
    const h = await lat1Run()
    h.native.epoch = 2
    step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-7")))
    try {
      await step7Turns()
      await lat1Pump(h.f, 3)
      expect(h.events.filter(event => event.kind === "inspect").length).toBeGreaterThan(0)
      expect(h.publishes()).toEqual([])
    } finally { await h.f.close() }
  })

  const lat1Leads: [number, number, bigint][] = [[48_000, 128, 10n], [44_100, 512, 3n], [96_000, 256, 10n]]
  for (const [sampleRateHz, blockFrames, blocks] of lat1Leads)
    test(`LAT1 11: the lead is 25 ms in blocks at ${sampleRateHz} Hz with ${blockFrames}-frame blocks`, async () => {
      const h = await lat1Run(blockFrames, sampleRateHz)
      step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-11")))
      try {
        await step7Turns()
        expect(h.publishes()[0]?.frame).toBe((h.events[0]?.progress ?? 0n) + blocks * BigInt(blockFrames))
      } finally { await h.f.close() }
    })

  test("LAT1 10, 12: latency publications send no frame; two same-turn schedule edits bind once", async () => {
    const latency = await step7LatencyFixture()
    const paused = lat1Host(latency, 512n)
    try {
      step7Watch(latency.fft(2048, 20))
      await step7Turns()
      expect(paused.events.filter(event => event.kind === "prepare").length).toBeGreaterThan(0)
      expect(paused.events.every(event => event.frame === undefined)).toBe(true)
    } finally { await latency.close() }
    const h = await lat1Run()
    step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-12a")))
    step7Watch(h.f.controller.adoptSchedule(migrationIntent("LAT1-12b")))
    try {
      await step7Turns()
      expect(h.events.filter(event => event.kind === "prepare")).toHaveLength(1)
      expect(h.publishes().map(event => event.armed)).toEqual([false, true])
    } finally { await h.f.close() }
  })
})
