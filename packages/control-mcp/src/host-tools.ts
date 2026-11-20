import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import {
  desktopDiagnosticsSchemaV1,
  desktopDiagnosticsSchemaV2,
  desktopEmptyInputSchemaV1,
  desktopHostStatusSchemaV1,
  desktopHostImportResultSchemaV1,
  desktopHostImportStatusSchemaV1,
  desktopHostImportCancelInputSchemaV1,
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
  type DesktopHostOperationV1,
  type DesktopOperationV1,
  type DesktopOperationMapV1,
} from "@daw-browser/desktop-protocol"

type HostToolInput = Parameters<typeof desktopEmptyInputSchemaV1.parse>[0]

type HostToolResult = DesktopOperationMapV1[DesktopHostOperationV1]["result"]

type ToolTextContent = { type: "text"; text: string }

type ToolSuccess<Value extends object> = { structuredContent: Value; content: ToolTextContent[] }

type ToolFailure = { isError: true; content: ToolTextContent[] }

export type HostToolService = {
  status: () => Promise<DesktopOperationMapV1["host.status"]["result"]>
  transportStatus: () => Promise<DesktopOperationMapV1["transport.status"]["result"]>
  play: () => Promise<DesktopOperationMapV1["transport.play"]["result"]>
  pause: () => Promise<DesktopOperationMapV1["transport.pause"]["result"]>
  stop: () => Promise<DesktopOperationMapV1["transport.stop"]["result"]>
  seek: (input: DesktopOperationMapV1["transport.seek"]["input"]) => Promise<DesktopOperationMapV1["transport.seek"]["result"]>
  diagnostics: () => Promise<DesktopOperationMapV1["diagnostics.snapshot"]["result"]>
  diagnosticsV2: () => Promise<DesktopOperationMapV1["diagnostics.snapshot.v2"]["result"]>
  importAudio: (input: DesktopOperationMapV1["host.import.audio"]["input"]) => Promise<DesktopOperationMapV1["host.import.audio"]["result"]>
  importStatus: () => Promise<DesktopOperationMapV1["host.import.status"]["result"]>
  importCancel: (input: DesktopOperationMapV1["host.import.cancel"]["input"]) => Promise<DesktopOperationMapV1["host.import.cancel"]["result"]>
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

const failure = (): ToolFailure => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ version: "v1", code: "unavailable", message: "The local desktop host is unavailable." }) }] })
const invalid = (): ToolFailure => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ version: "v1", code: "invalid-request", message: "Invalid local desktop host tool input." }) }] })

const invoke = async <Value extends object>(operation: () => Promise<HostToolResult>, output: { parse: (value: HostToolResult) => Value }) => {
  try {
    return text(output.parse(await operation()))
  } catch {
    return failure()
  }
}

const hostTool = <Input extends z.ZodType, Output extends z.ZodType<object>>(tool: {
  name: string
  operation: DesktopHostOperationV1
  description: string
  input: Input
  output: Output
  annotations: typeof local
  call: (service: HostToolService, input: z.output<Input>) => Promise<HostToolResult>
}) => ({
  ...tool,
  execute: (service: HostToolService, input: HostToolInput) => {
    const parsed = tool.input.safeParse(input)

    return parsed.success ? invoke(() => tool.call(service, parsed.data), tool.output) : invalid()
  },
})

// One row per host operation, in published tool order: the row's name, schemas and service call are the only places that name it.
const hostTools = [
  hostTool({ name: "host_status", operation: "host.status", description: "Return the attached local desktop host status.", input: desktopEmptyInputSchemaV1, output: desktopHostStatusSchemaV1, annotations: read, call: (service) => service.status() }),
  hostTool({ name: "host_transport_status", operation: "transport.status", description: "Return local desktop transport status.", input: desktopEmptyInputSchemaV1, output: desktopTransportStatusSchemaV1, annotations: read, call: (service) => service.transportStatus() }),
  hostTool({ name: "host_play", operation: "transport.play", description: "Start playback in the open local desktop DAW.", input: desktopEmptyInputSchemaV1, output: desktopTransportStatusSchemaV1, annotations: local, call: (service) => service.play() }),
  hostTool({ name: "host_pause", operation: "transport.pause", description: "Pause playback in the open local desktop DAW.", input: desktopEmptyInputSchemaV1, output: desktopTransportStatusSchemaV1, annotations: local, call: (service) => service.pause() }),
  hostTool({ name: "host_stop", operation: "transport.stop", description: "Stop playback in the open local desktop DAW.", input: desktopEmptyInputSchemaV1, output: desktopTransportStatusSchemaV1, annotations: local, call: (service) => service.stop() }),
  hostTool({ name: "host_seek", operation: "transport.seek", description: "Seek the open local desktop DAW transport.", input: desktopSeekInputSchemaV1, output: desktopTransportStatusSchemaV1, annotations: local, call: (service, input) => service.seek(input) }),
  hostTool({ name: "host_diagnostics", operation: "diagnostics.snapshot", description: "Return safe local desktop audio diagnostics.", input: desktopEmptyInputSchemaV1, output: desktopDiagnosticsSchemaV1, annotations: read, call: (service) => service.diagnostics() }),
  hostTool({ name: "host_diagnostics_v2", operation: "diagnostics.snapshot.v2", description: "Return detailed local desktop audio diagnostics.", input: desktopEmptyInputSchemaV1, output: desktopDiagnosticsSchemaV2, annotations: read, call: (service) => service.diagnosticsV2() }),
  hostTool({ name: "host_import_audio", operation: "host.import.audio", description: "Import bounded local audio into the open desktop DAW.", input: desktopHostImportInputSchemaV1, output: desktopHostImportResultSchemaV1, annotations: local, call: (service, input) => service.importAudio(input) }),
  hostTool({ name: "host_import_status", operation: "host.import.status", description: "Return the active local desktop import status.", input: desktopEmptyInputSchemaV1, output: desktopHostImportStatusSchemaV1, annotations: read, call: (service) => service.importStatus() }),
  hostTool({ name: "host_import_cancel", operation: "host.import.cancel", description: "Cancel a local desktop import by job ID.", input: desktopHostImportCancelInputSchemaV1, output: desktopHostImportStatusSchemaV1, annotations: local, call: (service, input) => service.importCancel(input) }),
  hostTool({ name: "host_export_run", operation: "host.export.run", description: "Queue a local desktop audio export.", input: desktopHostExportRunInputSchemaV1, output: desktopHostExportRunResultSchemaV1, annotations: local, call: (service, input) => service.exportRun(input) }),
  hostTool({ name: "host_export_status", operation: "host.export.status", description: "Return the active local desktop export status.", input: desktopEmptyInputSchemaV1, output: desktopHostExportStatusSchemaV1, annotations: read, call: (service) => service.exportStatus() }),
  hostTool({ name: "host_export_cancel", operation: "host.export.cancel", description: "Cancel a local desktop export by job ID.", input: desktopHostExportCancelInputSchemaV1, output: desktopHostExportStatusSchemaV1, annotations: local, call: (service, input) => service.exportCancel(input) }),
  hostTool({ name: "host_vst_instances", operation: "host.vst.instances", description: "Discover VST3 instances in the mounted desktop project.", input: desktopHostVstInstancesInputSchemaV1, output: desktopHostVstInstancesResultSchemaV1, annotations: read, call: (service, input) => service.vstInstances(input) }),
  hostTool({ name: "host_vst_parameters", operation: "host.vst.parameters", description: "Discover VST3 parameter descriptors and values in the mounted desktop project.", input: desktopHostVstParametersInputSchemaV1, output: desktopHostVstParametersResultSchemaV1, annotations: read, call: (service, input) => service.vstParameters(input) }),
]

const isEnabled = (service: HostToolService, operation: DesktopOperationV1) => service.operations === undefined || service.operations.has(operation)

export const executeHostTool = (name: string, input: HostToolInput, service: HostToolService) => {
  const tool = hostTools.find((candidate) => candidate.name === name)

  if (!tool || !isEnabled(service, tool.operation)) return failure()

  return tool.execute(service, input)
}

export const registerHostTools = (server: McpServer, service: HostToolService) => {
  for (const tool of hostTools) {
    if (!isEnabled(service, tool.operation)) continue

    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations: tool.annotations },
      (input: HostToolInput) => executeHostTool(tool.name, input, service),
    )
  }
}
