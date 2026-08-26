#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    text = read(path)
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}: {old[:120]!r}")
    write(path, text.replace(old, new, count))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    text = read(path)
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{path}: start marker missing: {start!r}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{path}: end marker missing: {end!r}")
    write(path, text[:start_index] + replacement + text[end_index:])


coordinator = "src/lib/desktop/native-schedule-coordinator.ts"
replace(
    coordinator,
    'import { parseExternalAutomationParameterId, valueAtAutomationTime } from "@daw-browser/shared"\n',
    'import { nativeVstAutomationSegmentsForEnvelopes } from "~/lib/desktop/native-vst-automation"\n',
)
replace_between(
    coordinator,
    'const clampNormalized = (value: number) => Math.min(1, Math.max(0, value))\n',
    'const sourceKey = (event: NativeSourceEvent) => (\n',
    '''const synthStateEvents = (snapshot: LivePlaybackSnapshot, frame: number): NativeInstrumentEvent[] => (\n  snapshot.tracks\n    .filter((track) => snapshot.mixer.fx.trackFx?.[track.id]?.instrument?.kind === "synth")\n    .flatMap((track, synthIndex) => {\n      const instrument = snapshot.mixer.fx.trackFx?.[track.id]?.instrument\n      if (!instrument || instrument.kind !== "synth") return []\n      const params = instrument.params\n      const values = [\n        params.gain,\n        params.pan,\n        params.filter.frequencyHz,\n        params.filter.q,\n        params.ampEnvelope.attackSec * 1000,\n        params.ampEnvelope.decaySec * 1000,\n        params.ampEnvelope.sustain,\n        params.ampEnvelope.releaseSec * 1000,\n      ]\n      return values.map((value, target) => ({\n        nodeId: track.id,\n        noteId: 1,\n        sequence: synthIndex * values.length + target + 1,\n        frameOffset: frame,\n        type: "parameter" as const,\n        channel: 0,\n        note: target + 1,\n        value,\n      }))\n    })\n)\n\nexport const nativeVstAutomationSegmentsForSnapshot = (\n  snapshot: LivePlaybackSnapshot,\n  sampleRateHz: number,\n  startFrame: number,\n  endFrame: number,\n): NativeVstAutomationSegment[] => nativeVstAutomationSegmentsForEnvelopes({\n  attachments: snapshot.nativeExternalAttachmentPlan,\n  automationEnvelopes: snapshot.mixer.automationEnvelopes,\n  sampleRateHz,\n  startFrame,\n  endFrame,\n})\n\n''',
)

offline = "src/lib/export/native-offline-render-plan.ts"
replace(
    offline,
    "import { nativeProcessorAutomationEventsForSchedule } from '~/lib/desktop/native-processor-automation'\n",
    "import { nativeProcessorAutomationEventsForSchedule, sliceNativeProcessorAutomationEvents } from '~/lib/desktop/native-processor-automation'\n"
    "import { nativeVstAutomationSegmentsForEnvelopes } from '~/lib/desktop/native-vst-automation'\n",
)
replace(
    offline,
    "  nativeAudioHostMaximumInstalledAssets,\n  nativeAudioHostMaximumScheduleRecords,\n",
    "  nativeAudioHostMaximumInstalledAssets,\n  nativeAudioHostMaximumProcessorEvents,\n  nativeAudioHostMaximumScheduleAutomationSegments,\n  nativeAudioHostMaximumScheduleRecords,\n",
)
replace_between(
    offline,
    "  const processorAutomationEvents = nativeProcessorAutomationEventsForSchedule(snapshot.graph, schedule.events)\n",
    "  const scheduleBytes = scheduleWindows[0]\n",
    '''  const processorAutomationEvents = nativeProcessorAutomationEventsForSchedule(snapshot.graph, schedule.events)\n  const noteEvents = schedule.events.filter((event): event is Extract<typeof event, { type: 'note-on' | 'note-off' }> => (\n    event.type === 'note-on' || event.type === 'note-off'\n  ))\n  const instrumentEvents = noteEvents.map((event) => ({\n    nodeId: event.target.trackId,\n    noteId: event.noteId,\n    sequence: event.sequence,\n    frameOffset: event.frame,\n    type: event.type,\n    channel: 0,\n    note: event.pitch,\n    value: event.type === 'note-on' ? event.velocity : 0,\n  }))\n  const sampleSourceEvents = snapshot.events.filter((event) => event.startFrame < totalFrames)\n  const sortedInstrumentEvents = [...instrumentEvents].sort((left, right) => (\n    left.frameOffset - right.frameOffset || left.sequence - right.sequence\n  ))\n  const sortedSourceEvents = [...sampleSourceEvents].sort((left, right) => (\n    left.startFrame - right.startFrame || left.sequence - right.sequence\n  ))\n  const renderOriginFrame = Math.round(sourceBounds.startSec * input.sampleRateHz)\n  const scheduleWindows: Array<Uint8Array> = []\n  const candidateFor = (startFrame: number, endFrame: number) => {\n    const vstAutomationSegments = nativeVstAutomationSegmentsForEnvelopes({\n      attachments: externalAttachments,\n      automationEnvelopes: input.automationEnvelopes,\n      sampleRateHz: input.sampleRateHz,\n      startFrame: renderOriginFrame + startFrame,\n      endFrame: renderOriginFrame + endFrame,\n    }).map((segment) => ({\n      ...segment,\n      startFrame: segment.startFrame - renderOriginFrame,\n      endFrame: segment.endFrame - renderOriginFrame,\n    }))\n    return {\n      instrumentEvents: sortedInstrumentEvents.filter((event) => (\n        event.frameOffset >= startFrame && event.frameOffset < endFrame\n      )),\n      sampleSourceEvents: sortedSourceEvents.filter((event) => (\n        event.startFrame >= startFrame && event.startFrame < endFrame\n      )),\n      vstAutomationSegments,\n      processorAutomationEvents: sliceNativeProcessorAutomationEvents(\n        processorAutomationEvents,\n        startFrame,\n        endFrame,\n      ),\n    }\n  }\n  const candidateFits = (candidate: ReturnType<typeof candidateFor>) => {\n    const total = candidate.instrumentEvents.length\n      + candidate.sampleSourceEvents.length\n      + candidate.vstAutomationSegments.length\n      + candidate.processorAutomationEvents.length\n    return candidate.instrumentEvents.length <= 256\n      && candidate.sampleSourceEvents.length <= 256\n      && candidate.vstAutomationSegments.length <= nativeAudioHostMaximumScheduleAutomationSegments\n      && candidate.processorAutomationEvents.length <= nativeAudioHostMaximumProcessorEvents\n      && total <= nativeAudioHostMaximumScheduleRecords\n  }\n\n  let windowStart = 0\n  while (windowStart < totalFrames) {\n    let windowEnd = totalFrames\n    let candidate = candidateFor(windowStart, windowEnd)\n    while (!candidateFits(candidate)) {\n      const shorter = windowStart + Math.max(1, Math.floor((windowEnd - windowStart) / 2))\n      if (shorter >= windowEnd) {\n        throw new Error(`Native Phase A export automation/events exceed the wire capacity at render frame ${windowStart}.`)\n      }\n      windowEnd = shorter\n      candidate = candidateFor(windowStart, windowEnd)\n    }\n    scheduleWindows.push(serializeNativeScheduleWindow({\n      revision: 1,\n      epoch: 1,\n      windowId: scheduleWindows.length + 1,\n      startFrame: windowStart,\n      endFrame: windowEnd,\n      endsSchedule: windowEnd === totalFrames,\n      instrumentEvents: candidate.instrumentEvents,\n      sampleSourceEvents: candidate.sampleSourceEvents,\n      vstAutomationSegments: candidate.vstAutomationSegments,\n      processorAutomationEvents: candidate.processorAutomationEvents,\n      assets: sessionAssets,\n    }))\n    windowStart = windowEnd\n  }\n''',
)

coordinator_test = "src/lib/desktop/native-schedule-coordinator.test.ts"
replace(
    coordinator_test,
    '''  const instrumentPayloads: Uint8Array[] = []\n''',
    '''  const instrumentPayloads: Uint8Array[] = []\n  const reenablePayloads: Uint8Array[] = []\n''',
)
replace(
    coordinator_test,
    '''    payloads,\n    setFailureCount:''',
    '''    payloads,\n    reenablePayloads,\n    setFailureCount:''',
)
replace(
    coordinator_test,
    '''      queueInstrumentEvents: async (bytes: Uint8Array) => {\n        instrumentPayloads.push(bytes)\n        return { ok: true as const }\n      },\n''',
    '''      queueInstrumentEvents: async (bytes: Uint8Array) => {\n        instrumentPayloads.push(bytes)\n        return { ok: true as const }\n      },\n      reenableVstScheduleAutomation: async (bytes: Uint8Array) => {\n        reenablePayloads.push(bytes)\n        return { ok: true as const }\n      },\n''',
)
append_marker = '''test("projects non-empty VST automation segments across start, seek, and end boundaries", () => {\n'''
reenable_test = '''test("re-enables selected VST automation while progress remains running", async () => {\n  const fixture = bridgeFor()\n  const snapshot = automationSnapshot([{ id: "point", timeSec: 0, value: 0.5, interpolation: "hold" }])\n  const { coordinator } = coordinatorFor(snapshot, 0, fixture)\n  coordinator.install()\n  fixture.emitProgress(progressFor(1n))\n  expect(coordinator.currentProgress()?.running).toBeTrue()\n  await coordinator.reenableAutomation(attachmentPlan.attachments[0]!.instanceId, [7])\n  expect(fixture.reenablePayloads).toHaveLength(1)\n  const payload = fixture.reenablePayloads[0]!\n  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)\n  const instanceLength = view.getUint32(0, true)\n  expect(new TextDecoder().decode(payload.subarray(4, 4 + instanceLength))).toBe(attachmentPlan.attachments[0]!.instanceId)\n  expect(view.getUint32(4 + instanceLength, true)).toBe(1)\n  expect(view.getUint32(8 + instanceLength, true)).toBe(7)\n  expect(coordinator.currentProgress()?.running).toBeTrue()\n})\n\n'''
replace(coordinator_test, append_marker, reenable_test + append_marker)

print("native automation parity Phase B TypeScript patch applied")
