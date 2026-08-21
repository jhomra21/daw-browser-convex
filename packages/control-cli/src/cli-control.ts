import {
  canonicalJson,
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlHistoryQuerySchemaV1,
  controlPreviewRequestSchemaV1,
  controlRecoveriesQuerySchemaV1,
  controlSnapshotQuerySchemaV1,
} from "@daw-browser/control"
import type {
  desktopControlOperationDescriptorsV1,
} from "@daw-browser/desktop-protocol"
import { cloudCanonicalControlMethods, cloudClient } from "./cli-auth"
import { jsonRequest, option, type CliIo } from "./input"
import { requestHostControl, requestHostControlV2 } from "./cli-host"
import {
  createCanonicalControlClient,
  createJsonlRpcAdapter,
  processJsonlLines,
} from "@daw-browser/control-sdk"
import { connectDesktopControl } from "@daw-browser/control-sdk/desktop"
import { cliDesktopControlOptions } from "./desktop-options"

type ControlTarget = "cloud" | "host"

export const canonicalControlOperations = {
  capabilities: "control.capabilities",
  "capabilities-v2": "control.capabilities",
  snapshot: "control.snapshot",
  "snapshot-v2": "control.snapshot",
  preview: "control.preview",
  approval: "control.requestApproval",
  commit: "control.commit",
  history: "control.history",
  recoveries: "control.recoveries",
} satisfies Record<string, keyof typeof desktopControlOperationDescriptorsV1>

type CanonicalCommand = keyof typeof canonicalControlOperations
export const isCanonicalCommand = (command: string): command is CanonicalCommand => Object.hasOwn(canonicalControlOperations, command)

type ControlRouting = {
  target: ControlTarget
  arguments_: string[]
}

const stripTarget = (arguments_: string[]): ControlRouting => {
  let target: ControlTarget = "cloud"
  let targetSeen = false
  const rest: string[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]
    if (value !== "--target") {
      rest.push(value)
      continue
    }
    if (targetSeen || index + 1 >= arguments_.length) throw new Error("Invalid control target.")
    const targetValue = arguments_[index + 1]
    if (targetValue !== "cloud" && targetValue !== "host") throw new Error("Invalid control target.")
    target = targetValue
    targetSeen = true
    index += 1
  }
  return { target, arguments_: rest }
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

export const runControlCommand = async (command: CanonicalCommand, arguments_: string[], io: CliIo) => {
  const routing = stripTarget(arguments_)
  const canonicalArguments = routing.arguments_
  let data: unknown
  if (command === "capabilities" || command === "capabilities-v2") {
    if (canonicalArguments.length !== 0) throw new Error(`${command} accepts no arguments.`)
    if (routing.target === "host") {
      data = command === "capabilities-v2"
        ? await requestHostControlV2("control.capabilities", {})
        : await requestHostControl(canonicalControlOperations[command], {})
    } else {
      const client = await cloudClient()
      const canonical = await cloudCanonicalControlMethods()
      data = command === "capabilities" ? await client.capabilities() : await canonical.capabilities({})
    }
  } else if (command === "snapshot" || command === "snapshot-v2") {
    if (canonicalArguments.length !== 1) throw new Error(`${command} requires a project ID.`)
    const input = controlSnapshotQuerySchemaV1.parse({ projectId: canonicalArguments[0] })
    if (routing.target === "host") {
      data = command === "snapshot-v2"
        ? await requestHostControlV2("control.snapshot", input)
        : await requestHostControl(canonicalControlOperations[command], input)
    } else {
      const client = await cloudClient()
      const canonical = await cloudCanonicalControlMethods()
      data = command === "snapshot"
        ? await client.snapshot(input.projectId)
        : await canonical.snapshot(input)
    }
  } else if (command === "preview" || command === "approval" || command === "commit") {
    const source = option(canonicalArguments, "--request")
    if (!source || canonicalArguments.length !== 2 || canonicalArguments[0] !== "--request") throw new Error(`${command} requires --request <file|->.`)
    const parsed = await jsonRequest(source, io)
    const input = command === "preview"
      ? controlPreviewRequestSchemaV1.parse(parsed)
      : command === "approval"
        ? controlApprovalRequestSchemaV1.parse(parsed)
        : controlCommitRequestSchemaV1.parse(parsed)
    if (routing.target === "host") {
      data = await requestHostControl(canonicalControlOperations[command], input)
    } else {
      const canonical = await cloudCanonicalControlMethods()
      if (command === "preview") data = await canonical.preview(input)
      else if (command === "approval") data = await canonical.requestApproval(input)
      else data = await canonical.commit(controlCommitRequestSchemaV1.parse(input))
    }
  } else {
    const { projectId, cursor, limit } = historyArguments(canonicalArguments)
    const query = {
      projectId,
      cursor,
      limit: limit === undefined ? undefined : Number(limit),
    }
    const input = command === "history"
      ? controlHistoryQuerySchemaV1.parse(query)
      : controlRecoveriesQuerySchemaV1.parse(query)
    if (routing.target === "host") {
      data = await requestHostControl(canonicalControlOperations[command], input)
    } else {
      const canonical = await cloudCanonicalControlMethods()
      data = command === "history" ? await canonical.history(input) : await canonical.recoveries(input)
    }
  }
  io.stdout(canonicalJson(JSON.parse(JSON.stringify({ version: "v1", ok: true, command, data }))))
  return 0
}

export const runProjectCommand = async (command: "list" | "current", arguments_: string[], io: CliIo) => {
  const routing = stripTarget(arguments_)
  if (routing.arguments_.length !== 0) throw new Error(`project ${command} accepts no arguments.`)
  if (routing.target === "host") {
    if (command === "current") {
      const host = await connectDesktopControl(cliDesktopControlOptions())
      try {
        const client = createCanonicalControlClient(host.invoker)
        io.stdout(canonicalJson({ version: "v1", ok: true, command: "project current", data: await client.projects.current({}) }))
      } finally {
        host.close()
      }
      return 0
    }
    const host = await connectDesktopControl(cliDesktopControlOptions())
    try {
      const client = createCanonicalControlClient(host.invoker)
      io.stdout(canonicalJson({ version: "v1", ok: true, command: "project list", data: await client.projects.list({}) }))
    } finally {
      host.close()
    }
    return 0
  }
  if (command === "current") throw new Error("project current is supported only on the host target.")
  const client = await cloudClient()
  io.stdout(canonicalJson({ version: "v1", ok: true, command: "project list", data: await client.projects.list() }))
  return 0
}

export const runRpcCommand = async (arguments_: string[], io: CliIo) => {
  if (arguments_.length !== 2 || arguments_[0] !== "--target" || arguments_[1] !== "host") {
    throw new Error("rpc requires --target host.")
  }
  if (!io.readLines) throw new Error("rpc stdio input is unavailable.")
  const host = await connectDesktopControl(cliDesktopControlOptions())
  try {
    const adapter = createJsonlRpcAdapter({ invoker: host.invoker })
    await processJsonlLines(io.readLines(), adapter, io.stdout)
  } finally {
    host.close()
  }
  return 0
}
