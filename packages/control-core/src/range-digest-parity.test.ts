import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test } from "bun:test";

import { isJsonObject, type JsonValue } from "@daw-browser/shared";

import {
  timelineRangeRecoveryAutomationDigestV2,
  timelineRangeRecoveryClipDigestV2,
} from "@daw-browser/control";

// The planner's former private canonicalizer, kept as the oracle the shared digest must match.
const legacyCanonical = (value: JsonValue | undefined): string => {
  if (value === undefined) return "undefined";

  if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(",")}]`;

  if (isJsonObject(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${legacyCanonical(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const legacySha = (value: string) => Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const clips: any[] = [
  { id: "a", trackId: "t", startSec: 1.5, durationSec: 2, kind: "audio", name: "x", color: undefined, source: { kind: "asset", assetId: "s" }, fades: { inSec: 0, outSec: 0.25 } },
  { id: "b", trackId: "t", startSec: 0, durationSec: 1, kind: "midi", midi: { wave: "sine", gain: 1, notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5 }] }, audioWarp: undefined },
];

const automation: any[] = [
  { target: { kind: "track", trackId: "t" }, effectInstanceId: "e", parameterId: "p", enabled: true, points: [{ timeSec: 0, value: 0.5, curve: undefined }] },
];

test("range clip digests equal the former planner digests", () => {
  for (const clip of clips) {
    const { id: _id, ...semantic } = clip;

    expect(timelineRangeRecoveryClipDigestV2(clip)).toBe(legacySha(legacyCanonical(semantic)));
  }
});

test("range automation digests equal the former planner digests", () => {
  for (const entry of automation) {
    expect(timelineRangeRecoveryAutomationDigestV2(entry)).toBe(legacySha(legacyCanonical(entry)));
  }
});
