import type { IpcMain } from "electron"
import {
  capabilityAbortChannel,
  capabilityBeginWriteChannel,
  capabilityCommitChannel,
  capabilityReadChunkChannel,
  capabilityWriteChunkChannel,
  exportPickOutputDirectoryChannel,
  exportPickOutputFileChannel,
  exportReleaseOutputChannel,
} from "@daw-browser/desktop-protocol/ipc-channels"
import { desktopCapabilityMaximumChunkBytes } from "@daw-browser/desktop-protocol"
import { z } from "zod"
import type { createFileCapabilityManager } from "../file-capabilities"

type FileCapabilities = ReturnType<typeof createFileCapabilityManager>

export const registerFileCapabilitiesIpc = (dependencies: {
  ipcMain: IpcMain
  scopeAllowed: (event: Electron.IpcMainInvokeEvent) => boolean
  scopeFor: (event: Electron.IpcMainInvokeEvent, requestId: string) => { requestId: string; rendererGeneration: number } | undefined
  fileCapabilities: FileCapabilities
  requestIdSchema: z.ZodString
}) => {
  const outputFilePickerSchema = z.object({
    requestId: dependencies.requestIdSchema,
    format: z.enum(["wav", "mp3", "ogg-opus", "flac"]),
  }).strict()
  const exactIpcScopeSchema = z.object({ requestId: dependencies.requestIdSchema }).strict()
  const capabilityReadSchema = z.object({
    requestId: dependencies.requestIdSchema,
    token: z.string(),
    offset: z.number().int().nonnegative().safe(),
    length: z.number().int().positive().max(desktopCapabilityMaximumChunkBytes).safe(),
  }).passthrough()
  const capabilityBeginWriteSchema = z.object({
    requestId: dependencies.requestIdSchema,
    token: z.string(),
    relativePath: z.string().optional(),
  }).passthrough()
  const capabilityWriteChunkSchema = z.object({
    requestId: dependencies.requestIdSchema,
    writerId: z.string(),
    offset: z.number(),
    chunk: z.instanceof(Uint8Array),
  }).passthrough()
  const capabilityWriterSchema = z.object({
    requestId: dependencies.requestIdSchema,
    writerId: z.string(),
  }).passthrough()

  dependencies.ipcMain.handle(exportPickOutputFileChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid export output picker request.")
    const request = outputFilePickerSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid export output picker request.")
    const selected = await dependencies.fileCapabilities.pickOutputFile(scope, request.data.format)
    if (selected.canceled) return selected
    return { canceled: false as const, file: { token: selected.file.token, basename: selected.file.basename } }
  })
  dependencies.ipcMain.handle(exportPickOutputDirectoryChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid export output picker request.")
    const request = exactIpcScopeSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope) throw new Error("Invalid export output picker request.")
    const selected = await dependencies.fileCapabilities.pickDirectory(scope)
    if (selected.canceled) return selected
    return { canceled: false as const, directory: { token: selected.directory.token, basename: selected.directory.basename } }
  })
  dependencies.ipcMain.handle(exportReleaseOutputChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid export output release request.")
    const request = exactIpcScopeSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope) throw new Error("Invalid export output release request.")
    await dependencies.fileCapabilities.revokeRequest(scope)
  })
  dependencies.ipcMain.handle(capabilityReadChunkChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityReadSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return dependencies.fileCapabilities.readFile(scope, request.data.token, request.data.offset, request.data.length)
  })
  dependencies.ipcMain.handle(capabilityBeginWriteChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityBeginWriteSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return dependencies.fileCapabilities.beginWrite(scope, request.data.token, request.data.relativePath)
  })
  dependencies.ipcMain.handle(capabilityWriteChunkChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityWriteChunkSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return dependencies.fileCapabilities.writeChunk(
      scope,
      request.data.writerId,
      request.data.offset,
      request.data.chunk,
    )
  })
  dependencies.ipcMain.handle(capabilityCommitChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityWriterSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    return dependencies.fileCapabilities.commitWrite(scope, request.data.writerId)
  })
  dependencies.ipcMain.handle(capabilityAbortChannel, async (event, value) => {
    if (!dependencies.scopeAllowed(event)) throw new Error("Invalid capability request.")
    const request = capabilityWriterSchema.safeParse(value)
    const scope = request.success ? dependencies.scopeFor(event, request.data.requestId) : undefined
    if (!scope || !request.success) throw new Error("Invalid capability request.")
    await dependencies.fileCapabilities.abortWrite(scope, request.data.writerId)
  })
}
