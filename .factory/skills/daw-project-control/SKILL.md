---
name: daw-project-control
description: Use the DAW model-independent control platform to discover, inspect, edit, approve, commit, recover, or inspect history for cloud or desktop projects. Use for track, clip, mixer, effect, instrument, automation, routing, asset-delete, recovery, or external-plugin parameter edits.
---

# DAW project control

Read [the operating manual](../../../docs/agent-control.md) and
[the architecture reference](../../../docs/control-platform.md). The source
contracts are authoritative:

- `packages/control/src/operations.ts` — canonical operation catalog and target
  boundaries.
- `packages/control/src/actions.ts` — V1 action and request schemas.
- `packages/control/src/versions.ts` — V2 capabilities, limits, action
  inventory, and local-only capability projection.

Follow this workflow:

1. Discover with `project.list`; use desktop-only `project.current` only for
   the mounted local project.
2. Read V2 `control.capabilities` and V2 `control.snapshot`. The returned
   capabilities object is authoritative.
3. Build schema-valid V1 actions from snapshot IDs and same-request client
   references only where the schema permits them.
4. Preview the exact request, request approval if preview requires it, commit
   the exact request with a stable idempotency key, then re-observe with a
   fresh V2 snapshot and inspect history when needed.
5. On `revision-conflict`, discard the stale request, fetch a fresh snapshot,
   rebuild references/actions, preview again, and only then commit.

Do not access Convex, IndexedDB, native frames, raw stores, or internal
invokers directly when a public client exists. Do not invent mutation tools,
alternate validators, IDs, or local-only cloud actions. Keep approval tokens,
bearer tokens, actor credentials, registration secrets, and private object
keys out of logs and responses.
