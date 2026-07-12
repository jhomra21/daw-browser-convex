import { describe, expect, test } from "bun:test";
import { createEqBandParameterId } from "@daw-browser/shared";
import { overlayEffectAutomationValue } from "./effect-automation-display";

describe("effect automation display overlay", () => {
  test("overlays nested state without changing persisted parameters", () => {
    const persisted = {
      version: 1,
      state: {
        enabled: true,
        envelope: { attackMs: 10, releaseMs: 100 },
      },
    };

    const displayed = overlayEffectAutomationValue(
      persisted,
      "autofilter.envelope.attackMs",
      250,
    );

    expect(displayed).toEqual({
      version: 1,
      state: {
        enabled: true,
        envelope: { attackMs: 250, releaseMs: 100 },
      },
    });
    expect(persisted.state.envelope.attackMs).toBe(10);
  });

  test("overlays multiple parameters without mutating the previous display value", () => {
    const persisted = { state: { gainDb: 0, pan: 0, enabled: true } };
    const gainDisplay = overlayEffectAutomationValue(persisted, "utility.gainDb", 6);
    const finalDisplay = overlayEffectAutomationValue(gainDisplay, "utility.pan", -0.5);

    expect(finalDisplay).toEqual({ state: { gainDb: 6, pan: -0.5, enabled: true } });
    expect(gainDisplay).toEqual({ state: { gainDb: 6, pan: 0, enabled: true } });
    expect(persisted).toEqual({ state: { gainDb: 0, pan: 0, enabled: true } });
  });

  test("maps EQ automation IDs to their persisted band fields", () => {
    const persisted = {
      enabled: true,
      bands: [
        { id: "low", frequency: 120, gainDb: 0, q: 0.7 },
        { id: "high", frequency: 8_000, gainDb: 1, q: 1 },
      ],
    };

    const frequencyDisplay = overlayEffectAutomationValue(
      persisted,
      createEqBandParameterId("high", "frequencyHz"),
      12_000,
    );
    const finalDisplay = overlayEffectAutomationValue(
      frequencyDisplay,
      createEqBandParameterId("high", "gainDb"),
      -3,
    );

    expect(finalDisplay).toEqual({
      enabled: true,
      bands: [
        { id: "low", frequency: 120, gainDb: 0, q: 0.7 },
        { id: "high", frequency: 12_000, gainDb: -3, q: 1 },
      ],
    });
    expect(persisted.bands[1]).toEqual({ id: "high", frequency: 8_000, gainDb: 1, q: 1 });
  });
});
