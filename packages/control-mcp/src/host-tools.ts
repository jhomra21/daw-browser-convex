import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  desktopDiagnosticsSchemaV1,
  desktopEmptyInputSchemaV1,
  desktopHostStatusSchemaV1,
  desktopHostImportResultSchemaV1,
  desktopHostExportRunResultSchemaV1,
  desktopHostExportStatusSchemaV1,
  desktopHostImportInputSchemaV1,
  desktopHostExportRunInputSchemaV1,
  desktopHostExportCancelInputSchemaV1,
  desktopSeekInputSchemaV1,
  desktopTransportStatusSchemaV1,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"

export type HostToolService = {
  status: () => Promise<unknown>
  transportStatus: () => Promise<unknown>
  play: () => Promise<unknown>
  pause: () => Promise<unknown>
  stop: () => Promise<unknown>
  seek: (input: { seconds: number }) => Promise<unknown>
  diagnostics: () => Promise<unknown>
  importAudio: (input: unknown) => Promise<unknown>
  exportRun: (input: unknown) => Promise<unknown>
  exportStatus: () => Promise<unknown>
  exportCancel: (input: { jobId: string }) => Promise<unknown>
  operations?: ReadonlySet<DesktopOperationV1>
}

const local = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const text = <Value extends Record<string, unknown>>(value: Value): { structuredContent: Value; content: { type: "text"; text: string }[] } => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] })
const failure = () => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ version: "v1", code: "unavailable", message: "The local desktop host is unavailable." }) }] })
const invalid = () => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ version: "v1", code: "invalid-request", message: "Invalid local desktop host tool input." }) }] })

const invoke = async <Value extends Record<string, unknown>>(operation: () => Promise<unknown>, output: { parse: (value: unknown) => Value }) => {
  try {
    return text(output.parse(await operation()))
  } catch {
    return failure()
  }
}

export const executeHostTool = (name: string, input: unknown, service: HostToolService) => {
  const operation = name === "host_status" ? "host.status"
    : name === "host_transport_status" ? "transport.status"
      : name === "host_play" ? "transport.play"
        : name === "host_pause" ? "transport.pause"
          : name === "host_stop" ? "transport.stop"
            : name === "host_seek" ? "transport.seek"
              : name === "host_diagnostics" ? "diagnostics.snapshot"
                : name === "host_import_audio" ? "host.import.audio"
                  : name === "host_export_run" ? "host.export.run"
                    : name === "host_export_status" ? "host.export.status"
                      : name === "host_export_cancel" ? "host.export.cancel" : undefined
  if (!operation || (service.operations && !service.operations.has(operation))) return failure()
  if (name === "host_status") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.status, desktopHostStatusSchemaV1) : invalid()
  if (name === "host_transport_status") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.transportStatus, desktopTransportStatusSchemaV1) : invalid()
  if (name === "host_play") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.play, desktopTransportStatusSchemaV1) : invalid()
  if (name === "host_pause") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.pause, desktopTransportStatusSchemaV1) : invalid()
  if (name === "host_stop") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.stop, desktopTransportStatusSchemaV1) : invalid()
  const seek = desktopSeekInputSchemaV1.safeParse(input)
  if (name === "host_seek") return seek.success ? invoke(() => service.seek(seek.data), desktopTransportStatusSchemaV1) : invalid()
  if (name === "host_diagnostics") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.diagnostics, desktopDiagnosticsSchemaV1) : invalid()
  const importAudio = desktopHostImportInputSchemaV1.safeParse(input)
  if (name === "host_import_audio") return importAudio.success ? invoke(() => service.importAudio(importAudio.data), desktopHostImportResultSchemaV1) : invalid()
  const exportRun = desktopHostExportRunInputSchemaV1.safeParse(input)
  if (name === "host_export_run") return exportRun.success ? invoke(() => service.exportRun(exportRun.data), desktopHostExportRunResultSchemaV1) : invalid()
  if (name === "host_export_status") return desktopEmptyInputSchemaV1.safeParse(input).success ? invoke(service.exportStatus, desktopHostExportStatusSchemaV1) : invalid()
  const exportCancel = desktopHostExportCancelInputSchemaV1.safeParse(input)
  if (name === "host_export_cancel") return exportCancel.success ? invoke(() => service.exportCancel(exportCancel.data), desktopHostExportStatusSchemaV1) : invalid()
  return failure()
}

export const registerHostTools = (server: McpServer, service: HostToolService) => {
  const enabled = (operation: DesktopOperationV1) => service.operations === undefined || service.operations.has(operation)
  if (enabled("host.status")) server.registerTool("host_status", { description: "Return the attached local desktop host status.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopHostStatusSchemaV1, annotations: read }, (input) => executeHostTool("host_status", input, service))
  if (enabled("transport.status")) server.registerTool("host_transport_status", { description: "Return local desktop transport status.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: read }, (input) => executeHostTool("host_transport_status", input, service))
  if (enabled("transport.play")) server.registerTool("host_play", { description: "Start playback in the open local desktop DAW.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_play", input, service))
  if (enabled("transport.pause")) server.registerTool("host_pause", { description: "Pause playback in the open local desktop DAW.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_pause", input, service))
  if (enabled("transport.stop")) server.registerTool("host_stop", { description: "Stop playback in the open local desktop DAW.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_stop", input, service))
  if (enabled("transport.seek")) server.registerTool("host_seek", { description: "Seek the open local desktop DAW transport.", inputSchema: desktopSeekInputSchemaV1, outputSchema: desktopTransportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_seek", input, service))
  if (enabled("diagnostics.snapshot")) server.registerTool("host_diagnostics", { description: "Return safe local desktop audio diagnostics.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopDiagnosticsSchemaV1, annotations: read }, (input) => executeHostTool("host_diagnostics", input, service))
  if (enabled("host.import.audio")) server.registerTool("host_import_audio", { description: "Import bounded local audio into the open desktop DAW.", inputSchema: desktopHostImportInputSchemaV1, outputSchema: desktopHostImportResultSchemaV1, annotations: local }, (input) => executeHostTool("host_import_audio", input, service))
  if (enabled("host.export.run")) server.registerTool("host_export_run", { description: "Queue a local desktop audio export.", inputSchema: desktopHostExportRunInputSchemaV1, outputSchema: desktopHostExportRunResultSchemaV1, annotations: local }, (input) => executeHostTool("host_export_run", input, service))
  if (enabled("host.export.status")) server.registerTool("host_export_status", { description: "Return the active local desktop export status.", inputSchema: desktopEmptyInputSchemaV1, outputSchema: desktopHostExportStatusSchemaV1, annotations: read }, (input) => executeHostTool("host_export_status", input, service))
  if (enabled("host.export.cancel")) server.registerTool("host_export_cancel", { description: "Cancel a local desktop export by job ID.", inputSchema: desktopHostExportCancelInputSchemaV1, outputSchema: desktopHostExportStatusSchemaV1, annotations: local }, (input) => executeHostTool("host_export_cancel", input, service))
}
