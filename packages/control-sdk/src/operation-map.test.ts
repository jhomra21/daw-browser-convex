import { expect, test } from "bun:test";

import { canonicalControlClientOperationMap } from "./index";

test("SDK methods map to control operations in their published order", () => {
  expect(canonicalControlClientOperationMap).toEqual({
    projects: { list: "project.list", current: "project.current" },
    control: {
      capabilities: "control.capabilities",
      snapshot: "control.snapshot",
      preview: "control.preview",
      requestApproval: "control.requestApproval",
      commit: "control.commit",
      history: "control.history",
      recoveries: "control.recoveries",
    },
  });
  expect(Object.keys(canonicalControlClientOperationMap.control)).toEqual([
    "capabilities", "snapshot", "preview", "requestApproval", "commit", "history", "recoveries",
  ]);
});
