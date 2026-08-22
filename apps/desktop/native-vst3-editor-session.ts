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
> & {
  getVstState?: NativeAudioHostSupervisor["getVstState"]
}

type EditorSessionInput = {
  workerPath: string
  catalogStore: { load(): Promise<PluginCatalogData> }
  createSupervisor: () => EditorSessionSupervisor
  coordinate?: typeof coordinateNativeVst3Attachments
  onEditorInteraction?: (input: { projectId: string; instanceId: string }) => void
  onEditorOpenState?: (input: { projectId: string; instanceId: string; open: boolean }) => void
  onCapturedState?: (input: { projectId: string; instanceId: string; state: { bytes: Uint8Array; sha256: string } }) => Promise<void> | void
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
  initialState?: { bytes: Uint8Array; sha256: string }
  requiresState?: boolean
  captureState?: boolean
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
  cancelInitialization?: () => void
  projectId?: string
  requiresState: boolean
  captureState: boolean
  stateCaptured: boolean
  queue: Promise<void>
  teardownPromise?: Promise<void>
}

const initializationCommand = (command: NativeVstEditorCommand) => (
  command === "open" || command === "focus" || command === "status"
)

const indicatesEditorHostLoss = (message: string) => {
  const normalized = message.toLowerCase()
  return normalized.includes("native audio host is unavailable")
    || normalized.includes("native audio host stopped")
    || normalized.includes("host connection was lost")
    || normalized.includes("host connection closed")
}
export type NativeVst3EditorSessionManager = {
  execute(input: EditorCommandInput): Promise<NativeVstEditorStatus>
  captureAll(): Promise<void>
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
  const captureEntryState = async (instanceId: string, entry: EditorSessionEntry) => {
    if (!entry.supervisor || (!entry.requiresState && !entry.captureState) || !entry.supervisor.getVstState || !entry.projectId) return
    if (entry.stateCaptured) return
    const state = await entry.supervisor.getVstState(instanceId)
    await input.onCapturedState?.({ projectId: entry.projectId, instanceId, state })
    entry.stateCaptured = true
  }
  const initialize = async (
    instanceId: string,
    entry: EditorSessionEntry,
    projectId: string,
    serializedPlan: string,
    initialState: EditorCommandInput["initialState"],
    requiresState: boolean,
    captureState: boolean,
    generation: number,
  ) => {
    const supervisor = input.createSupervisor()
    entry.supervisor = supervisor
    entry.teardownPromise = undefined
    entry.projectId = projectId
    entry.requiresState = requiresState
    entry.captureState = captureState
    entry.stateCaptured = false
    const assertCurrent = () => {
      if (generation !== lifecycleGeneration || entries.get(instanceId) !== entry || entry.supervisor !== supervisor) {
        throw new Error("The native VST editor session was suspended.")
      }
    }
    let transactionOpen = false
    let transactionToken: string | undefined
    let resolveWorkerReady: (() => void) | undefined
    let rejectWorkerReady: ((error: Error) => void) | undefined
    let workerReadySettled = false
    const workerReady = new Promise<void>((resolve, reject) => {
      resolveWorkerReady = () => {
        if (workerReadySettled) return
        workerReadySettled = true
        resolve()
      }
      rejectWorkerReady = (error) => {
        if (workerReadySettled) return
        workerReadySettled = true
        reject(error)
      }
    })
    workerReady.catch(() => undefined)
    entry.cancelInitialization = () => {
      rejectWorkerReady?.(new Error("The native VST editor session was suspended."))
    }
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
        capturedVstStates: initialState ? new Map([[instanceId, initialState]]) : undefined,
        requiredVstStateInstanceIds: requiresState ? new Set([instanceId]) : new Set(),
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
          entry.stateCaptured = false
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
    } finally {
      entry.cancelInitialization = undefined
    }
  }

  const enqueue = <T>(instanceId: string, generation: number, operation: (entry: EditorSessionEntry) => Promise<T>) => {
    const entry = entries.get(instanceId) ?? {
      queue: Promise.resolve(),
      requiresState: false,
      captureState: false,
      stateCaptured: false,
    }
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
          let teardownError: string | undefined
          try {
            if (entry.supervisor) {
              if (entry.projectId !== inputCommand.projectId) throw new Error("The native VST editor project binding changed.")
              const {
                projectId: _projectId,
                initialState: _initialState,
                requiresState: _requiresState,
                captureState: _captureState,
                ...nativeCommand
              } = inputCommand
              const capturedState = (entry.requiresState || entry.captureState || inputCommand.captureState === true)
                && entry.supervisor.getVstState
                ? await entry.supervisor.getVstState(inputCommand.instanceId)
                : undefined
              try {
                status = await entry.supervisor.executeVstEditorCommand(nativeCommand)
              } catch (error) {
                status = {
                  ...closedStatus,
                  closeError: error instanceof Error ? error.message : "The native editor close command failed.",
                }
              }
              if (capturedState) status = { ...status, capturedState }
            }
          } finally {
            try {
              await teardownEntry(entry)
            } catch (error) {
              teardownError = error instanceof Error ? error.message : "The native VST editor teardown failed."
              console.error("[native-vst3] editor teardown failed", { error: teardownError })
            }
          }
          if (teardownError) status = { ...status, teardownError }
          return status
        }
        if (entry.projectId !== undefined && entry.projectId !== inputCommand.projectId) {
          throw new Error("The native VST editor project binding changed.")
        }
        let retriedAfterHostLoss = false
        const executeOnce = async () => {
          if (!entry.supervisor) {
            if (!initializationCommand(inputCommand.command) || inputCommand.serializedPlan === undefined) {
              throw new Error("The native VST editor session is unavailable.")
            }
            await initialize(
              inputCommand.instanceId,
              entry,
              inputCommand.projectId,
              inputCommand.serializedPlan,
              inputCommand.initialState,
              inputCommand.requiresState === true,
              inputCommand.captureState === true,
              generation,
            )
          }
          if (!entry.supervisor) throw new Error("The native VST editor session is unavailable.")
          const {
            projectId: _projectId,
            initialState: _initialState,
            requiresState: _requiresState,
            captureState: _captureState,
            ...nativeCommand
          } = inputCommand
          return await entry.supervisor.executeVstEditorCommand(nativeCommand)
        }
        try {
          return await executeOnce()
        } catch (error) {
          try {
            await teardownEntry(entry)
          } catch (teardownError) {
            console.error("[native-vst3] editor retry cleanup failed", {
              error: teardownError instanceof Error
                ? teardownError.message
                : "The native VST editor teardown failed.",
            })
          }
          if (
            (inputCommand.command === "open" || inputCommand.command === "focus")
            && !retriedAfterHostLoss
            && indicatesEditorHostLoss(error instanceof Error ? error.message : "Native VST editor command failed.")
          ) {
            retriedAfterHostLoss = true
            return executeOnce()
          }
          throw error
        }
      })
    },
    captureAll: async () => {
      try {
        await Promise.all([...entries.entries()].map(async ([instanceId, entry]) => {
          await entry.queue.catch(() => undefined)
          await captureEntryState(instanceId, entry)
        }))
      } catch (error) {
        for (const entry of entries.values()) entry.stateCaptured = false
        throw error
      }
    },
    async suspendAll() {
      for (const entry of entries.values()) entry.cancelInitialization?.()
      lifecycleGeneration += 1
      const currentEntries = [...entries.entries()]
      entries.clear()
      await Promise.all(currentEntries.map(async ([instanceId, entry]) => {
        await entry.queue.catch(() => undefined)
        let captureError: unknown
        try {
          await captureEntryState(instanceId, entry)
        } catch (error) {
          captureError = error
        } finally {
          await teardownEntry(entry).catch(() => undefined)
        }
        if (captureError !== undefined) throw captureError
      }))
    },
    async teardownAll() {
      for (const entry of entries.values()) entry.cancelInitialization?.()
      shuttingDown = true
      lifecycleGeneration += 1
      const currentEntries = [...entries.entries()]
      entries.clear()
      await Promise.all(currentEntries.map(async ([instanceId, entry]) => {
        await entry.queue.catch(() => undefined)
        try {
          await captureEntryState(instanceId, entry)
        } catch {
          // Teardown remains authoritative during application quit; capture
          // failures are intentionally swallowed after teardown completes.
        } finally {
          await teardownEntry(entry).catch(() => undefined)
        }
      }))
    },
  }
}
