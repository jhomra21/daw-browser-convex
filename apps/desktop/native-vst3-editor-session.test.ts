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
  teardown(): Promise<void>
  attachVst(): Promise<void>
  onWorkerNotification(listener: (notification: NativeWorkerNotification) => void): () => void
}

const fakeSupervisor = (calls: string[], failAt?: string): FakeSupervisor => {
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
        instanceId: firstInstance,
        value: 2,
      })
    },
    async executeVstEditorCommand(input: { command: string; anchor?: { x: number; y: number } }) {
      step(`editor:${input.command}`)
      if (input.anchor) this.anchors.push(input.anchor)
      return { success: true, owned: true, supported: true, open: input.command !== "close", width: 640, height: 480 }
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
  coordinate?: (input: { serializedPlan: string }) => Promise<
    { ok: true; attached: number } | { ok: false; code: "invalid-plan"; message: string }
  >
  onEditorInteraction?: (input: { projectId: string; instanceId: string }) => void
  onEditorOpenState?: (input: { projectId: string; instanceId: string; open: boolean }) => void
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
    coordinate: async ({ serializedPlan }) => input.coordinate
      ? input.coordinate({ serializedPlan })
      : { ok: true, attached: 1 },
    onEditorInteraction: input.onEditorInteraction,
    onEditorOpenState: input.onEditorOpenState,
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

test("closes and removes an editor host even when the close command fails", async () => {
  const calls: string[] = []
  const supervisor = fakeSupervisor(calls, "editor:close")
  const manager = managerFor({ calls, supervisors: [supervisor, fakeSupervisor(calls)] })
  await manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })

  await expect(manager.execute({ projectId, instanceId: firstInstance, command: "close" })).rejects.toThrow("editor:close failed")
  expect(calls.slice(-2)).toEqual(["editor:close", "teardown"])
  await expect(manager.execute({ projectId, instanceId: firstInstance, command: "open", serializedPlan: "plan" })).resolves.toMatchObject({ open: true })
  expect(calls).toContain("diagnostic-start")
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
    supervisors: [fakeSupervisor(firstCalls), fakeSupervisor(secondCalls)],
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
