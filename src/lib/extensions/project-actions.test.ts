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
    idempotencyKey: "project-action-test-request",
    expectedRevision: 0,
    approvalToken: "a".repeat(64),
  });
  await expect(facade.commit(commitRequest)).resolves.toMatchObject({ applied: true, revision: 1 });
});

test("enforces lifecycle before dispatch and preserves authoritative approval and commit results", async () => {
  const previewDeferred = Promise.withResolvers<ReturnType<typeof controlPreviewResultSchemaV1.parse>>();
  const approvalDeferred = Promise.withResolvers<ReturnType<typeof controlApprovalResultSchemaV1.parse>>();
  const commitDeferred = Promise.withResolvers<ReturnType<typeof controlCommitResultSchemaV1.parse>>();
  const calls = { preview: 0, approval: 0, commit: 0 };
  const raceHandlers: ControlOperationHandlers<"cloud"> = {
    ...handlers,
    "control.preview": async () => {
      calls.preview += 1;
      return previewDeferred.promise;
    },
    "control.requestApproval": async () => {
      calls.approval += 1;
      return approvalDeferred.promise;
    },
    "control.commit": async () => {
      calls.commit += 1;
      return commitDeferred.promise;
    },
  };
  let current = true;
  const controller = new AbortController();
  const raceFacade = createProjectActionFacade({
    client: createCanonicalControlClient(createDirectControlInvoker({
      handlers: raceHandlers,
      context: { target: "cloud", principal: { subject: "race-test" } },
    })),
    grant: { actionKinds: ["project.rename"], preview: true, approval: true, commit: true },
    lifecycle: {
      signal: controller.signal,
      generation: 1,
      isCurrent: () => current,
    },
  });
  const preview = raceFacade.preview(request);
  await Promise.resolve();
  current = false;
  previewDeferred.resolve(await handlers["control.preview"](request, { target: "cloud" }));
  await expect(preview).rejects.toThrow("stale");

  current = true;
  const approval = raceFacade.requestApproval(controlApprovalRequestSchemaV1.parse(request));
  await Promise.resolve();
  current = false;
  approvalDeferred.resolve(await handlers["control.requestApproval"](
    controlApprovalRequestSchemaV1.parse(request),
    { target: "cloud" },
  ));
  await expect(approval).resolves.toMatchObject({ baseRevision: 0 });

  current = true;
  const commit = raceFacade.commit(controlCommitRequestSchemaV1.parse({
    ...request,
    idempotencyKey: "request-race-123",
  }));
  await Promise.resolve();
  controller.abort();
  commitDeferred.resolve(await handlers["control.commit"](
    controlCommitRequestSchemaV1.parse({ ...request, idempotencyKey: "request-race-123" }),
    { target: "cloud" },
  ));
  await expect(commit).resolves.toMatchObject({ applied: true, revision: 1 });
  expect(calls).toEqual({ preview: 1, approval: 1, commit: 1 });

  const preDispatchController = new AbortController();
  preDispatchController.abort();
  const preDispatchCalls = { preview: 0 };
  const preDispatchFacade = createProjectActionFacade({
    client: createCanonicalControlClient(createDirectControlInvoker({
      handlers: {
        ...handlers,
        "control.preview": async () => {
          preDispatchCalls.preview += 1;
          return handlers["control.preview"](request, { target: "cloud" });
        },
      },
      context: { target: "cloud", principal: { subject: "pre-dispatch" } },
    })),
    grant: { actionKinds: ["project.rename"], preview: true, approval: true, commit: true },
    lifecycle: { signal: preDispatchController.signal, generation: 1, isCurrent: () => true },
  });
  await expect(preDispatchFacade.preview(request)).rejects.toThrow();
  expect(preDispatchCalls.preview).toBe(0);

  let staleCalls = 0;
  const staleFacade = createProjectActionFacade({
    client: createCanonicalControlClient(createDirectControlInvoker({
      handlers: {
        ...handlers,
        "control.requestApproval": async (input, context) => {
          staleCalls += 1;
          return handlers["control.requestApproval"](input, context);
        },
      },
      context: { target: "cloud", principal: { subject: "stale-dispatch" } },
    })),
    grant: { actionKinds: ["project.rename"], preview: true, approval: true, commit: true },
    lifecycle: { signal: new AbortController().signal, generation: 1, isCurrent: () => false },
  });
  await expect(staleFacade.requestApproval(controlApprovalRequestSchemaV1.parse(request))).rejects.toThrow("stale");
  expect(staleCalls).toBe(0);
});
