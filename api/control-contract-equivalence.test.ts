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
  { sdk: "capabilities", cli: "capabilities", mcp: "control_capabilities", method: "GET", path: "/api/control/v1/capabilities", scope: "control:read", parse: () => controlCapabilitiesQuerySchemaV1.parse({}) },
  { sdk: "snapshot", cli: "snapshot", mcp: "control_snapshot", method: "GET", path: `/api/control/v1/projects/${projectId}/snapshot`, scope: "control:read", parse: () => controlSnapshotQuerySchemaV1.parse({ projectId }) },
  { sdk: "preview", cli: "preview", mcp: "control_preview", method: "POST", path: `/api/control/v1/projects/${projectId}/preview`, scope: "control:write", parse: () => controlPreviewRequestSchemaV1.parse({ version: "v1", projectId, actions: [rename] }) },
  { sdk: "requestApproval", cli: "approval", mcp: "control_request_approval", method: "POST", path: `/api/control/v1/projects/${projectId}/approvals`, scope: "control:write", parse: () => controlApprovalRequestSchemaV1.parse({ version: "v1", projectId, actions: [rename] }) },
  { sdk: "commit", cli: "commit", mcp: "control_commit", method: "POST", path: `/api/control/v1/projects/${projectId}/commit`, scope: "control:write", parse: () => controlCommitRequestSchemaV1.parse({ version: "v1", projectId, idempotencyKey: "request-1", actions: [rename] }) },
  { sdk: "history", cli: "history", mcp: "control_history", method: "GET", path: `/api/control/v1/projects/${projectId}/history`, scope: "control:read", parse: () => controlHistoryQuerySchemaV1.parse({ projectId }) },
  { sdk: "recoveries", cli: "recoveries", mcp: "control_recoveries", method: "GET", path: `/api/control/v1/projects/${projectId}/recoveries`, scope: "control:read", parse: () => controlRecoveriesQuerySchemaV1.parse({ projectId }) },
] as const

describe("public control endpoint equivalence", () => {
  test("keeps supported REST, SDK, CLI, and MCP control operations aligned", () => {
    for (const endpoint of endpoints) {
      endpoint.parse()
      expect(endpoint.path).toStartWith("/api/control/v1/")
      expect(endpoint.scope).toBe(endpoint.method === "GET" ? "control:read" : "control:write")
      expect(canonicalControlOperations[endpoint.cli]).toBeDefined()
      expect(endpoint.mcp).toStartWith("control_")
      expect(endpoint.sdk).not.toBe("")
    }
  })
})
