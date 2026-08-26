import { expect, test } from "bun:test"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { PortableFrameScheduleEvent } from "@daw-browser/audio-engine/portable-frame-scheduling"
import { nativeProcessorAutomationEventsForSchedule } from "./native-processor-automation"

const graph = {
  version: 1,
  revision: 1,
  contractHash: "test",
  edges: [],
  nodes: [
    {
      id: "track",
      kind: "source",
      mixer: {
        instanceId: 101,
        parameterTargets: [
          { id: "mixer.gain", target: 26 },
          { id: "mixer.pan", target: 27 },
        ],
      },
      processorOrder: [
        {
          id: "utility:1",
          instanceId: 201,
          kind: "utility",
          parameterTargets: [{ id: "utility.gainDb", target: 1 }],
        },
        {
          id: "external-plugin:plugin",
          instanceId: 301,
          kind: "external-vst3",
          parameterTargets: [{ id: "external", target: 7 }],
        },
      ],
    },
    {
      id: "master",
      kind: "master",
      mixer: {
        instanceId: 102,
        parameterTargets: [{ id: "mixer.gain", target: 26 }],
      },
      processorOrder: [],
    },
  ],
} as unknown as AudioCoreGraphSnapshot

const events = [
  {
    type: "parameter-set",
    frame: 4,
    sequence: 1,
    target: { kind: "parameter", scope: "track", trackId: "track", parameterId: "mixer.gain" },
    value: 0.5,
  },
  {
    type: "parameter-ramp",
    frame: 8,
    startFrame: 8,
    endFrame: 16,
    sequence: 2,
    interpolation: "linear",
    target: { kind: "parameter", scope: "master", parameterId: "mixer.gain" },
    startValue: 1,
    endValue: 0.25,
  },
  {
    type: "parameter-set",
    frame: 6,
    sequence: 3,
    target: {
      kind: "parameter",
      scope: "track",
      trackId: "track",
      effectInstanceId: "utility:1",
      parameterId: "utility.gainDb",
    },
    value: -6,
  },
  {
    type: "parameter-set",
    frame: 5,
    sequence: 4,
    target: {
      kind: "parameter",
      scope: "track",
      trackId: "track",
      effectInstanceId: "external-plugin:plugin",
      parameterId: "external",
    },
    value: 0.8,
  },
] as unknown as PortableFrameScheduleEvent[]

test("projects mixer and built-in automation to existing numeric graph targets", () => {
  expect(nativeProcessorAutomationEventsForSchedule(graph, events)).toEqual([
    { kind: "set", processorInstanceId: 101, parameterTarget: 26, frame: 4, value: 0.5 },
    { kind: "set", processorInstanceId: 201, parameterTarget: 1, frame: 6, value: -6 },
    {
      kind: "linear",
      processorInstanceId: 102,
      parameterTarget: 26,
      frame: 8,
      endFrame: 16,
      startValue: 1,
      endValue: 0.25,
    },
  ])
})

test("fails closed when a graph target is unknown", () => {
  const unknown = [{
    type: "parameter-set",
    frame: 0,
    sequence: 1,
    target: { kind: "parameter", scope: "track", trackId: "track", parameterId: "missing" },
    value: 1,
  }] as unknown as PortableFrameScheduleEvent[]
  expect(() => nativeProcessorAutomationEventsForSchedule(graph, unknown)).toThrow("Native mixer automation parameter")
})
