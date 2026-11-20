import { expect, test } from "bun:test";

import { controlOperationCatalog, listControlOperationDescriptors } from "./operations";

test("the catalog keeps the control operation ids in their published order", () => {
  expect(listControlOperationDescriptors().map((descriptor) => descriptor.id)).toEqual([
    "project.list", "project.current", "control.capabilities", "control.snapshot", "control.preview",
    "control.requestApproval", "control.commit", "control.history", "control.recoveries",
  ]);
});

test("the catalog names every surface for each operation", () => {
  const surfaces = Object.values(controlOperationCatalog).map((descriptor) => [descriptor.id, descriptor.surfaces]);

  expect(surfaces).toEqual([
    ["project.list", { sdk: { group: "projects", method: "list" }, cli: [], mcp: "project_list" }],
    ["project.current", { sdk: { group: "projects", method: "current" }, cli: [], mcp: "project_current" }],
    ["control.capabilities", { sdk: { group: "control", method: "capabilities" }, cli: ["capabilities", "capabilities-v2"], mcp: "control_capabilities_v2" }],
    ["control.snapshot", { sdk: { group: "control", method: "snapshot" }, cli: ["snapshot", "snapshot-v2"], mcp: "control_snapshot_v2" }],
    ["control.preview", { sdk: { group: "control", method: "preview" }, cli: ["preview"], mcp: "control_preview" }],
    ["control.requestApproval", { sdk: { group: "control", method: "requestApproval" }, cli: ["approval"], mcp: "control_request_approval" }],
    ["control.commit", { sdk: { group: "control", method: "commit" }, cli: ["commit"], mcp: "control_commit" }],
    ["control.history", { sdk: { group: "control", method: "history" }, cli: ["history"], mcp: "control_history" }],
    ["control.recoveries", { sdk: { group: "control", method: "recoveries" }, cli: ["recoveries"], mcp: "control_recoveries" }],
  ]);
});
