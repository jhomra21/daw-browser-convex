import { describe, expect, test } from "bun:test";
import { automationTargetKey, createDefaultSynthParams, synthAutomationKey, type AutomationEnvelope } from "@daw-browser/shared";
import { createSynthAutomationState, overlaySynthAutomationValues } from "./synth-automation";

const envelope = (
  trackId: string,
  instanceId: string,
  value: number,
): AutomationEnvelope => ({
  id: `${trackId}-${instanceId}`,
  projectId: "project-1",
  target: { kind: "track", trackId },
  targetKey: `${trackId}:synth`,
  parameterId: synthAutomationKey(trackId, instanceId, "filter.frequency"),
  enabled: true,
  points: [{ id: "point-1", timeSec: 0, value, interpolation: "linear" }],
  updatedAt: 1,
});

describe("expanded synth automation state", () => {
  test("uses the open card target after the selected track changes", () => {
    const cardAutomation = createSynthAutomationState("track-a", "instrument:synth:a", [
      envelope("track-a", "instrument:synth:a", 440),
      envelope("track-b", "instrument:synth:b", 880),
    ]);

    expect(cardAutomation.ranges.get("filter.frequency")).toEqual({ min: 440, max: 440 });
    expect(cardAutomation.parameterIds.get("filter.frequency")).toBe(
      synthAutomationKey("track-a", "instrument:synth:a", "filter.frequency"),
    );
  });

  test("ignores disabled envelopes when deriving ranges and parameter ids", () => {
    const disabledNoise = {
      ...envelope("track-a", "instrument:synth:a", 0.6),
      parameterId: synthAutomationKey("track-a", "instrument:synth:a", "noise.level"),
      enabled: false,
    };

    const cardAutomation = createSynthAutomationState("track-a", "instrument:synth:a", [
      disabledNoise,
    ]);

    expect(cardAutomation.ranges.has("noise.level")).toBe(false);
    expect(cardAutomation.parameterIds.get("noise.level")).toBe(
      synthAutomationKey("track-a", "instrument:synth:a", "noise.level"),
    );
  });

  test("overlays evaluated values onto normalized synth display params without mutating persisted params", () => {
    const params = createDefaultSynthParams();
    const parameterIds = new Map([
      ["output.gain", synthAutomationKey("track-a", "instrument:synth:a", "output.gain")],
      ["filter.frequency", synthAutomationKey("track-a", "instrument:synth:a", "filter.frequency")],
      ["lfo.ampDepth", synthAutomationKey("track-a", "instrument:synth:a", "lfo.ampDepth")],
      ["noise.level", synthAutomationKey("track-a", "instrument:synth:a", "noise.level")],
    ]);
    const evaluated = new Map([
      [automationTargetKey(
        { kind: "track", trackId: "track-a" },
        synthAutomationKey("track-a", "instrument:synth:a", "output.gain"),
      ), 0.3],
      [automationTargetKey(
        { kind: "track", trackId: "track-a" },
        synthAutomationKey("track-a", "instrument:synth:a", "filter.frequency"),
      ), 600],
      [automationTargetKey(
        { kind: "track", trackId: "track-a" },
        synthAutomationKey("track-a", "instrument:synth:a", "lfo.ampDepth"),
      ), 0.25],
      [automationTargetKey(
        { kind: "track", trackId: "track-a" },
        synthAutomationKey("track-a", "instrument:synth:a", "noise.level"),
      ), 0.6],
    ]);

    const display = overlaySynthAutomationValues(params, parameterIds, evaluated);

    expect(display).toMatchObject({
      gain: 0.3,
      filter: { frequencyHz: 600 },
      lfo: { amp: 0.25 },
      noise: { level: 0.6 },
    });
    expect(params.gain).toBe(0.8);
    expect(params.filter.frequencyHz).toBe(12000);
  });
});
