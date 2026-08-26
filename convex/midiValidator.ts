import { v } from 'convex/values'

export const midiValidator = v.object({
  wave: v.string(),
  gain: v.optional(v.number()),
  inputChannel: v.optional(v.number()),
  notes: v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), length: v.number(), pitch: v.number(),
    velocity: v.optional(v.number()), channel: v.optional(v.number()),
  })),
  cc: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), controller: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  pitchBends: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  channelPressure: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  polyPressure: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), pitch: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  mappings: v.optional(v.array(v.object({
    id: v.string(),
    source: v.union(
      v.object({ kind: v.literal('cc'), controller: v.number(), channel: v.optional(v.number()) }),
      v.object({ kind: v.literal('pitch-bend'), channel: v.optional(v.number()) }),
      v.object({ kind: v.literal('channel-pressure'), channel: v.optional(v.number()) }),
      v.object({ kind: v.literal('poly-pressure'), channel: v.optional(v.number()), pitch: v.optional(v.number()) }),
    ),
    target: v.object({ parameterId: v.string(), effectInstanceId: v.optional(v.string()) }),
    outputMin: v.number(),
    outputMax: v.number(),
  }))),
})
