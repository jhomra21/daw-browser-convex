import { expect, test } from "bun:test";
import { createCanonicalControlClient } from "@daw-browser/control-sdk";
import {
  controlPreviewRequestSchemaV1,
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlPreviewResultSchemaV1,
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  createDirectControlInvoker,
  type ControlOperationHandlers,
} from "@daw-browser/control";
import { createProjectActionFacade } from "./project-actions";

const request = controlPreviewRequestSchemaV1.parse({
  version: "v1",
  projectId: "project-1",
  actions: [{ kind: "project.rename", name: "Renamed" }],
});

const handlers: ControlOperationHandlers<"cloud"> = {
  "project.list": async () => { throw new Error("Unexpected operation"); },
  "control.capabilities": async () => { throw new Error("Unexpected operation"); },
  "control.snapshot": async () => { throw new Error("Unexpected operation"); },
  "control.preview": async () => controlPreviewResultSchemaV1.parse({
    version: "v1",
    projectId: "project-1",
    priorRevision: 0,
    revision: 0,
    requestDigest: "0".repeat(64),
    resolvedRefs: [],
    warnings: [],
    changeSummary: { actionCount: 1, changes: [] },
    applied: false,
  }),
  "control.commit": async () => controlCommitResultSchemaV1.parse({
    version: "v1",
    projectId: "project-1",
    priorRevision: 0,
    revision: 1,
    requestDigest: "0".repeat(64),
    resolvedRefs: [],
    warnings: [],
    changeSummary: { actionCount: 1, changes: [] },
    applied: true,
    idempotencyReplay: false,
    recoveries: [],
    restored: [],
  }),
  "control.requestApproval": async () => controlApprovalResultSchemaV1.parse({
    version: "v1",
    approvalToken: "a".repeat(64),
    requestDigest: "0".repeat(64),
    baseRevision: 0,
    actionIndexes: [0],
    expiresAt: Date.now() + 1000,
  }),
  "control.history": async () => { throw new Error("Unexpected operation"); },
  "control.recoveries": async () => { throw new Error("Unexpected operation"); },
};

const client = createCanonicalControlClient(createDirectControlInvoker({
  handlers,
  context: { target: "cloud", principal: { subject: "test" } },
}));

const facade = createProjectActionFacade({
  client,
  grant: {
    actionKinds: ["project.rename"],
    preview: true,
    approval: true,
    commit: true,
  },
  lifecycle: {
    signal: new AbortController().signal,
    generation: 1,
    isCurrent: (generation) => generation === 1,
  },
});

test("routes only granted project actions through the canonical client", async () => {
  await expect(facade.preview(request)).resolves.toMatchObject({ projectId: "project-1" });
});

test("rejects ungranted actions and stale or aborted lifecycles", async () => {
  const denied = createProjectActionFacade({
    client,
    grant: { actionKinds: [], preview: true, approval: false, commit: false },
    lifecycle: {
      signal: new AbortController().signal,
      generation: 1,
      isCurrent: () => true,
    },
  });
  await expect(denied.preview(request)).rejects.toThrow("ungranted");
  const controller = new AbortController();
  controller.abort();
  const aborted = createProjectActionFacade({
    client,
    grant: { actionKinds: ["project.rename"], preview: true, approval: true, commit: true },
    lifecycle: { signal: controller.signal, generation: 1, isCurrent: () => true },
  });
  await expect(aborted.preview(request)).rejects.toThrow();
});

test("supports explicit approval and commit boundaries without ambient authority", async () => {
  const approvalRequest = controlApprovalRequestSchemaV1.parse(request);
  await expect(facade.requestApproval(approvalRequest)).resolves.toMatchObject({ baseRevision: 0 });
  const commitRequest = controlCommitRequestSchemaV1.parse({
    ...request,
    idempotencyKey: "idempotency-1",
    expectedRevision: 0,
    approvalToken: "a".repeat(64),
  });
  await expect(facade.commit(commitRequest)).resolves.toMatchObject({ applied: true, revision: 1 });
});
