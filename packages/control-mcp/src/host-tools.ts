import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  desktopDiagnosticsSchemaV1,
  desktopEmptyInputSchemaV1,
  desktopHostStatusSchemaV1,
  desktopSeekInputSchemaV1,
  desktopTransportStatusSchemaV1,
} from "@daw-browser/desktop-protocol"

export type HostToolService = {
  status: () => Promise<unknown>
  transportStatus: () => Promise<unknown>
  play: () => Promise<unknown>
  pause: () => Promise<unknown>
  stop: () => Promise<unknown>
  seek: (input: { seconds: number }) => Promise<unknown>
  diagnostics: () => Promise<unknown>
}

const local = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const text = <Value extends Record<string, unknown>>(value: Value): { structuredContent: Value; content: { type: "text"; text: string }[] } => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] })
const failure = () => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ version: "v1", code: "unavailable", message: "The local desktop host is unavailable." }) }] })

const invoke = async <Value extends Record<string, unknown>>(operation: () => Promise<unknown>, output: { parse: (value: unknown) => Value }) => {
  try {
    return text(output.parse(await operation()))
  } catch {
    return failure()
  }
}

export const executeHostTool = (name: string, input: unknown, service: HostToolService) => {
  if (name === "host_status" && desktopEmptyInputSchemaV1.safeParse(input).success) return invoke(service.status, desktopHostStatusSchemaV1)
  if (name === "host_transport_status" && desktopEmptyInputSchemaV1.safeParse(input).success) return invoke(service.transportStatus, desktopTransportStatusSchemaV1)
  if (name === "host_play" && desktopEmptyInputSchemaV1.safeParse(input).success) return invoke(service.play, desktopTransportStatusSchemaV1)
  if (name === "host_pause" && desktopEmptyInputSchemaV1.safeParse(input).success) return invoke(service.pause, desktopTransportStatusSchemaV1)
  if (name === "host_stop" && desktopEmptyInputSchemaV1.safeParse(input).success) return invoke(service.stop, desktopTransportStatusSchemaV1)
  const seek = desktopSeekInputSchemaV1.safeParse(input)
  if (name === "host_seek" && seek.success) return invoke(() => service.seek(seek.data), desktopTransportStatusSchemaV1)
  if (name === "host_diagnostics" && desktopEmptyInputSchemaV1.safeParse(input).success) return invoke(service.diagnostics, desktopDiagnosticsSchemaV1)
  return failure()
}

export const registerHostTools = (server: McpServer, service: HostToolService) => {
  server.registerTool("host_status", { description: "Return the attached local desktop host status.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopHostStatusSchemaV1, annotations: read }, (input) => executeHostTool("host_status", input, service))
  server.registerTool("host_transport_status", { description: "Return local desktop transport status.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: read }, (input) => executeHostTool("host_transport_status", input, service))
  server.registerTool("host_play", { description: "Start playback in the open local desktop DAW.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_play", input, service))
  server.registerTool("host_pause", { description: "Pause playback in the open local desktop DAW.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_pause", input, service))
  server.registerTool("host_stop", { description: "Stop playback in the open local desktop DAW.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_stop", input, service))
  server.registerTool("host_seek", { description: "Seek the open local desktop DAW transport.", inputSchema: desktopSeekInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_seek", input, service))
  server.registerTool("host_diagnostics", { description: "Return safe local desktop audio diagnostics.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopDiagnosticsSchemaV1, annotations: read }, (input) => executeHostTool("host_diagnostics", input, service))
}
