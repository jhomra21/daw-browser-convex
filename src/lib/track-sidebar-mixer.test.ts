import { describe, expect, test } from "bun:test";
import { formatMixerVolumeDb } from "@daw-browser/shared";
import { trackNumberById } from "./track-sidebar-mixer";

describe("track sidebar mixer helpers", () => {
  test("numbers tracks in their supplied ordering", () => {
    const numbers = trackNumberById([
      { id: "group" },
      { id: "track-a" },
      { id: "return" },
    ]);

    expect(numbers.get("group")).toBe(1);
    expect(numbers.get("track-a")).toBe(2);
    expect(numbers.get("return")).toBe(3);
  });

  test("formats linear volume as decibels", () => {
    expect(formatMixerVolumeDb(0)).toBe("-inf");
    expect(formatMixerVolumeDb(0.8)).toBe("-1.9");
    expect(formatMixerVolumeDb(1)).toBe("0.0");
    expect(formatMixerVolumeDb(2)).toBe("+6.0");
    expect(formatMixerVolumeDb(Number.NaN)).toBe("-inf");
  });
});
