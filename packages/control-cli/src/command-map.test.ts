import { expect, test } from "bun:test";

import { canonicalControlOperations } from "./cli-control";

test("CLI commands map to control operations in their published order", () => {
  expect(Object.entries(canonicalControlOperations)).toEqual([
    ["capabilities", "control.capabilities"],
    ["capabilities-v2", "control.capabilities"],
    ["snapshot", "control.snapshot"],
    ["snapshot-v2", "control.snapshot"],
    ["preview", "control.preview"],
    ["approval", "control.requestApproval"],
    ["commit", "control.commit"],
    ["history", "control.history"],
    ["recoveries", "control.recoveries"],
  ]);
});
