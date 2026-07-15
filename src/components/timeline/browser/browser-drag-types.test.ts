import { describe, expect, test } from "bun:test";

import {
  browserDropTargetTrackId,
  type BrowserDropTarget,
} from "./browser-drag-types";

describe("browserDropTargetTrackId", () => {
  test("keeps a Return track identity independent of its local lane index", () => {
    const returnTarget: BrowserDropTarget = {
      kind: "track",
      trackId: "return-a",
      laneIndex: 0,
    };
    const scrollingTarget: BrowserDropTarget = {
      kind: "track",
      trackId: "track-a",
      laneIndex: 0,
    };

    expect(browserDropTargetTrackId(returnTarget)).toBe("return-a");
    expect(browserDropTargetTrackId(scrollingTarget)).toBe("track-a");
  });

  test("does not project non-track targets onto a lane", () => {
    expect(browserDropTargetTrackId({ kind: "new-track" })).toBeNull();
    expect(browserDropTargetTrackId({ kind: "none" })).toBeNull();
  });
});
