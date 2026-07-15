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

  test("anchors a visible range on the Shift target after hidden selection", () => {
    expect(
      rangeTrackIdsThroughDisplayOrder(
        ["group", "normal-target", "return-target"],
        ["hidden-child"],
        "normal-target",
      ),
    ).toEqual(["normal-target"]);

    expect(
      rangeTrackIdsThroughDisplayOrder(
        ["group", "normal-target", "return-target"],
        ["hidden-child"],
        "return-target",
      ),
    ).toEqual(["return-target"]);
  });

  test("keeps the prior range when the Shift target is absent", () => {
    expect(
      rangeTrackIdsThroughDisplayOrder(
        ["group", "normal-target"],
        ["hidden-child"],
        "missing",
      ),
    ).toEqual(["hidden-child"]);
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
