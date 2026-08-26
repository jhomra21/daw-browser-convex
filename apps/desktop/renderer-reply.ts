import {
  desktopJsonValueSchema,
  desktopProtocolVersionV2,
  hostErrorSchemaV1,
  isDesktopControlOperation,
  type DesktopFrameV1,
  type DesktopOperationV1,
  type DesktopProtocolVersion,
} from "@daw-browser/desktop-protocol"
import { controlErrorSchemaV1 } from "@daw-browser/control"
import type { z } from "zod"

type RendererReply = Extract<DesktopFrameV1, { type: "reply" }>
type RendererReplyError = Parameters<typeof controlErrorSchemaV1.safeParse>[0]
type ControlErrorInput = z.input<typeof controlErrorSchemaV1>

const translateRendererError = (
  operation: DesktopOperationV1,
  error: RendererReplyError,
  protocolVersion: DesktopProtocolVersion,
) => {
  if (isDesktopControlOperation(operation)) {
    const control = controlErrorSchemaV1.safeParse(error)
    if (control.success) {
      const { actionIndex, details, ...canonical } = control.data
      let normalized: ControlErrorInput = canonical
      if (actionIndex !== undefined) normalized = { ...normalized, actionIndex }
      if (details !== undefined) normalized = { ...normalized, details }
      return normalized
    }
  }
  if (protocolVersion !== desktopProtocolVersionV2) return error
  const host = hostErrorSchemaV1.safeParse(error)
  return host.success ? { ...host.data, version: desktopProtocolVersionV2 } : error
}

export const prepareDesktopReply = (
  operation: DesktopOperationV1,
  reply: RendererReply,
  id: string,
  protocolVersion: DesktopProtocolVersion,
) => {
  const { result, error } = reply
  const translatedError = translateRendererError(operation, error, protocolVersion)
  const outbound = {
    type: "reply",
    id,
  }
  if (translatedError !== undefined) {
    return desktopJsonValueSchema.parse({ ...outbound, version: protocolVersion, error: translatedError })
  }
  return desktopJsonValueSchema.parse({ ...outbound, version: protocolVersion, result })
}
