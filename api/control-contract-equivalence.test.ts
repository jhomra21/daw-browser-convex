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
  { cli: "capabilities", parse: () => controlCapabilitiesQuerySchemaV1.parse({}) },
  { cli: "snapshot", parse: () => controlSnapshotQuerySchemaV1.parse({ projectId }) },
  { cli: "preview", parse: () => controlPreviewRequestSchemaV1.parse({ version: "v1", projectId, actions: [rename] }) },
  { cli: "approval", parse: () => controlApprovalRequestSchemaV1.parse({ version: "v1", projectId, actions: [rename] }) },
  { cli: "commit", parse: () => controlCommitRequestSchemaV1.parse({ version: "v1", projectId, idempotencyKey: "request-1", actions: [rename] }) },
  { cli: "history", parse: () => controlHistoryQuerySchemaV1.parse({ projectId }) },
  { cli: "recoveries", parse: () => controlRecoveriesQuerySchemaV1.parse({ projectId }) },
] as const

describe("public control endpoint equivalence", () => {
  test("parses every control request schema and maps each endpoint to a CLI operation", () => {
    for (const endpoint of endpoints) {
      endpoint.parse()
      expect(canonicalControlOperations[endpoint.cli]).toBeDefined()
    }
  })
})
