import { expect, test } from "bun:test"
import {
  createNativeVst3EditorSessionManager,
  type NativeVst3EditorSessionManager,
} from "./native-vst3-editor-session"
import type { NativeWorkerNotification } from "./audio-host"
import type { PluginCatalogData } from "./plugin-catalog"

const firstInstance = "11111111-1111-4111-8111-111111111111"
const secondInstance = "22222222-2222-4222-8222-222222222222"
const projectId = "project-test"

type FakeSupervisor = {
  calls: string[]
  anchors: { x: number; y: number }[]
  interactionListener?: (notification: NativeWorkerNotification) => void
  beginTransaction(): Promise<string>
  configure(input: { deviceId: string }, transactionToken?: string): Promise<void>
  commitTransaction(transactionToken: string): Promise<void>
  rollbackTransaction(transactionToken: string): Promise<void>
  startDiagnosticAudio(): Promise<void>
  executeVstEditorCommand(input: { command: string }): Promise<{
    success: boolean
    owned: boolean
    supported: boolean
    open: boolean
    width: number
    height: number
  }>
  getVstState?(): Promise<{ bytes: Uint8Array; sha256: string }>
  teardown(): Promise<void>
  attachVst(): Promise<void>
  onWorkerNotification(listener: (notification: NativeWorkerNotification) => void): () => void
}

const fakeSupervisor = (
  calls: string[],
  failAt?: string,
  readyInstance = firstInstance,
  state = { bytes: new Uint8Array([1, 2, 3]), sha256: "a".repeat(64) },
): FakeSupervisor => {
  const step = (name: string) => {
    calls.push(name)
    if (failAt === name) throw new Error(`${name} failed`)
  }
  return {
    calls,
    anchors: [],
    async beginTransaction() { step("begin"); return "transaction-token" },
    async configure(input, _transactionToken) {
      calls.push(`configure:${input.deviceId}`)
      if (failAt === "configure") throw new Error("configure failed")
    },
    async commitTransaction(_transactionToken) { step("commit") },
    async rollbackTransaction(_transactionToken) { step("rollback") },
    async startDiagnosticAudio() {
      step("diagnostic-start")
      this.interactionListener?.({
        kind: "buses",
        graphRevision: 1,
        graphNodeId: 1n,
        instanceId: readyInstance,
        value: 2,
      })
    },
    async executeVstEditorCommand(input: { command: string; anchor?: { x: number; y: number } }) {
      step(`editor:${input.command}`)
      if (input.anchor) this.anchors.push(input.anchor)
      return { success: true, owned: true, supported: true, open: input.command !== "close", width: 640, height: 480 }
    },
    async getVstState() {
      calls.push("get-state")
      return state
    },
    async teardown() { step("teardown") },
    async attachVst() {},
    onWorkerNotification(listener) {
      this.interactionListener = listener
      return () => { this.interactionListener = undefined }
    },
  }
}

const managerFor = (input: {
  supervisors?: FakeSupervisor[]
  calls?: string[]
  coordinate?: (input: {
    serializedPlan: string
    capturedVstStates?: ReadonlyMap<string, { bytes: Uint8Array; sha256: string }>
    requiredVstStateInstanceIds?: ReadonlySet<string>
  }) => Promise<
    { ok: true; attached: number } | { ok: false; code: "invalid-plan"; message: string }
  >
  onEditorInteraction?: (input: { projectId: string; instanceId: string }) => void
  onEditorOpenState?: (input: { projectId: string; instanceId: string; open: boolean }) => void
  onCapturedState?: (input: { projectId: string; instanceId: string; state: { bytes: Uint8Array; sha256: string } }) => Promise<void> | void
  onParameterEdit?: (input: { projectId: string; instanceId: string; parameterId: number; normalizedValue: number }) => void
} = {}): NativeVst3EditorSessionManager => {
  const calls = input.calls ?? []
  const supervisors = input.supervisors ?? []
  const catalog: PluginCatalogData = {
    version: 3,
    directories: [],
    entries: [],
    diagnostics: [],
    scannedAtMs: null,
  }
  return createNativeVst3EditorSessionManager({
    workerPath: "/worker",
    catalogStore: { load: async () => catalog },
    createSupervisor: () => {
      return supervisors.shift() ?? fakeSupervisor(calls)
    },
    coordinate: async ({ serializedPlan, capturedVstStates, requiredVstStateInstanceIds }) => input.coordinate
      ? input.coordinate({ serializedPlan, capturedVstStates, requiredVstStateInstanceIds })
      : { ok: true, attached: 1 },
    onEditorInteraction: input.onEditorInteraction,
    onEditorOpenState: input.onEditorOpenState,
    onCapturedState: input.onCapturedState,
    onParameterEdit: input.onParameterEdit,
  })
}

test("initializes before editor open and uses the diagnostic host configuration", async () => {
  const calls: string[] = []
  const supervisor = fakeSupervisor(calls)
  const manager = managerFor({ calls, supervisors: [supervisor] })

  await expect(manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: '{"version":1,"attachments":[]}',
  })).resolves.toMatchObject({ success: true, open: true })
  expect(calls).toEqual([
    "begin",
    "configure:coreaudio:editor",
    "commit",
    "diagnostic-start",
    "editor:open",
  ])
})

test("restores initial state before opening and captures state before closing", async () => {
  const calls: string[] = []
  const state = { bytes: new Uint8Array([4, 5, 6]), sha256: "b".repeat(64) }
  const supervisor = fakeSupervisor(calls, undefined, firstInstance, state)
  let coordinatedState: Uint8Array | undefined
  const manager = managerFor({
    calls,
    supervisors: [supervisor],
    coordinate: async ({ capturedVstStates, requiredVstStateInstanceIds }) => {
      coordinatedState = capturedVstStates?.get(firstInstance)?.bytes
      expect(requiredVstStateInstanceIds?.has(firstInstance)).toBeTrue()
      return { ok: true, attached: 1 }
    },
  })

  await manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
    initialState: state,
    requiresState: true,
    captureState: true,
  })
  const status = await manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "close",
    captureState: true,
  })

  expect(coordinatedState).toEqual(state.bytes)
  expect(status.capturedState).toEqual(state)
  expect(calls.slice(-3)).toEqual(["get-state", "editor:close", "teardown"])
})

test("waits for the worker-ready notification before opening the editor", async () => {
  const calls: string[] = []
  const supervisor = fakeSupervisor(calls)
  const startReached = Promise.withResolvers<void>()
  supervisor.startDiagnosticAudio = async () => {
    calls.push("diagnostic-start")
    startReached.resolve()
  }
  const manager = managerFor({ calls, supervisors: [supervisor] })
  const opening = manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })

  await startReached.promise
  expect(calls).not.toContain("editor:open")
  supervisor.interactionListener?.({
    kind: "buses",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: firstInstance,
    value: 2,
  })
  await expect(opening).resolves.toMatchObject({ success: true, open: true })
})

test("waits for the requested editor worker when another attachment becomes ready first", async () => {
  const calls: string[] = []
  const supervisor = fakeSupervisor(calls)
  const startReached = Promise.withResolvers<void>()
  supervisor.startDiagnosticAudio = async () => {
    calls.push("diagnostic-start")
    startReached.resolve()
  }
  const manager = managerFor({ calls, supervisors: [supervisor] })
  const opening = manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })

  await startReached.promise
  supervisor.interactionListener?.({
    kind: "buses",
    graphRevision: 1,
    graphNodeId: 2n,
    instanceId: secondInstance,
    value: 2,
  })
  await Promise.resolve()
  expect(calls).not.toContain("editor:open")
  supervisor.interactionListener?.({
    kind: "buses",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: firstInstance,
    value: 2,
  })
  await expect(opening).resolves.toMatchObject({ success: true, open: true })
})

test("suspendAll cancels an editor initialization waiting for worker readiness", async () => {
  const calls: string[] = []
  const startReached = Promise.withResolvers<void>()
  const supervisor = fakeSupervisor(calls)
  supervisor.startDiagnosticAudio = async () => {
    calls.push("diagnostic-start")
    startReached.resolve()
  }
  const manager = managerFor({ calls, supervisors: [supervisor, fakeSupervisor(calls)] })
  const opening = manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })
  await startReached.promise
  const suspended = manager.suspendAll()
  await expect(opening).rejects.toThrow("suspended")
  await expect(suspended).resolves.toBeUndefined()
  expect(calls.filter((call) => call === "teardown")).toHaveLength(1)

  await expect(manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })).resolves.toMatchObject({ open: true })
})

test("teardownAll cancels an editor initialization waiting for worker readiness", async () => {
  const calls: string[] = []
  const startReached = Promise.withResolvers<void>()
  const supervisor = fakeSupervisor(calls)
  supervisor.startDiagnosticAudio = async () => {
    calls.push("diagnostic-start")
    startReached.resolve()
  }
  const manager = managerFor({ calls, supervisors: [supervisor] })
  const opening = manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })
  await startReached.promise
  const teardown = manager.teardownAll()
  await expect(opening).rejects.toThrow("suspended")
  await expect(teardown).resolves.toBeUndefined()
  expect(calls.filter((call) => call === "teardown")).toHaveLength(1)
})

test("rolls back and tears down a failed initialization", async () => {
  const calls: string[] = []
  const supervisor = fakeSupervisor(calls)
  const manager = managerFor({
    calls,
    supervisors: [supervisor],
    coordinate: async () => ({ ok: false, code: "invalid-plan", message: "stale plan" }),
  })

  await expect(manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "stale",
  })).rejects.toThrow("stale plan")
  expect(calls).toEqual(["begin", "configure:coreaudio:editor", "rollback", "teardown"])
})

test("returns captured state and close failure while removing an editor host", async () => {
  const calls: string[] = []
  const state = { bytes: new Uint8Array([7, 8, 9]), sha256: "c".repeat(64) }
  const supervisor = fakeSupervisor(calls, "editor:close", firstInstance, state)
  const manager = managerFor({ calls, supervisors: [supervisor, fakeSupervisor(calls)] })
  await manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
    captureState: true,
  })

  await expect(manager.execute({ projectId, instanceId: firstInstance, command: "close" })).resolves.toMatchObject({
    capturedState: state,
    closeError: "editor:close failed",
  })
  expect(calls.slice(-2)).toEqual(["editor:close", "teardown"])
  await expect(manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })).resolves.toMatchObject({ open: true })
  expect(calls).toContain("diagnostic-start")
})

test("returns captured state when editor teardown fails after close", async () => {
  const calls: string[] = []
  const state = { bytes: new Uint8Array([10, 11]), sha256: "d".repeat(64) }
  const supervisor = fakeSupervisor(calls, "teardown", firstInstance, state)
  const manager = managerFor({ calls, supervisors: [supervisor] })
  await manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
    captureState: true,
  })

  await expect(manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "close",
  })).resolves.toMatchObject({
    capturedState: state,
    teardownError: "teardown failed",
  })
})

test("retries after host loss even when cleanup fails", async () => {
  const calls: string[] = []
  const firstSupervisor = fakeSupervisor(calls)
  const originalExecute = firstSupervisor.executeVstEditorCommand
  let failed = false
  firstSupervisor.executeVstEditorCommand = async (input) => {
    if (input.command === "open" && !failed) {
      failed = true
      throw new Error("Native audio host stopped.")
    }
    return originalExecute(input)
  }
  firstSupervisor.teardown = async () => {
    calls.push("teardown")
    throw new Error("cleanup failed")
  }
  const manager = managerFor({
    calls,
    supervisors: [firstSupervisor, fakeSupervisor(calls)],
  })

  await expect(manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })).resolves.toMatchObject({ open: true })
  expect(calls).toContain("teardown")
})

test("captures editor state through the renderer callback before suspension teardown", async () => {
  const calls: string[] = []
  const captured: Array<{ projectId: string; instanceId: string; state: { bytes: Uint8Array; sha256: string } }> = []
  const supervisor = fakeSupervisor(calls)
  const manager = managerFor({
    calls,
    supervisors: [supervisor],
    onCapturedState: (input) => {
      captured.push(input)
    },
  })
  await manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
    captureState: true,
  })

  await manager.suspendAll()

  expect(captured).toHaveLength(1)
  expect(captured[0]?.projectId).toBe(projectId)
  expect(captured[0]?.instanceId).toBe(firstInstance)
  expect(calls.slice(-2)).toEqual(["get-state", "teardown"])
})

test("captures all editor state before quit and still tears down after capture failure", async () => {
  const calls: string[] = []
  const captured: string[] = []
  const supervisor = fakeSupervisor(calls)
  let failCapture = false
  const manager = managerFor({
    calls,
    supervisors: [supervisor],
    onCapturedState: async ({ instanceId }) => {
      captured.push(instanceId)
      if (failCapture) throw new Error("state persistence failed")
    },
  })
  await manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
    captureState: true,
  })
  failCapture = true
  await expect(manager.teardownAll()).resolves.toBeUndefined()
  expect(captured).toEqual([firstInstance])
  expect(calls).toContain("teardown")
})

test("tears down each supervisor across queued close and reopen cycles", async () => {
  const calls: string[] = []
  const teardownCounts = [0, 0]
  const firstSupervisor = fakeSupervisor(calls)
  const secondSupervisor = fakeSupervisor(calls)
  firstSupervisor.teardown = async () => {
    teardownCounts[0] += 1
    calls.push("teardown:first")
  }
  secondSupervisor.teardown = async () => {
    teardownCounts[1] += 1
    calls.push("teardown:second")
  }
  const manager = managerFor({ calls, supervisors: [firstSupervisor, secondSupervisor] })
  const openFirst = manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })
  const closeFirst = manager.execute({ projectId, instanceId: firstInstance, command: "close" })
  const openSecond = manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })
  const closeSecond = manager.execute({ projectId, instanceId: firstInstance, command: "close" })
  await Promise.all([openFirst, closeFirst, openSecond, closeSecond])
  expect(teardownCounts).toEqual([1, 1])
  expect(calls.filter((call) => call.startsWith("teardown:"))).toEqual([
    "teardown:first",
    "teardown:second",
  ])
})

test("reuses a session for focus and serializes repeated opens", async () => {
  const calls: string[] = []
  const supervisor = fakeSupervisor(calls)
  const manager = managerFor({ calls, supervisors: [supervisor] })
  const first = manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan", anchor: { x: 12, y: 24 } })
  const second = manager.execute({ projectId, instanceId: firstInstance, command: "focus", serializedPlan: "plan", anchor: { x: -12, y: -24 } })
  await Promise.all([first, second])
  expect(calls.filter((call) => call === "begin")).toHaveLength(1)
  expect(calls.slice(-2)).toEqual(["editor:open", "editor:focus"])
  expect(supervisor.anchors).toEqual([{ x: 12, y: 24 }, { x: -12, y: -24 }])
})

test("forwards only matching editor interactions to the session callback", async () => {
  const interactions: string[] = []
  const supervisor = fakeSupervisor([])
  const manager = managerFor({
    supervisors: [supervisor],
    onEditorInteraction: (input) => interactions.push(input.instanceId),
  })
  await manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })
  supervisor.interactionListener?.({
    kind: "editor-interaction",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: firstInstance,
    value: 0,
  })
  supervisor.interactionListener?.({
    kind: "editor-interaction",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: secondInstance,
    value: 0,
  })
  expect(interactions).toEqual([firstInstance])
  await manager.teardownAll()
  expect(supervisor.interactionListener).toBeUndefined()
})

test("forwards only matching editor open-state changes", async () => {
  const states: Array<{ projectId: string; instanceId: string; open: boolean }> = []
  const supervisor = fakeSupervisor([])
  const manager = managerFor({
    supervisors: [supervisor],
    onEditorOpenState: (input) => states.push(input),
  })
  await manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })
  supervisor.interactionListener?.({
    kind: "editor-state",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: firstInstance,
    value: 0,
  })
  supervisor.interactionListener?.({
    kind: "editor-state",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: secondInstance,
    value: 1,
  })
  expect(states).toEqual([{ projectId, instanceId: firstInstance, open: false }])
  await manager.teardownAll()
})

test("forwards only matching parameter edits with the bound project and instance", async () => {
  const edits: Array<{ projectId: string; instanceId: string; parameterId: number; normalizedValue: number }> = []
  const supervisor = fakeSupervisor([])
  const manager = managerFor({
    supervisors: [supervisor],
    onParameterEdit: (input) => edits.push(input),
  })
  await manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })
  supervisor.interactionListener?.({
    kind: "parameter-edit",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: firstInstance,
    parameterId: 42,
    normalizedValue: 0.75,
  })
  supervisor.interactionListener?.({
    kind: "parameter-edit",
    graphRevision: 1,
    graphNodeId: 1n,
    instanceId: secondInstance,
    parameterId: 42,
    normalizedValue: 0.25,
  })
  expect(edits).toEqual([{
    projectId,
    instanceId: firstInstance,
    parameterId: 42,
    normalizedValue: 0.75,
  }])
  await manager.teardownAll()
})

test("rejects a conflicting editor project binding", async () => {
  const manager = managerFor({ supervisors: [fakeSupervisor([])] })
  await manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })
  await expect(manager.execute({
    projectId: "project-other",
    instanceId: firstInstance,
    command: "focus",
    serializedPlan: "plan",
  })).rejects.toThrow("project binding changed")
  await manager.teardownAll()
})

test("keeps independent editor instances isolated", async () => {
  const firstCalls: string[] = []
  const secondCalls: string[] = []
  const manager = managerFor({
    supervisors: [fakeSupervisor(firstCalls), fakeSupervisor(secondCalls, undefined, secondInstance)],
  })
  await Promise.all([
    manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "first" }),
    manager.execute({ projectId, instanceId: secondInstance, command: "open", serializedPlan: "second" }),
  ])
  expect(firstCalls).toContain("editor:open")
  expect(secondCalls).toContain("editor:open")
  expect(firstCalls).not.toContain("second")
  expect(secondCalls).not.toContain("first")
  await manager.teardownAll()
  expect(firstCalls).toContain("teardown")
  expect(secondCalls).toContain("teardown")
})

test("invalidates in-flight initialization before commit and remains reusable", async () => {
  const calls: string[] = []
  const coordinate = Promise.withResolvers<{ ok: true; attached: number }>()
  const firstSupervisor = fakeSupervisor(calls)
  const secondSupervisor = fakeSupervisor(calls)
  const manager = managerFor({
    calls,
    supervisors: [firstSupervisor, secondSupervisor],
    coordinate: async () => coordinate.promise,
  })

  const opening = manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })
  await Promise.resolve()
  const suspended = manager.suspendAll()
  coordinate.resolve({ ok: true, attached: 1 })
  await expect(opening).rejects.toThrow("suspended")
  await suspended
  expect(calls).not.toContain("commit")
  expect(calls).not.toContain("diagnostic-start")

  await expect(manager.execute({
    projectId,
    instanceId: firstInstance,
    command: "open",
    serializedPlan: "plan",
  })).resolves.toMatchObject({ open: true })
})
