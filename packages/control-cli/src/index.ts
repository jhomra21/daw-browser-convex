#!/usr/bin/env bun
import {
  canonicalJson,
  controlErrorSchemaV1,
  type ControlErrorV1,
} from "@daw-browser/control"
import { hostError, type HostErrorV1 } from "@daw-browser/desktop-protocol"
import { ControlApiError, ControlTransportError } from "@daw-browser/control-sdk"
import { runAuthCommand } from "./cli-auth"
import { isCanonicalCommand, runControlCommand } from "./cli-control"
export { canonicalControlOperations } from "./cli-control"
import {
  DesktopControlError,
  DesktopHostError,
  HostTargetUnavailableError,
  runHostCommand,
} from "./cli-host"
import { processIo, type CliIo } from "./input"

const commandNames = [
  "auth login --base-url <origin>", "auth status", "auth logout", "capabilities [--target <cloud|host>]", "capabilities-v2 [--target <cloud|host>]",
  "snapshot <project-id> [--target <cloud|host>]", "snapshot-v2 <project-id> [--target <cloud|host>]", "preview --request <file|-> [--target <cloud|host>]", "approval --request <file|-> [--target <cloud|host>]", "commit --request <file|-> [--target <cloud|host>]",
  "history <project-id> [--cursor <cursor>] [--limit <number>] [--target <cloud|host>]",
  "recoveries <project-id> [--cursor <cursor>] [--limit <number>] [--target <cloud|host>]",
  "host status", "host transport-status", "host play", "host pause", "host stop", "host seek <seconds>", "host diagnostics",
  "host import (--path <absolute-path>|--picker)", "host export --request <file|->", "host export-status", "host export-cancel <job-id>",
]

const error = (code: ControlErrorV1["code"], message: string): ControlErrorV1 => ({
  version: "v1",
  code,
  message,
})

const toCommandError = (cause: unknown): ControlErrorV1 | HostErrorV1 => {
  if (cause instanceof ControlApiError) return cause.data
  if (cause instanceof ControlTransportError) return hostError("unavailable", "Cloud control service is unavailable.")
  if (cause instanceof DesktopControlError || cause instanceof HostTargetUnavailableError) return cause.data
  if (cause instanceof DesktopHostError) return hostError(cause.data.code, cause.data.message)
  const parsed = controlErrorSchemaV1.safeParse(cause)
  if (parsed.success) return parsed.data
  return error("invalid-request", cause instanceof Error ? cause.message.slice(0, 1000) : "Invalid command.")
}

const help = () => [
  "Usage: daw-control <command>",
  ...commandNames.map((name) => `  ${name}`),
].join("\n")

const parseCommand = (arguments_: string[]) => {
  const [first, second, ...rest] = arguments_
  if (first === "auth" && second) return { command: `auth ${second}`, arguments_: rest }
  return { command: first ?? "", arguments_: second === undefined ? [] : [second, ...rest] }
}
export const runCli = async (arguments_: string[], io: CliIo = processIo): Promise<number> => {
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
    io.stdout(help())
    return 0
  }
  const { command, arguments_: commandArguments } = parseCommand(arguments_)
  try {
    if (command === "host") return await runHostCommand(commandArguments, io)
    const authResult = await runAuthCommand(command, commandArguments, io)
    if (authResult !== undefined) return authResult
    if (!isCanonicalCommand(command)) throw new Error("Unknown command.")
    return await runControlCommand(command, commandArguments, io)
  } catch (cause) {
    const commandError = toCommandError(cause)
    io.stderr(canonicalJson({ version: "v1", ok: false, command, error: commandError }))
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2))
  process.exitCode = exitCode
}
