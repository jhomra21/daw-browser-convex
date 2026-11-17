import { expect, test } from "bun:test";

import { requireUnambiguousProjectOwnershipMarker } from "./projectRows";

test("rejects duplicate project ownership markers", () => {
  expect(() => requireUnambiguousProjectOwnershipMarker([
    {},
    {},
  ])).toThrow("Project ownership marker is ambiguous.");
});

test("ignores entity ownership rows when locating a project marker", () => {
  expect(requireUnambiguousProjectOwnershipMarker([
    { trackId: "track-1" },
    { clipId: "clip-1" },
    {},
  ])).toEqual({});
});
