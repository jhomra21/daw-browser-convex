import { describe, expect, test } from "bun:test";
import { formatTrackVolumeDb, trackNumberById } from "./track-sidebar-mixer";

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
    expect(formatTrackVolumeDb(0)).toBe("-inf");
    expect(formatTrackVolumeDb(0.8)).toBe("-1.9");
    expect(formatTrackVolumeDb(1)).toBe("0.0");
    expect(formatTrackVolumeDb(Number.NaN)).toBe("-inf");
  });
});
