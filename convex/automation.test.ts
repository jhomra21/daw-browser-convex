import { describe, expect, test } from "bun:test";
import { automationTargetKey } from "@daw-browser/shared";
import { readAutomationTrackInstrument } from "./automation";

describe("canonical automation identity", () => {
  test("scopes the same parameter by target and instance", () => {
    expect(automationTargetKey({
      kind: "track",
      trackId: "track:one",
      effectInstanceId: "delay:one",
    }, "delay.feedback")).not.toBe(automationTargetKey({
      kind: "track",
      trackId: "track:two",
      effectInstanceId: "delay:one",
    }, "delay.feedback"));
  });

  test("normalizes a legacy synth row only when no canonical instrument row exists", () => {
    const legacy = {
      type: "synth",
      instanceId: "instrument:synth:legacy",
      params: { wave1: "square", gain: 0.4, attackMs: 25, releaseMs: 300 },
    };
    const canonical = {
      type: "instrument",
      params: {
        kind: "synth",
        instanceId: "instrument:synth:canonical",
        params: { gain: 0.7 },
      },
    };

    expect(readAutomationTrackInstrument([legacy])).toMatchObject({
      kind: "synth",
      instanceId: "instrument:synth:legacy",
      params: { gain: 0.4, ampEnvelope: { attackSec: 0.025, releaseSec: 0.3 } },
    });
    expect(readAutomationTrackInstrument([legacy, canonical])?.instanceId).toBe("instrument:synth:canonical");
  });
});
