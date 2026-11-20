import { z } from "zod"

export const unsigned32Max = 0xffff_ffff
export const unsigned64Max = 0xffff_ffff_ffff_ffffn
export const unsigned32Schema = z.number().int().min(0).max(unsigned32Max)
export const sha256HexPattern = /^[a-f0-9]{64}$/
export const sha256HexSchema = z.string().regex(sha256HexPattern)
export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const requestIdSchema = z.string().regex(requestIdPattern)
