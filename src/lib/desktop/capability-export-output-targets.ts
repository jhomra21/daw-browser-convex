import type { ExportFileSink, ExportOutputTargetFactory } from "~/lib/export/export-output-targets"
import type { StreamTargetChunk } from "mediabunny"
import {
  isLocalId,
  type ExportAudioFormat,
} from "@daw-browser/shared"
import { saveCloudExport } from "~/lib/cloud-export"
import { exportOutputPickerStatus } from "~/lib/export/export-output-picker-status"
import { z } from "zod"

type CapabilityWriter = {
  requestId: string
  writerId: string
  name: string
}

type DesktopCapabilityBridge = {
  beginWrite: (requestId: string, token: string, relativePath?: string) => Promise<{ writerId: string }>
  writeChunk: (requestId: string, writerId: string, offset: number, chunk: Uint8Array) => Promise<{ nextOffset: number }>
  commit: (requestId: string, writerId: string) => Promise<{ basename: string; byteLength: number; mime: string }>
  abort: (requestId: string, writerId: string) => Promise<void>
}

const maximumCapabilityChunkBytes = 1024 * 1024
const capabilityCommitErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
}).passthrough()

export const desktopExportResourceLimits = {
  maximumFiles: 1_024,
  streaming: true,
} satisfies NonNullable<ExportOutputTargetFactory["resourceLimits"]>

const createSink = (bridge: DesktopCapabilityBridge, writer: CapabilityWriter): ExportFileSink => {
  let highWaterMark = 0
  let settled = false
  let operation = Promise.resolve()
  const abort = async () => {
    if (settled) return
    settled = true
    await operation
    await bridge.abort(writer.requestId, writer.writerId)
  }
  const commit = async () => {
    if (settled) return { byteLength: highWaterMark }
    await operation
    try {
      const result = await bridge.commit(writer.requestId, writer.writerId)
      settled = true
      return { byteLength: result.byteLength }
    } catch (error) {
      const parsed = capabilityCommitErrorSchema.safeParse(error)
      if (
        parsed.success
        && (
          parsed.data.code === "commit-indeterminate"
          || parsed.data.message?.includes("indeterminate terminal state") === true
        )
      ) settled = true
      throw error
    }
  }
  return {
    name: writer.name,
    target: {
      mode: "stream",
      writable: new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          if (settled) throw new Error("Desktop export output is closed.")
          const write = operation.then(async () => {
            let position = chunk.position
            for (let start = 0; start < chunk.data.byteLength; start += maximumCapabilityChunkBytes) {
              const data = chunk.data.subarray(start, Math.min(start + maximumCapabilityChunkBytes, chunk.data.byteLength))
              const result = await bridge.writeChunk(writer.requestId, writer.writerId, position, data)
              position = result.nextOffset
            }
            highWaterMark = Math.max(highWaterMark, position)
          })
          operation = write.catch(() => undefined)
          await write
        },
        close: async () => { await commit() },
        abort,
      }),
      close: async () => { await commit() },
      abort,
    },
    commit,
    abort,
  }
}

export const createDesktopCapabilityExportOutputTargetFactory = (
  bridge: DesktopCapabilityBridge,
  requestId: string,
  output: { token: string; basename?: string; directory: boolean },
): ExportOutputTargetFactory => {
  const openFile = async (name: string) => {
    const { writerId } = await bridge.beginWrite(
      requestId,
      output.token,
      output.directory ? name : undefined,
    )
    return createSink(bridge, { requestId, writerId, name: output.directory ? name : output.basename ?? name })
  }
  return {
    resourceLimits: desktopExportResourceLimits,
    async createMixdownTarget() {
      return {
        openFile,
        async saveBuffer() {
          throw new Error("Desktop export requires a streamed output capability.")
        },
      }
    },
    async createStemTarget() {
      return { openFile }
    },
  }
}

type DesktopRendererExportBridge = DesktopCapabilityBridge & {
  pickOutputFile: (
    requestId: string,
    format: ExportAudioFormat,
  ) => Promise<{ canceled: true } | { canceled: false; file: { token: string; basename: string } }>
  pickOutputDirectory: (
    requestId: string,
  ) => Promise<{ canceled: true } | { canceled: false; directory: { token: string; basename: string } }>
  releaseExportOutput: (requestId: string) => Promise<void>
}

const exportCanceled = () => new DOMException("The export was canceled.", "AbortError")

const pickExportOutput = async <Value>(pick: () => Promise<Value>): Promise<Value> => {
  exportOutputPickerStatus.set(true)
  try {
    return await pick()
  } finally {
    exportOutputPickerStatus.set(false)
  }
}

export const createDesktopRendererExportOutputTargetFactory = (
  bridge: DesktopRendererExportBridge,
): ExportOutputTargetFactory => ({
  resourceLimits: desktopExportResourceLimits,
  async createMixdownTarget(input) {
    if (!input.localProject) {
      return {
        openFile: async () => undefined,
        saveBuffer: async ({ blob, fileName, format, durationSec, sampleRate, signal }) => {
          if (!input.projectId || isLocalId("project", input.projectId)) throw new Error("Missing room")
          const upload = await saveCloudExport({
            projectId: input.projectId,
            blob,
            name: fileName,
            format,
            durationSec,
            sampleRate,
            signal,
          })
          return { destination: "cloud" as const, name: fileName, url: upload.url }
        },
      }
    }
    const requestId = crypto.randomUUID()
    if (input.multiFormat) {
      const selected = await pickExportOutput(() => bridge.pickOutputDirectory(requestId))
      if (selected.canceled) {
        await bridge.releaseExportOutput(requestId)
        throw exportCanceled()
      }
      const target = createDesktopCapabilityExportOutputTargetFactory(bridge, requestId, {
        token: selected.directory.token,
        basename: selected.directory.basename,
        directory: true,
      })
      return {
        ...(await target.createMixdownTarget(input)),
        dispose: async () => { await bridge.releaseExportOutput(requestId) },
      }
    }
    const selected = await pickExportOutput(() => bridge.pickOutputFile(requestId, input.firstFormat))
    if (selected.canceled) {
      await bridge.releaseExportOutput(requestId)
      throw exportCanceled()
    }
    const target = createDesktopCapabilityExportOutputTargetFactory(bridge, requestId, {
      token: selected.file.token,
      basename: selected.file.basename,
      directory: false,
    })
    return {
      ...(await target.createMixdownTarget(input)),
      dispose: async () => { await bridge.releaseExportOutput(requestId) },
    }
  },
  async createStemTarget() {
    throw new Error("Desktop export stems are unavailable; choose Main mixdown.")
  },
})
