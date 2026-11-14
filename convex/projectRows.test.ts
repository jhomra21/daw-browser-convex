import { expect, test } from "bun:test";

import { assertEffectWriterRevisions, requireUnambiguousProjectOwnershipMarker } from "./projectRows";

test("accepts effect writer stamps only when each equals the owner's revision", () => {
  expect(() => assertEffectWriterRevisions([], 4)).not.toThrow();
  expect(() => assertEffectWriterRevisions([4, 4], 4)).not.toThrow();
  expect(() => assertEffectWriterRevisions([4, 3], 4)).toThrow("Effect row stamp diverged from the owning project revision.");
  expect(() => assertEffectWriterRevisions([5], 4)).toThrow("Effect row stamp diverged from the owning project revision.");
});

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
