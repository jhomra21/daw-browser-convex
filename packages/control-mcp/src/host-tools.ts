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
  desktopHostVstInstancesInputSchemaV1,
  desktopHostVstInstancesResultSchemaV1,
  desktopHostVstParametersInputSchemaV1,
  desktopHostVstParametersResultSchemaV1,
  desktopSeekInputSchemaV1,
  desktopTransportStatusSchemaV1,
  type DesktopOperationV1,
  type DesktopOperationMapV1,
} from "@daw-browser/desktop-protocol"

type HostOperation = Exclude<DesktopOperationV1, "control.capabilities" | "control.snapshot" | "control.preview" | "control.commit" | "control.requestApproval" | "control.history" | "control.recoveries">
type HostToolInput = Parameters<typeof desktopEmptyInputSchemaV1.parse>[0]
type HostToolResult = DesktopOperationMapV1[HostOperation]["result"]
type ToolTextContent = { type: "text"; text: string }
type ToolSuccess<Value extends object> = { structuredContent: Value; content: ToolTextContent[] }

export type HostToolService = {
  status: () => Promise<DesktopOperationMapV1["host.status"]["result"]>
  transportStatus: () => Promise<DesktopOperationMapV1["transport.status"]["result"]>
  play: () => Promise<DesktopOperationMapV1["transport.play"]["result"]>
  pause: () => Promise<DesktopOperationMapV1["transport.pause"]["result"]>
  stop: () => Promise<DesktopOperationMapV1["transport.stop"]["result"]>
  seek: (input: DesktopOperationMapV1["transport.seek"]["input"]) => Promise<DesktopOperationMapV1["transport.seek"]["result"]>
  diagnostics: () => Promise<DesktopOperationMapV1["diagnostics.snapshot"]["result"]>
  importAudio: (input: DesktopOperationMapV1["host.import.audio"]["input"]) => Promise<DesktopOperationMapV1["host.import.audio"]["result"]>
  exportRun: (input: DesktopOperationMapV1["host.export.run"]["input"]) => Promise<DesktopOperationMapV1["host.export.run"]["result"]>
  exportStatus: () => Promise<DesktopOperationMapV1["host.export.status"]["result"]>
  exportCancel: (input: DesktopOperationMapV1["host.export.cancel"]["input"]) => Promise<DesktopOperationMapV1["host.export.cancel"]["result"]>
  vstInstances: (input: DesktopOperationMapV1["host.vst.instances"]["input"]) => Promise<DesktopOperationMapV1["host.vst.instances"]["result"]>
  vstParameters: (input: DesktopOperationMapV1["host.vst.parameters"]["input"]) => Promise<DesktopOperationMapV1["host.vst.parameters"]["result"]>
  operations?: ReadonlySet<DesktopOperationV1>
}

const local = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const text = <Value extends object>(value: Value): ToolSuccess<Value> => ({
  structuredContent: value,
  content: [{ type: "text", text: JSON.stringify(value) }],
})
const failure = () => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ version: "v1", code: "unavailable", message: "The local desktop host is unavailable." }) }] })
const invalid = () => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ version: "v1", code: "invalid-request", message: "Invalid local desktop host tool input." }) }] })

const invoke = async <Value extends object>(operation: () => Promise<HostToolResult>, output: { parse: (value: HostToolResult) => Value }) => {
  try {
    return text(output.parse(await operation()))
  } catch {
    return failure()
  }
}

export const executeHostTool = (name: string, input: HostToolInput, service: HostToolService) => {
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
                      : name === "host_export_cancel" ? "host.export.cancel"
                        : name === "host_vst_instances" ? "host.vst.instances"
                          : name === "host_vst_parameters" ? "host.vst.parameters" : undefined
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
  const vstInstances = desktopHostVstInstancesInputSchemaV1.safeParse(input)
  if (name === "host_vst_instances") return vstInstances.success ? invoke(() => service.vstInstances(vstInstances.data), desktopHostVstInstancesResultSchemaV1) : invalid()
  const vstParameters = desktopHostVstParametersInputSchemaV1.safeParse(input)
  if (name === "host_vst_parameters") return vstParameters.success ? invoke(() => service.vstParameters(vstParameters.data), desktopHostVstParametersResultSchemaV1) : invalid()
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
  if (enabled("host.vst.instances")) server.registerTool("host_vst_instances", { description: "Discover VST3 instances in the mounted desktop project.", inputSchema: desktopHostVstInstancesInputSchemaV1, outputSchema: desktopHostVstInstancesResultSchemaV1, annotations: read }, (input) => executeHostTool("host_vst_instances", input, service))
  if (enabled("host.vst.parameters")) server.registerTool("host_vst_parameters", { description: "Discover VST3 parameter descriptors and values in the mounted desktop project.", inputSchema: desktopHostVstParametersInputSchemaV1, outputSchema: desktopHostVstParametersResultSchemaV1, annotations: read }, (input) => executeHostTool("host_vst_parameters", input, service))
}
