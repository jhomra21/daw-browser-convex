import { z } from "zod"

export const offlinePcmAckSchema = z.object({
  jobId: z.string().min(1).max(128),
  sequence: z.number().int().safe().min(1).max(0xffff_ffff),
  endFrame: z.number().int().safe().min(0),
}).strict()

export const offlinePcmMessageSchema = z.object({
  jobId: z.string().min(1).max(128),
  sequence: z.number().int().safe().min(1).max(0xffff_ffff),
  chunk: z.object({
    startFrame: z.number().int().safe().min(0),
    frameCount: z.number().int().safe().positive(),
    channelCount: z.union([z.literal(1), z.literal(2)]),
    planes: z.array(z.instanceof(Float32Array)),
  }).strict(),
}).strict()

export type OfflinePcmAck = z.infer<typeof offlinePcmAckSchema>
