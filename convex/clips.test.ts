import { expect, test } from "bun:test";

import { requireSingleProjectId } from "./clips";

test("accepts empty and single-project clip batches", () => {
  expect(requireSingleProjectId([])).toBeUndefined();
  expect(requireSingleProjectId([
    { projectId: "project-1" },
    { projectId: "project-1" },
  ])).toBe("project-1");
});

test("rejects mixed-project clip batches before mutation work", () => {
  expect(() => requireSingleProjectId([
    { projectId: "project-1" },
    { projectId: "project-2" },
  ])).toThrow("Batch clip writes must target one project.");
});
