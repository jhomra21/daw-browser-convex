import path from "node:path"
import {
  canonicalJson,
} from "@daw-browser/control"
import {
  desktopRequestSchemaV1,
  desktopProtocolVersion,
  type DesktopControlOperationV1,
} from "@daw-browser/desktop-protocol"
import { createHostClient, DesktopControlError, DesktopHostError } from "./host"
import { jsonRequest, option, type CliIo } from "./input"

export { DesktopControlError, DesktopHostError } from "./host"

const audioExtension = (value: string) => [".wav", ".mp3", ".ogg", ".flac", ".m4a", ".webm"].includes(path.extname(value).toLowerCase())
const absoluteAudioPath = (value: string) => path.isAbsolute(value) && path.normalize(value) === value && audioExtension(value)
const validateHostExportInput = (input: unknown) => {
  if (typeof input !== "object" || input === null || !("mode" in input) || (input.mode !== "mixdown" && input.mode !== "stems") || !("destination" in input) || typeof input.destination !== "object" || input.destination === null || !("kind" in input.destination)) {
    throw new Error("Invalid host export request.")
  }
  const destination = input.destination
  if ((destination.kind === "file" || destination.kind === "directory") && (!("path" in destination) || typeof destination.path !== "string" || !path.isAbsolute(destination.path) || path.normalize(destination.path) !== destination.path || (destination.kind === "file" && !audioExtension(destination.path)))) {
    throw new Error("Invalid host export media path.")
  }
}

export class HostTargetUnavailableError extends Error {
  readonly data = {
    version: "v1" as const,
    code: "unavailable" as const,
    message: "Desktop control host is unavailable.",
  }

  constructor() {
    super("Desktop control host is unavailable.")
    this.name = "HostTargetUnavailableError"
  }
}

export const requestHostControl = async (operation: DesktopControlOperationV1, input: unknown) => {
  try {
    const client = await createHostClient()
    try {
      return await client.request(operation, input)
    } finally {
      client.close()
    }
  } catch (cause) {
    if (cause instanceof DesktopControlError || cause instanceof DesktopHostError) throw cause
    throw new HostTargetUnavailableError()
  }
}

export const requestHostControlV2 = async (operation: "control.capabilities" | "control.snapshot", input: unknown) => {
  try {
    const client = await createHostClient()
    try {
      return await client.requestV2(operation, input)
    } finally {
      client.close()
    }
  } catch (cause) {
    if (cause instanceof DesktopControlError || cause instanceof DesktopHostError) throw cause
    throw new HostTargetUnavailableError()
  }
}

export const runHostCommand = async (arguments_: string[], io: CliIo) => {
  const [action, value, ...extra] = arguments_
  if (!action) throw new Error("Invalid host command.")
  if (action === "import") {
    const pathValue = option(arguments_.slice(1), "--path")
    const picker = arguments_.length === 2 && arguments_[1] === "--picker"
    if ((!pathValue && !picker) || (pathValue && arguments_.length !== 3) || (picker && arguments_.length !== 2)) throw new Error("host import requires exactly one of --path <absolute-path> or --picker.")
    if (pathValue && !absoluteAudioPath(pathValue)) throw new Error("host import requires an absolute supported audio path.")
    const source = picker ? { kind: "picker" } : { kind: "path", path: pathValue }
    const client = await createHostClient()
    try {
      const data = await client.request("host.import.audio", { source })
      io.stdout(canonicalJson({ version: "v1", ok: true, command: "host import", data }))
      return 0
    } finally { client.close() }
  }
  if (action === "export") {
    const source = option(arguments_.slice(1), "--request")
    if (!source || arguments_.length !== 3 || arguments_[1] !== "--request") throw new Error("host export requires --request <file|->.")
    const requestInput = await jsonRequest(source, io)
    validateHostExportInput(requestInput)
    const input = desktopRequestSchemaV1.parse({ version: desktopProtocolVersion, type: "request", id: "cli-validation", operation: "host.export.run", input: requestInput }).input
    const client = await createHostClient()
    try {
      const data = await client.request("host.export.run", input)
      io.stdout(canonicalJson({ version: "v1", ok: true, command: "host export", data }))
      return 0
    } finally { client.close() }
  }
  if (action === "export-status" || action === "export-cancel") {
    if ((action === "export-status" && arguments_.length !== 1) || (action === "export-cancel" && arguments_.length !== 2)) throw new Error("Invalid host export command.")
    const operation = action === "export-status" ? "host.export.status" : "host.export.cancel"
    const input = action === "export-status" ? {} : { jobId: value }
    desktopRequestSchemaV1.parse({ version: desktopProtocolVersion, type: "request", id: "cli-validation", operation, input })
    const client = await createHostClient()
    try {
      const data = await client.request(operation, input)
      io.stdout(canonicalJson({ version: "v1", ok: true, command: `host ${action}`, data }))
      return 0
    } finally { client.close() }
  }
  if (extra.length !== 0 || (action !== "seek" && value !== undefined)) throw new Error("Invalid host command.")
  const operation = action === "status" ? "host.status"
    : action === "transport-status" ? "transport.status"
      : action === "play" ? "transport.play"
        : action === "pause" ? "transport.pause"
          : action === "stop" ? "transport.stop"
            : action === "diagnostics" ? "diagnostics.snapshot"
              : action === "seek" ? "transport.seek" : undefined
  if (!operation) throw new Error("Invalid host command.")
  const input = action === "seek" ? { seconds: Number(value) } : {}
  if (action === "seek" && !Number.isFinite(input.seconds)) throw new Error("host seek requires a finite number of seconds.")
  const validation = desktopRequestSchemaV1.safeParse({
    version: desktopProtocolVersion, type: "request", id: "cli-validation", operation, input,
  })
  if (!validation.success) throw new Error("Invalid host command.")
  const client = await createHostClient()
  try {
    const data = await client.request(operation, input)
    io.stdout(canonicalJson({ version: "v1", ok: true, command: `host ${action}`, data }))
    return 0
  } finally {
    client.close()
  }
}
