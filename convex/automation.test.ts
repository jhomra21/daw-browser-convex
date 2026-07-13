import { describe, expect, test } from "bun:test";
import { automationTargetKey } from "@daw-browser/shared";

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
});
