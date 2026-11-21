import { dialog, type BrowserWindow, type IpcMain } from "electron"
import { z } from "zod"
import { pluginCatalogChooseDirectoryChannel, pluginCatalogPreflightInsertionChannel, pluginCatalogReadChannel, pluginCatalogRemoveDirectoryChannel, pluginCatalogScanChannel } from "@daw-browser/desktop-protocol/ipc-channels"
import { catalogViewForRenderer } from "./vst3-attachment"
import { preflightVst3Insertion } from "./vst3-insertion-preflight"
import { probeNativeAudioOutputDevice } from "./audio-host"
import { maxVst3WorkerFrames, nativeVst3InsertionPreflightRequestSchema } from "@daw-browser/plugin-host-protocol"
import type { createNativeVst3SessionLedger } from "./native-vst3-coordinator"
import type { createAe08Evidence } from "./ae08-evidence"
import type { RendererSenderEvent } from "./ipc/renderer-sender"
import type { createPluginCatalogOwner } from "./plugin-catalog-owner"

const pluginDirectorySchema = z.object({ directory: z.string() }).passthrough()

/** The renderer's plug-in catalog requests: reading and editing the scanned directories, scanning, and preflighting an insertion. */
export const registerPluginCatalogIpc = (options: {
  ipcMain: IpcMain
  catalog: ReturnType<typeof createPluginCatalogOwner>
  senderAllowed: (event: RendererSenderEvent, options: { privileged: boolean; mainFrameOnly: boolean }) => boolean
  audioHostAllowed: (event: Electron.IpcMainInvokeEvent) => boolean
  getWindow: () => BrowserWindow | undefined
  hostPath: string | undefined
  attachmentLedger: ReturnType<typeof createNativeVst3SessionLedger>
  ae08Evidence: ReturnType<typeof createAe08Evidence>
  ae08WorkerEnvironment: NodeJS.ProcessEnv
}) => {
  const { ipcMain, catalog, senderAllowed, audioHostAllowed, getWindow, hostPath, attachmentLedger, ae08Evidence, ae08WorkerEnvironment } = options

  const catalogAllowed = (event: Electron.IpcMainInvokeEvent) => (
    process.platform === "darwin"
    && senderAllowed(event, { privileged: true, mainFrameOnly: false })
  )

  const catalogFailure = (message: string) => ({ ok: false as const, error: message })

  const catalogStoreFor = (event: Electron.IpcMainInvokeEvent) => (
    catalogAllowed(event) ? catalog.store : undefined
  )

  ipcMain.handle(pluginCatalogReadChannel, async (event) => {
    const store = catalogStoreFor(event)

    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")

    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.load()) }
    } catch {
      return catalogFailure("The plug-in catalog could not be read.")
    }
  })
  ipcMain.handle(pluginCatalogChooseDirectoryChannel, async (event) => {
    const store = catalogStoreFor(event)
    const currentWindow = getWindow()

    if (!store || !currentWindow) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const selection = await dialog.showOpenDialog(currentWindow, { properties: ["openDirectory", "createDirectory"] })

    if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true }

    try {
      return { ok: true, canceled: false, catalog: catalogViewForRenderer(await store.addDirectory(selection.filePaths[0])) }
    } catch {
      return catalogFailure("The selected plug-in directory could not be added.")
    }
  })
  ipcMain.handle(pluginCatalogRemoveDirectoryChannel, async (event, value) => {
    const store = catalogStoreFor(event)

    if (!store) return catalogFailure("The desktop plug-in catalog is unavailable.")
    const request = pluginDirectorySchema.safeParse(value)

    if (!request.success) return catalogFailure("A plug-in directory is required.")

    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.removeDirectory(request.data.directory)) }
    } catch {
      return catalogFailure("The plug-in directory could not be removed.")
    }
  })
  ipcMain.handle(pluginCatalogScanChannel, async (event) => {
    const store = catalogStoreFor(event)
    const scanner = catalog.scanner

    if (!store || !scanner) return catalogFailure("The desktop plug-in catalog is unavailable.")

    try {
      return { ok: true, catalog: catalogViewForRenderer(await store.scan((entry, directories) => scanner.scan(entry, directories))) }
    } catch {
      return catalogFailure("The plug-in catalog could not be scanned.")
    }
  })
  ipcMain.handle(pluginCatalogPreflightInsertionChannel, async (event, value) => {
    const store = catalogStoreFor(event)
    const request = nativeVst3InsertionPreflightRequestSchema.safeParse(value)
    const workerPath = catalog.workerPath

    if (!store || !request.success) {
      return { ok: false as const, code: "untrusted-catalog" as const, message: "The native VST3 insertion request is invalid." }
    }

    if (!audioHostAllowed(event) || !hostPath || !workerPath) {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host is unavailable." }
    }

    const scanner = catalog.scanner

    if (!scanner) {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 scanner is unavailable." }
    }

    try {
      const device = await probeNativeAudioOutputDevice(hostPath)

      if (!device?.available) {
        return { ok: false as const, code: "host-unavailable" as const, message: "No native audio output device is available." }
      }

      const preflightInput: Parameters<typeof preflightVst3Insertion>[0] = {
        request: request.data,
        catalog: await store.load(),
        workerPath,
        sampleRateHz: device.nominalSampleRateHz,
        maximumFramesPerBlock: Math.min(device.maximumFramesPerBlock, maxVst3WorkerFrames),
        evidence: ae08Evidence,
        workerEnvironment: ae08WorkerEnvironment,
        rememberVerdict: (attachment, result) => {
          attachmentLedger.rememberVerdict(attachment, device.nominalSampleRateHz, result)
        },
      }

      const first = await preflightVst3Insertion(preflightInput)

      if (first.ok || first.code !== "stale-catalog") return first
      await store.revalidate((entry, directories) => scanner.scan(entry, directories))

      return preflightVst3Insertion({
        ...preflightInput,
        catalog: await store.load(),
      })
    } catch {
      return { ok: false as const, code: "host-unavailable" as const, message: "The native VST3 host preflight failed." }
    }
  })
}
