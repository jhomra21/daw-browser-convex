import { describe, expect, test } from "bun:test";
import { rangeTrackIdsThroughDisplayOrder } from "./useTimelineSelection";

describe("rangeTrackIdsThroughDisplayOrder", () => {
  test("uses supplied display order across normal and Return sections", () => {
    expect(
      rangeTrackIdsThroughDisplayOrder(
        ["normal-a", "normal-b", "return-a", "return-b"],
        ["normal-b"],
        "return-b",
      ),
    ).toEqual(["normal-b", "return-a", "return-b"]);
  });

  test("excludes hidden descendants omitted from display order", () => {
    expect(
      rangeTrackIdsThroughDisplayOrder(
        ["group", "normal-b", "return-a"],
        ["group"],
        "return-a",
      ),
    ).toEqual(["group", "normal-b", "return-a"]);
  });
});
