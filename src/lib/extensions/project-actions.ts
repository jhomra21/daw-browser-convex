import {
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlPreviewRequestSchemaV1,
  type ControlActionV1,
  type ControlApprovalRequestV1,
  type ControlApprovalResultV1,
  type ControlCommitRequestV1,
  type ControlCommitResultV1,
  type ControlPreviewRequestV1,
  type ControlPreviewResultV1,
} from "@daw-browser/control";
import type { CanonicalControlClient } from "@daw-browser/control-sdk";

type ProjectActionLifecycle = Readonly<{
  signal: AbortSignal;
  generation: number;
  isCurrent: (generation: number) => boolean;
}>;

export type ProjectActionGrant = Readonly<{
  actionKinds: readonly ControlActionV1["kind"][];
  preview: boolean;
  approval: boolean;
  commit: boolean;
}>;

export type ProjectActionFacade = Readonly<{
  preview: (request: ControlPreviewRequestV1) => Promise<ControlPreviewResultV1>;
  requestApproval: (request: ControlApprovalRequestV1) => Promise<ControlApprovalResultV1>;
  commit: (request: ControlCommitRequestV1) => Promise<ControlCommitResultV1>;
}>;

const ensureActive = (lifecycle: ProjectActionLifecycle) => {
  lifecycle.signal.throwIfAborted();
  if (!lifecycle.isCurrent(lifecycle.generation)) throw new Error("Project action generation is stale.");
};

const ensureGrant = (
  request: { actions: readonly ControlActionV1[] },
  grant: ProjectActionGrant,
  operation: "preview" | "approval" | "commit",
) => {
  if (!grant[operation]) throw new Error(`Project action ${operation} is not granted.`);
  const allowed = new Set(grant.actionKinds);
  if (request.actions.some((action) => !allowed.has(action.kind))) {
    throw new Error("Project action contains an ungranted action kind.");
  }
};

export const createProjectActionFacade = (
  input: Readonly<{
    client: CanonicalControlClient<"cloud"> | CanonicalControlClient<"desktop">;
    grant: ProjectActionGrant;
    lifecycle: ProjectActionLifecycle;
  }>,
): ProjectActionFacade => {
  const preview = async (request: ControlPreviewRequestV1) => {
    ensureActive(input.lifecycle);
    const parsed = controlPreviewRequestSchemaV1.parse(request);
    ensureGrant(parsed, input.grant, "preview");
    const result = await input.client.control.preview(parsed);
    ensureActive(input.lifecycle);
    return result;
  };

  const requestApproval = async (request: ControlApprovalRequestV1) => {
    ensureActive(input.lifecycle);
    const parsed = controlApprovalRequestSchemaV1.parse(request);
    ensureGrant(parsed, input.grant, "approval");
    // Approval issuance creates durable authority. Once dispatched, its result
    // must not be converted into a lifecycle error after the authority exists.
    return input.client.control.requestApproval(parsed);
  };

  const commit = async (request: ControlCommitRequestV1) => {
    ensureActive(input.lifecycle);
    const parsed = controlCommitRequestSchemaV1.parse(request);
    ensureGrant(parsed, input.grant, "commit");
    // Commit is authoritative and idempotent. Lifecycle changes after dispatch
    // cannot safely turn a successful authority result into an ambiguous failure.
    return input.client.control.commit(parsed);
  };

  return Object.freeze({ preview, requestApproval, commit });
};
