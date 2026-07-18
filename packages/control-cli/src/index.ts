#!/usr/bin/env bun
import { readFile, stat } from "node:fs/promises"
import {
  canonicalJson,
  controlCommitRequestSchemaV1,
  controlApprovalRequestSchemaV1,
  controlErrorSchemaV1,
  controlHistoryQuerySchemaV1,
  controlPreviewRequestSchemaV1,
  controlSnapshotQuerySchemaV1,
  controlLimitsV1,
  type ControlErrorV1,
} from "@daw-browser/control"
import { ControlApiError, createControlClient } from "@daw-browser/control-sdk"
import { createAccessTokenProvider, login, logout, normalizeBaseUrl } from "./auth"
import { credentialIdentity, createCredentialStore } from "./credentials"

const commandNames = [
  "auth login --base-url <origin>", "auth status", "auth logout", "capabilities",
  "snapshot <project-id>", "preview --request <file|->", "approval --request <file|->", "commit --request <file|->",
  "history <project-id> [--cursor <cursor>] [--limit <number>]",
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
    } else if (command === "history") {
      const { projectId, cursor, limit } = historyArguments(commandArguments)
      data = await client.history(controlHistoryQuerySchemaV1.parse({
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      }))
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
