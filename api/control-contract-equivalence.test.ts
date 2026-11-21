import { describe, expect, test } from "bun:test"
import {
  controlApprovalRequestSchemaV1,
  controlCapabilitiesQuerySchemaV1,
  controlCommitRequestSchemaV1,
  controlHistoryQuerySchemaV1,
  controlPreviewRequestSchemaV1,
  controlRecoveriesQuerySchemaV1,
  controlSnapshotQuerySchemaV1,
} from "@daw-browser/control"
import { canonicalControlOperations } from "../packages/control-cli/src/cli-control"

const projectId = "project-1"
const rename = { kind: "project.rename", name: "Renamed" }

const endpoints = [
  { cli: "capabilities", operation: "control.capabilities", parse: () => controlCapabilitiesQuerySchemaV1.parse({}) },
  { cli: "snapshot", operation: "control.snapshot", parse: () => controlSnapshotQuerySchemaV1.parse({ projectId }) },
  { cli: "preview", operation: "control.preview", parse: () => controlPreviewRequestSchemaV1.parse({ version: "v1", projectId, actions: [rename] }) },
  { cli: "approval", operation: "control.requestApproval", parse: () => controlApprovalRequestSchemaV1.parse({ version: "v1", projectId, actions: [rename] }) },
  { cli: "commit", operation: "control.commit", parse: () => controlCommitRequestSchemaV1.parse({ version: "v1", projectId, idempotencyKey: "request-1", actions: [rename] }) },
  { cli: "history", operation: "control.history", parse: () => controlHistoryQuerySchemaV1.parse({ projectId }) },
  { cli: "recoveries", operation: "control.recoveries", parse: () => controlRecoveriesQuerySchemaV1.parse({ projectId }) },
] as const

describe("public control endpoint equivalence", () => {
  test("parses every control request schema and maps each endpoint to a CLI operation", () => {
    for (const endpoint of endpoints) {
      endpoint.parse()
      expect(canonicalControlOperations[endpoint.cli]).toBe(endpoint.operation)
    }
  })
})
