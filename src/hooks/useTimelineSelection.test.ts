import { describe, expect, test } from "bun:test";
import {
  rangeTrackIdsThroughDisplayOrder,
  timelinePointerCoordinates,
} from "./useTimelineSelection";

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

describe("timelinePointerCoordinates", () => {
  test("uses Return section-local coordinates with no ruler offset", () => {
    const coordinates = timelinePointerCoordinates(
      { clientX: 140, clientY: 228 },
      {
        scrollLeft: 0,
        scrollTop: 0,
        getBoundingClientRect: () => ({ left: 100, top: 200 }),
      },
      0,
    );

    expect(coordinates).toEqual({ x: 40, y: 28 });
  });
});
