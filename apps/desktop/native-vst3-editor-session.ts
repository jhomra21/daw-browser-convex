import type {
  NativeVstEditorAnchor,
  NativeVstEditorCommand,
  NativeVstEditorStatus,
  NativeAudioHostSupervisor,
  NativeWorkerNotification,
} from "./audio-host"
import { coordinateNativeVst3Attachments } from "./native-vst3-coordinator"
import type { PluginCatalogData } from "./plugin-catalog"

type EditorSessionSupervisor = Pick<
  NativeAudioHostSupervisor,
  | "beginTransaction"
  | "configure"
  | "commitTransaction"
  | "rollbackTransaction"
  | "startDiagnosticAudio"
  | "executeVstEditorCommand"
  | "teardown"
  | "attachVst"
  | "onWorkerNotification"
>

type EditorSessionInput = {
  workerPath: string
  catalogStore: { load(): Promise<PluginCatalogData> }
  createSupervisor: () => EditorSessionSupervisor
  coordinate?: typeof coordinateNativeVst3Attachments
  onEditorInteraction?: (input: { projectId: string; instanceId: string }) => void
  onEditorOpenState?: (input: { projectId: string; instanceId: string; open: boolean }) => void
  onParameterEdit?: (input: { projectId: string; instanceId: string; parameterId: number; normalizedValue: number }) => void
}

type EditorCommandInput = {
  projectId: string
  instanceId: string
  command: NativeVstEditorCommand
  serializedPlan?: string
  width?: number
  height?: number
  anchor?: NativeVstEditorAnchor
}

const diagnosticConfiguration = {
  deviceId: "coreaudio:editor",
  sampleRateHz: 44_100,
  maxFramesPerBlock: 8_192,
  channelCount: 2,
  revision: 1,
} as const

const closedStatus: NativeVstEditorStatus = {
  success: false,
  owned: false,
  supported: false,
  open: false,
  width: 0,
  height: 0,
}

type EditorSessionEntry = {
  supervisor?: EditorSessionSupervisor
  unsubscribeInteraction?: () => void
  projectId?: string
  queue: Promise<void>
  teardownPromise?: Promise<void>
}

const initializationCommand = (command: NativeVstEditorCommand) => (
  command === "open" || command === "focus" || command === "status"
)

export type NativeVst3EditorSessionManager = {
  execute(input: EditorCommandInput): Promise<NativeVstEditorStatus>
  suspendAll(): Promise<void>
  teardownAll(): Promise<void>
}

export const createNativeVst3EditorSessionManager = (
  input: EditorSessionInput,
): NativeVst3EditorSessionManager => {
  const entries = new Map<string, EditorSessionEntry>()
  let shuttingDown = false
  let lifecycleGeneration = 0

  const teardownEntry = async (entry: EditorSessionEntry) => {
    if (entry.teardownPromise) return entry.teardownPromise
    const supervisor = entry.supervisor
    entry.unsubscribeInteraction?.()
    entry.unsubscribeInteraction = undefined
    entry.supervisor = undefined
    const teardown = Promise.resolve().then(() => supervisor?.teardown()).then(() => undefined)
    entry.teardownPromise = teardown
    await teardown
  }

  const initialize = async (
    instanceId: string,
    entry: EditorSessionEntry,
    projectId: string,
    serializedPlan: string,
    generation: number,
  ) => {
    const supervisor = input.createSupervisor()
    entry.supervisor = supervisor
    entry.teardownPromise = undefined
    entry.projectId = projectId
    const assertCurrent = () => {
      if (generation !== lifecycleGeneration || entries.get(instanceId) !== entry || entry.supervisor !== supervisor) {
        throw new Error("The native VST editor session was suspended.")
      }
    }
    let transactionOpen = false
    let transactionToken: string | undefined
    let resolveWorkerReady: (() => void) | undefined
    let rejectWorkerReady: ((error: Error) => void) | undefined
    const workerReady = new Promise<void>((resolve, reject) => {
      resolveWorkerReady = resolve
      rejectWorkerReady = reject
    })
    try {
      transactionToken = await supervisor.beginTransaction()
      transactionOpen = true
      assertCurrent()
      await supervisor.configure(diagnosticConfiguration, transactionToken)
      assertCurrent()
      const result = await (input.coordinate ?? coordinateNativeVst3Attachments)({
        serializedPlan,
        sampleRateHz: diagnosticConfiguration.sampleRateHz,
        workerPath: input.workerPath,
        catalogStore: input.catalogStore,
        audioHost: supervisor,
        transactionToken,
      })
      assertCurrent()
      if (!result.ok) throw new Error(result.message)
      await supervisor.commitTransaction(transactionToken)
      transactionOpen = false
      transactionToken = undefined
      assertCurrent()
      entry.unsubscribeInteraction = supervisor.onWorkerNotification((notification: NativeWorkerNotification) => {
        if (generation !== lifecycleGeneration || entries.get(instanceId) !== entry || entry.supervisor !== supervisor) return
        if (notification.instanceId !== instanceId) return
        if (notification.kind === "buses") {
          resolveWorkerReady?.()
        }
        if (notification.kind === "fault") {
          rejectWorkerReady?.(new Error("The native VST editor worker failed to start."))
        }
        if (notification.kind === "editor-interaction") {
          input.onEditorInteraction?.({ projectId, instanceId })
        }
        if (notification.kind === "editor-state") {
          input.onEditorOpenState?.({ projectId, instanceId, open: notification.value === 1 })
        }
        if (notification.kind === "parameter-edit") {
          input.onParameterEdit?.({
            projectId,
            instanceId,
            parameterId: notification.parameterId,
            normalizedValue: notification.normalizedValue,
          })
        }
      })
      await supervisor.startDiagnosticAudio()
      await workerReady
      assertCurrent()
    } catch (error) {
      if (transactionOpen) {
        try {
          if (transactionToken) await supervisor.rollbackTransaction(transactionToken)
        } catch {
          // The original initialization failure remains authoritative.
        }
      }
      await teardownEntry(entry)
      throw error
    }
  }

  const enqueue = <T>(instanceId: string, generation: number, operation: (entry: EditorSessionEntry) => Promise<T>) => {
    const entry = entries.get(instanceId) ?? { queue: Promise.resolve() }
    entries.set(instanceId, entry)
    const result = entry.queue.then(() => {
      if (generation !== lifecycleGeneration) throw new Error("The native VST editor session was suspended.")
      return operation(entry)
    })
    const removeClosedEntry = () => {
      if (entries.get(instanceId) === entry && entry.queue === tail && !entry.supervisor) entries.delete(instanceId)
    }
    const tail = result.then(removeClosedEntry, removeClosedEntry)
    entry.queue = tail
    return result
  }

  return {
    execute(inputCommand) {
      if (shuttingDown) return Promise.reject(new Error("The native VST editor session is shutting down."))
      const generation = lifecycleGeneration
      return enqueue(inputCommand.instanceId, generation, async (entry) => {
        if (inputCommand.command === "close") {
          let status = closedStatus
          try {
            if (entry.supervisor) {
              if (entry.projectId !== inputCommand.projectId) throw new Error("The native VST editor project binding changed.")
              const { projectId: _projectId, ...nativeCommand } = inputCommand
              status = await entry.supervisor.executeVstEditorCommand(nativeCommand)
            }
          } finally {
            await teardownEntry(entry)
          }
          return status
        }
        if (entry.projectId !== undefined && entry.projectId !== inputCommand.projectId) {
          throw new Error("The native VST editor project binding changed.")
        }
        if (!entry.supervisor) {
          if (!initializationCommand(inputCommand.command) || inputCommand.serializedPlan === undefined) {
            throw new Error("The native VST editor session is unavailable.")
          }
          await initialize(inputCommand.instanceId, entry, inputCommand.projectId, inputCommand.serializedPlan, generation)
        }
        if (!entry.supervisor) throw new Error("The native VST editor session is unavailable.")
        try {
          const { projectId: _projectId, ...nativeCommand } = inputCommand
          return await entry.supervisor.executeVstEditorCommand(nativeCommand)
        } catch (error) {
          await teardownEntry(entry)
          throw error
        }
      })
    },
    async suspendAll() {
      lifecycleGeneration += 1
      const currentEntries = [...entries.values()]
      entries.clear()
      await Promise.all(currentEntries.map(async (entry) => {
        await Promise.allSettled([entry.queue, teardownEntry(entry)])
      }))
    },
    async teardownAll() {
      shuttingDown = true
      lifecycleGeneration += 1
      const currentEntries = [...entries.entries()]
      entries.clear()
      await Promise.all(currentEntries.map(async ([, entry]) => {
        await Promise.allSettled([entry.queue, teardownEntry(entry)])
      }))
    },
  }
}
