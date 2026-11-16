import { z } from "zod"
import { projectIdSchemaV1 } from "@daw-browser/desktop-protocol"

export const unsigned32Schema = z.number().int().min(0).max(0xffff_ffff)
export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

const nativeEditorAnchorSchema = z.object({
  x: z.number().finite().min(-8_000_000).max(8_000_000),
  y: z.number().finite().min(-8_000_000).max(8_000_000),
}).passthrough()

export const nativeEditorCommandSchema = z.object({
  projectId: projectIdSchemaV1,
  instanceId: uuidSchema,
  command: z.enum(["open", "close", "focus", "resize", "status"]),
  serializedPlan: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 1_048_576).optional(),
  initialState: z.object({
    bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 512 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  requiresState: z.boolean().optional(),
  captureState: z.boolean().optional(),
  width: unsigned32Schema.max(8192).optional(),
  height: unsigned32Schema.max(8192).optional(),
  anchor: nativeEditorAnchorSchema.optional(),
}).passthrough().refine((value) => (
  (value.anchor === undefined || value.command === "open" || value.command === "focus")
  && (
    (value.command !== "open" && value.command !== "focus" && value.command !== "status")
    || value.serializedPlan !== undefined
  )
)).refine((value) => (
  (!Object.hasOwn(value, "serializedPlan") || value.serializedPlan !== undefined)
  && (!Object.hasOwn(value, "width") || value.width !== undefined)
  && (!Object.hasOwn(value, "height") || value.height !== undefined)
  && (!Object.hasOwn(value, "anchor") || value.anchor !== undefined)
))
