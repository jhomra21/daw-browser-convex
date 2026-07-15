import { v } from 'convex/values'

export const clipFadesValidator = v.object({
  fadeInStartSec: v.optional(v.number()),
  fadeInSec: v.number(),
  fadeOutSec: v.number(),
  fadeOutEndSec: v.optional(v.number()),
  fadeInCurve: v.number(),
  fadeOutCurve: v.number(),
  fadeInCurvePosition: v.optional(v.number()),
  fadeOutCurvePosition: v.optional(v.number()),
})
