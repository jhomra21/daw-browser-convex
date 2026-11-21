import { app, BrowserWindow, dialog, screen, shell } from "electron"
import { totalmem } from "node:os"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { createCloseHandler, prepareForClose } from "./close-flow"
import { installBenchmarkWindowTelemetry } from "./benchmark-runtime"
import type { NativeAudioSession } from "./native-audio-session"
import type { RendererSession } from "./renderer-session"

const externalUrl = (url: string) => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

const closePreparationResultSchema = z.object({ flushed: z.literal(true) }).passthrough()

const preloadPath = path.join(import.meta.dirname, "preload.js")

export const createMainWindow = (options: {
  rendererSession: RendererSession
  sameAppOrigin: (url: string) => boolean
  invalidateRendererGeneration: (message: string) => void
  applyRendererInvalidation: (invalidation: { previousGeneration: number; generation: number }, message: string) => void
  audio: NativeAudioSession
  prepareQuit: () => Promise<void>
  finishQuit: () => Promise<void>
}) => {
  const { rendererSession, sameAppOrigin, invalidateRendererGeneration, applyRendererInvalidation, prepareQuit, finishQuit } = options

  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL && !existsSync(preloadPath)) {
    throw new Error(`Desktop preload bundle is missing: ${preloadPath}`)
  }

  const { workArea } = screen.getPrimaryDisplay()
  const minWidth = Math.min(1200, workArea.width)
  const minHeight = Math.min(800, workArea.height)

  const mainWindow = new BrowserWindow({
    width: minWidth,
    height: minHeight,
    minWidth,
    minHeight,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--daw-total-memory-bytes=${totalmem()}`],
      webSecurity: true,
    },
  })

  rendererSession.setWindow(mainWindow)
  // Maximize before the first paint; the minimum-size frame stays as the restore size.
  mainWindow.maximize()
  mainWindow.show()
  installBenchmarkWindowTelemetry({
    app,
    window: mainWindow,
    getGeneration: () => rendererSession.generation(),
    sameAppOrigin,
  })
  mainWindow?.on("closed", () => {
    invalidateRendererGeneration("Renderer destroyed.")
    rendererSession.setWindow(undefined)
  })
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      const invalidation = rendererSession.lifecycle.beginMainFrameNavigation(details.url)

      if (invalidation) applyRendererInvalidation(invalidation, "Renderer reloaded.")
    }
  })
  mainWindow.webContents.on("did-navigate", (_event, url) => {
    rendererSession.lifecycle.commitMainFrameNavigation(url)
  })
  mainWindow.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    rendererSession.lifecycle.failMainFrameNavigation(validatedURL)
  })
  mainWindow.webContents.on("did-stop-loading", () => {
    // Electron 43 has no navigationId in these typings; this boundary confirms
    // a previously committed, non-ambiguous attempt before privileged IPC resumes.
    rendererSession.lifecycle.confirmMainFrameNavigation()
  })
  mainWindow.webContents.on("render-process-gone", () => {
    const invalidation = rendererSession.lifecycle.invalidateAfterCrash()

    if (invalidation) applyRendererInvalidation(invalidation, "Renderer crashed.")
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url)) void shell.openExternal(url)

    return { action: "deny" }
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!sameAppOrigin(url)) event.preventDefault()
  })

  const close = createCloseHandler({
    waitForRecording: async () => {
      const supervisor = options.audio.supervisor

      if (!supervisor?.recordingFinalizationPending()) {
        await supervisor?.waitForRecordingFinish()

        return true
      }

      const abort = new AbortController()
      const finishing = supervisor.waitForRecordingFinish().then(() => true)

      const choice = dialog.showMessageBox(mainWindow, {
        type: "info", message: "The recording is finishing.",
        detail: "The completed take is being saved. Keep the application open while storage finishes.",
        buttons: ["Keep Open"], defaultId: 0, cancelId: 0, signal: abort.signal,
      }).then(() => false)

      try { return await Promise.race([finishing, choice]) }
      finally { abort.abort() }
    },
    onError: async () => {
      await dialog.showMessageBox(mainWindow, { type: "error", buttons: ["Keep Open"],
        message: "The application could not finish closing safely.",
        detail: "The project remains open. Recording sources have not been discarded." })
    },
    prepareQuit,
    prepare: () => prepareForClose({
      flushRenderer: async () => closePreparationResultSchema.safeParse((await rendererSession.request("lifecycle.prepareToClose", {}, randomUUID(), 10_000)).result).success,
      captureEditors: async () => { await options.audio.editorSessions?.captureAll() },
    }),
    confirmDiscard: async () => {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        buttons: ["Cancel", "Quit and Discard"],
        defaultId: 0,
        cancelId: 0,
        message: "The project could not finish saving before closing.",
        detail: "Cancel keeps the project open. Quit and Discard discards unsaved project changes, never an accepted recording Finish.",
        noLink: true,
      })

      return choice.response === 1
    },
    beginQuit: () => {
      rendererSession.beginQuit()
    },
    destroy: () => rendererSession.window()?.destroy(),
    finishQuit,
  })

  mainWindow.on("close", (event) => {
    if (mainWindow.isDestroyed() || rendererSession.finishingQuit()) return
    event.preventDefault()
    void close()
  })
  void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "daw://app/")
}
