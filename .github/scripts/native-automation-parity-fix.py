#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    target = ROOT / path
    text = target.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}: {old[:120]!r}")
    target.write_text(text.replace(old, new, count))


coordinator = "src/lib/desktop/native-schedule-coordinator.ts"
replace(
    coordinator,
    "  const audioTracks = input.snapshot.tracks.filter((track) => track.kind !== \"instrument\")\n",
    "  const audioTracks = input.snapshot.tracks.filter((track) => track.kind !== \"instrument\")\n  let scheduleGraph = input.graph\n",
)
replace(
    coordinator,
    "    const vstAutomationSegments: NativeVstAutomationSegment[] = []\n",
    "    const vstAutomationSegments: NativeVstAutomationSegment[] = []\n    const processorAutomationEvents: import(\"@daw-browser/audio-engine/native-host-wire\").NativeProcessorAutomationEvent[] = []\n",
)
replace(
    coordinator,
    "        automationEnvelopes: [],\n",
    "        automationEnvelopes: input.snapshot.mixer.automationEnvelopes,\n",
)
replace(
    coordinator,
    "      const processorAutomationEvents = input.graph ? nativeProcessorAutomationEventsForSchedule(input.graph, schedule.events) : []\n",
    "      if (scheduleGraph) processorAutomationEvents.push(...nativeProcessorAutomationEventsForSchedule(scheduleGraph, schedule.events))\n",
)
replace(
    coordinator,
    "  const preflight = (graph: AudioCoreGraphSnapshot) => {\n    validateCallbackCapacity(graph)\n  }",
    "  const preflight = (graph: AudioCoreGraphSnapshot) => {\n    scheduleGraph = graph\n    validateCallbackCapacity(graph)\n  }",
)
replace(
    coordinator,
    "          && candidate.vstAutomationSegments.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount\n",
    "          && candidate.vstAutomationSegments.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount\n          && candidate.processorAutomationEvents.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount\n",
)

wire_test = "packages/audio-engine/src/native-host-wire.test.ts"
replace(wire_test, "  expect(bytes.byteLength).toBe(104)\n", "  expect(bytes.byteLength).toBe(108)\n")
replace(wire_test, "  expect(view.getUint32(56 + 32, true)).toBe(104)\n", "  expect(view.getUint32(56, true)).toBe(0)\n  expect(view.getUint32(60 + 32, true)).toBe(104)\n")

coordinator_test = "src/lib/desktop/native-schedule-coordinator.test.ts"
replace(coordinator_test, "    const offset = 56 + index * 48\n", "    const offset = 60 + index * 48\n")
replace(coordinator_test, "view.getUint32(56 + 28, true)", "view.getUint32(60 + 28, true)", count=3)

print("native automation parity first-run fixes applied")
