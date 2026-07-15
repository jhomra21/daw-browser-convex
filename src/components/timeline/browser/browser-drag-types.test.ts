import { describe, expect, test } from "bun:test";

import {
  browserDropTargetTrackId,
  type BrowserDragPayload,
  type BrowserDropTarget,
} from "./browser-drag-types";
import { resolveBrowserDeviceDropTarget } from "./create-browser-device-drag";

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

describe("resolveBrowserDeviceDropTarget", () => {
  const payload: BrowserDragPayload = {
    kind: "midi-instrument",
    instrument: "synth",
    label: "Synth",
  };
  const canDrop = () => true;

  test("excludes Master base and automation geometry", () => {
    const candidates: Parameters<typeof resolveBrowserDeviceDropTarget>[1] = {
      returnTarget: { kind: "none" },
      isOverMasterTimeline: true,
      timelineTarget: { kind: "track", trackId: "obscured-track", laneIndex: 0 },
    };

    expect(resolveBrowserDeviceDropTarget(payload, candidates, canDrop)).toEqual({ kind: "none" });
  });

  test("prioritizes Returns and preserves scrolling and new-track targets outside the footer", () => {
    expect(resolveBrowserDeviceDropTarget(payload, {
      effectChainTarget: undefined,
      returnTarget: { kind: "track", trackId: "return-a", laneIndex: 0 },
      isOverMasterTimeline: false,
      timelineTarget: { kind: "track", trackId: "scrolling-track", laneIndex: 0 },
    }, canDrop)).toEqual({ kind: "track", trackId: "return-a", laneIndex: 0 });

    expect(resolveBrowserDeviceDropTarget(payload, {
      returnTarget: { kind: "none" },
      isOverMasterTimeline: false,
      timelineTarget: { kind: "new-track" },
    }, canDrop)).toEqual({ kind: "new-track" });
  });

  test("keeps Master effects-chain previews valid before timeline exclusion", () => {
    expect(resolveBrowserDeviceDropTarget(payload, {
      effectChainTarget: { kind: "effect-chain", targetId: "master", index: 1 },
      returnTarget: { kind: "none" },
      isOverMasterTimeline: true,
      timelineTarget: { kind: "track", trackId: "obscured-track", laneIndex: 0 },
    }, canDrop)).toEqual({ kind: "effect-chain", targetId: "master", index: 1 });
  });
});
