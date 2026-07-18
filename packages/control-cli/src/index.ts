#!/usr/bin/env bun
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import {
  canonicalJson,
  controlCommitRequestSchemaV1,
  controlApprovalRequestSchemaV1,
  controlErrorSchemaV1,
  controlHistoryQuerySchemaV1,
  controlRecoveriesQuerySchemaV1,
  controlPreviewRequestSchemaV1,
  controlSnapshotQuerySchemaV1,
  controlLimitsV1,
  type ControlErrorV1,
} from "@daw-browser/control"
import { ControlApiError, createControlClient } from "@daw-browser/control-sdk"
import { createAccessTokenProvider, login, logout, normalizeBaseUrl } from "./auth"
import { credentialIdentity, createCredentialStore } from "./credentials"
import { createHostClient } from "./host"
import { desktopRequestSchemaV1, desktopProtocolVersion } from "@daw-browser/desktop-protocol"

const commandNames = [
  "auth login --base-url <origin>", "auth status", "auth logout", "capabilities",
  "snapshot <project-id>", "preview --request <file|->", "approval --request <file|->", "commit --request <file|->",
  "history <project-id> [--cursor <cursor>] [--limit <number>]",
  "recoveries <project-id> [--cursor <cursor>] [--limit <number>]",
  "host status", "host play", "host pause", "host stop", "host seek <seconds>", "host diagnostics",
  "host import (--path <absolute-path>|--picker)", "host export --request <file|->", "host export-status", "host export-cancel <job-id>",
]

type Io = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin: () => Promise<string>;
}

const processIo: Io = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readStdin: async () => {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > controlLimitsV1.maxSerializedBodyBytes) throw new Error("Request input exceeds the size limit.")
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString("utf8")
  },
}

const error = (code: ControlErrorV1["code"], message: string): ControlErrorV1 => ({
  version: "v1",
  code,
  message,
})

const toControlError = (cause: unknown): ControlErrorV1 => {
  if (cause instanceof ControlApiError) {
    return {
      version: "v1",
      code: cause.code,
      message: cause.message,
      ...(cause.details === undefined ? {} : { details: cause.details }),
      ...(cause.actionIndex === undefined ? {} : { actionIndex: cause.actionIndex }),
    }
  }
  const parsed = controlErrorSchemaV1.safeParse(cause)
  if (parsed.success) return parsed.data
  return error("invalid-request", cause instanceof Error ? cause.message.slice(0, 1000) : "Invalid command.")
}

const option = (arguments_: string[], name: string) => {
  const index = arguments_.indexOf(name)
  if (index === -1) return undefined
  const value = arguments_[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name} value.`)
  return value
}

const jsonRequest = async (source: string, io: Io) => {
  const content = source === "-" ? await io.readStdin() : await (async () => {
    const info = await stat(source)
    if (!info.isFile() || info.size > controlLimitsV1.maxSerializedBodyBytes) throw new Error("Request input exceeds the size limit.")
    return readFile(source, "utf8")
  })()
  try {
    return JSON.parse(content)
  } catch {
    throw new Error("Request input is not valid JSON.")
  }
}

const help = () => [
  "Usage: daw-control <command>",
  ...commandNames.map((name) => `  ${name}`),
].join("\n")

const baseUrlFor = (arguments_: string[]) => {
  if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== "--base-url")) {
    throw new Error("auth login accepts only --base-url <origin>.")
  }
  const explicit = arguments_.length === 2 ? arguments_[1] : undefined
  const configured = explicit ?? process.env.DAW_CONTROL_BASE_URL
  if (!configured) throw new Error("Provide --base-url.")
  return normalizeBaseUrl(configured)
}

const parseCommand = (arguments_: string[]) => {
  const [first, second, ...rest] = arguments_
  if (first === "auth" && second) return { command: `auth ${second}`, arguments_: rest }
  return { command: first ?? "", arguments_: second === undefined ? [] : [second, ...rest] }
}
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

const historyArguments = (arguments_: string[]) => {
  const [projectId, ...options] = arguments_
  if (!projectId || projectId.startsWith("--")) throw new Error("history requires a project ID.")
  let cursor: string | undefined
  let limit: string | undefined
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index]
    const value = options[index + 1]
    if (!value || value.startsWith("--") || (name !== "--cursor" && name !== "--limit")) throw new Error("Invalid history arguments.")
    if (name === "--cursor" && cursor !== undefined) throw new Error("Invalid history arguments.")
    if (name === "--limit" && limit !== undefined) throw new Error("Invalid history arguments.")
    if (name === "--cursor") cursor = value
    else limit = value
  }
  return { projectId, cursor, limit }
}

export const runCli = async (arguments_: string[], io: Io = processIo): Promise<number> => {
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
    io.stdout(help())
    return 0
  }
  const { command, arguments_: commandArguments } = parseCommand(arguments_)
  try {
    if (command === "host") {
      const [action, value, ...extra] = commandArguments
      if (!action) throw new Error("Invalid host command.")
      if (action === "import") {
        const pathValue = option(commandArguments.slice(1), "--path")
        const picker = commandArguments.length === 2 && commandArguments[1] === "--picker"
        if ((!pathValue && !picker) || (pathValue && commandArguments.length !== 3) || (picker && commandArguments.length !== 2)) throw new Error("host import requires exactly one of --path <absolute-path> or --picker.")
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
        const source = option(commandArguments.slice(1), "--request")
        if (!source || commandArguments.length !== 3 || commandArguments[1] !== "--request") throw new Error("host export requires --request <file|->.")
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
        if ((action === "export-status" && commandArguments.length !== 1) || (action === "export-cancel" && commandArguments.length !== 2)) throw new Error("Invalid host export command.")
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
        : action === "play" ? "transport.play"
          : action === "pause" ? "transport.pause"
            : action === "stop" ? "transport.stop"
              : action === "diagnostics" ? "diagnostics.snapshot"
                : action === "seek" ? "transport.seek" : undefined
      if (!operation) throw new Error("Invalid host command.")
      let input: {} | { seconds: number } = {}
      if (action === "seek") {
        const seconds = Number(value)
        if (!Number.isFinite(seconds)) throw new Error("host seek requires a finite number of seconds.")
        input = { seconds }
      }
      const validation = desktopRequestSchemaV1.safeParse({
        version: desktopProtocolVersion,
        type: "request",
        id: "cli-validation",
        operation,
        input,
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
    const store = createCredentialStore()
    if (command === "auth login") {
      const baseUrl = baseUrlFor(commandArguments)
      await login(baseUrl, { store, writeStderr: io.stderr })
      io.stdout(canonicalJson({ version: "v1", ok: true, command, data: { baseUrl } }))
      return 0
    }
    if (command === "auth status") {
      if (commandArguments.length !== 0) throw new Error("auth status accepts no arguments.")
      const credentials = await store.read()
      io.stdout(canonicalJson({
        version: "v1",
        ok: true,
        command,
        data: credentials
          ? { authenticated: true, baseUrl: credentials.baseUrl, expiresAt: credentials.expiresAt, scopes: credentials.scopes }
          : { authenticated: false },
      }))
      return 0
    }
    if (command === "auth logout") {
      if (commandArguments.length !== 0) throw new Error("auth logout accepts no arguments.")
      const result = await logout(store)
      io.stdout(canonicalJson({ version: "v1", ok: true, command, data: result }))
      return 0
    }
    const credentials = await store.read()
    if (!credentials) throw new Error("Run daw-control auth login first.")
    const client = createControlClient({
      baseUrl: credentials.baseUrl,
      accessToken: createAccessTokenProvider(credentialIdentity(credentials), store),
    })
    let data: unknown
    if (command === "capabilities") {
      if (commandArguments.length !== 0) throw new Error("capabilities accepts no arguments.")
      data = await client.capabilities()
    } else if (command === "snapshot") {
      if (commandArguments.length !== 1) throw new Error("snapshot requires a project ID.")
      data = await client.snapshot(controlSnapshotQuerySchemaV1.parse({ projectId: commandArguments[0] }).projectId)
    } else if (command === "preview" || command === "approval" || command === "commit") {
      const source = option(commandArguments, "--request")
      if (!source || commandArguments.length !== 2 || commandArguments[0] !== "--request") throw new Error(`${command} requires --request <file|->.`)
      const parsed = await jsonRequest(source, io)
      data = command === "preview"
        ? await client.preview(controlPreviewRequestSchemaV1.parse(parsed))
        : command === "approval"
          ? await client.requestApproval(controlApprovalRequestSchemaV1.parse(parsed))
          : await client.commit(controlCommitRequestSchemaV1.parse(parsed))
    } else if (command === "history" || command === "recoveries") {
      const { projectId, cursor, limit } = historyArguments(commandArguments)
      const query = {
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      }
      data = command === "history"
        ? await client.history(controlHistoryQuerySchemaV1.parse(query))
        : await client.recoveries(controlRecoveriesQuerySchemaV1.parse(query))
    } else {
      throw new Error("Unknown command.")
    }
    io.stdout(canonicalJson({ version: "v1", ok: true, command, data }))
    return 0
  } catch (cause) {
    const commandError = toControlError(cause)
    io.stderr(canonicalJson({ version: "v1", ok: false, command, error: commandError }))
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2))
  process.exitCode = exitCode
}
