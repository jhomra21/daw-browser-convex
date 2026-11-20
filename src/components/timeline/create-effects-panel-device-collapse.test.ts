import { describe, expect, test } from "bun:test";
import {
  createEffectsPanelDeviceCollapse,
  deviceCollapseIdentity,
  parseCollapsedDeviceIdentities,
  safeDeviceContentId,
  serializeCollapsedDeviceIdentities,
  recognizeDeviceDoubleTap,
} from "./create-effects-panel-device-collapse";

describe("device collapse preferences", () => {
  test("round-trips a JSON string set and ignores malformed values", () => {
    const identities = new Set([
      deviceCollapseIdentity.audioEffect("effect-2"),
      deviceCollapseIdentity.instrument("instrument-1"),
    ]);

    const serialized = serializeCollapsedDeviceIdentities(identities);

    expect(parseCollapsedDeviceIdentities(serialized)).toEqual(identities);
    expect(parseCollapsedDeviceIdentities("not-json")).toEqual(new Set());
    expect(parseCollapsedDeviceIdentities(JSON.stringify({ collapsed: true }))).toEqual(new Set());
  });

  test("uses stable independent identities and safe content IDs", () => {
    expect(deviceCollapseIdentity.audioEffect("same")).not.toBe(deviceCollapseIdentity.external("same"));
    expect(safeDeviceContentId("audio-effect:one/two")).toBe(safeDeviceContentId("audio-effect:one/two"));
    expect(safeDeviceContentId("audio-effect:one/two")).not.toContain("/");
  });

  test("tracks a changing identity", () => {
    let identity = deviceCollapseIdentity.audioEffect("first");
    const collapse = createEffectsPanelDeviceCollapse(() => "project-1");

    collapse.setCollapsed(deviceCollapseIdentity.audioEffect("second"), true);
    expect(collapse.isCollapsed(identity)).toBe(false);

    identity = deviceCollapseIdentity.audioEffect("second");
    expect(collapse.isCollapsed(identity)).toBe(true);
  });
});

describe("device collapse double-tap classifier", () => {
  const tap = (at: number, x: number, y: number, pointerType = "touch", deviceId = "touch") => ({
    identity: "audio-effect:effect-1",
    at,
    x,
    y,
    pointerType,
    deviceId,
  });

  test("recognizes a matching touch double tap", () => {
    const result = recognizeDeviceDoubleTap(tap(100, 10, 10), tap(500, 15, 14));
    expect(result.recognized).toBe(true);
    expect(result.next).toBeUndefined();
  });

  test("rejects timeout, distance, and device mismatches", () => {
    expect(recognizeDeviceDoubleTap(tap(100, 10, 10), tap(801, 10, 10)).recognized).toBe(false);
    expect(recognizeDeviceDoubleTap(tap(100, 10, 10), tap(200, 19, 10)).recognized).toBe(false);
    expect(recognizeDeviceDoubleTap(tap(100, 10, 10, "touch", "one"), tap(200, 10, 10, "touch", "two")).recognized).toBe(false);
    expect(recognizeDeviceDoubleTap(tap(100, 10, 10, "touch"), tap(200, 10, 10, "mouse")).recognized).toBe(false);
  });
});
