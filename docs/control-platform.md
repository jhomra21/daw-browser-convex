# Control platform architecture

This is the authoritative architecture reference for project control and its
public adapters. Exact schemas remain owned by `@daw-browser/control`; this
document explains ownership, transport boundaries, and safe usage.

## Contract ownership

`@daw-browser/control` owns versioned schemas, serialization, request digests,
durable request metadata, recovery payloads, and the keyed operation catalog.
`@daw-browser/control-core` owns pure semantic planning and projection. It
does not own transport or durable storage and does not create a second
validation authority.

A `ControlInvoker` binds one target and trusted principal, then dispatches
through the catalog. REST, desktop, CLI, SDK, and MCP are adapters around
these owners.

## Canonical operation catalog

| Operation | Targets | Effect | Idempotency | Approval |
| --- | --- | --- | --- | --- |
| `project.list` | cloud, desktop | read | safe | never |
| `project.current` | desktop | read | safe | never |
| `control.capabilities` | cloud, desktop | read | safe | never |
| `control.snapshot` | cloud, desktop | read | safe | never |
| `control.preview` | cloud, desktop | preview | safe | never |
| `control.requestApproval` | cloud, desktop | write | none | never |
| `control.commit` | cloud, desktop | write | keyed | conditional |
| `control.history` | cloud, desktop | read | safe | never |
| `control.recoveries` | cloud, desktop | read | safe | never |

Capabilities and snapshots are canonical V2 representations. Preview,
approval, commit, history, and recovery envelopes remain V1 compatibility
contracts. V1 adapters project from canonical provider values; they are not a
second semantic implementation.

## Targets and runtime separation

Project control targets are `cloud` and `desktop`. `project.current` is
desktop-only because it describes the mounted local project.

Desktop runtime IDs are owned by `@daw-browser/desktop-protocol` and are not
project semantic actions:

```text
host.status
host.vst.instances
host.vst.parameters
host.import.audio
host.export.run
host.export.status
host.export.cancel
transport.status
transport.play
transport.pause
transport.stop
transport.seek
diagnostics.snapshot
```

Do not add runtime IDs to `controlActionSchemaV1` or infer project mutations
from host capabilities. The public VST parameter write is the local
`external-plugin.parameters.set` project action, not generic runtime RPC.

## Public TypeScript SDK

`@daw-browser/control-sdk` exports:

- `createCanonicalControlClient`, a typed transport-neutral client grouped as
  `projects` and `control`.
- `createJsonlRpcAdapter`, a bounded sequential JSONL adapter.
- The retained REST compatibility client with V1 methods plus
  `capabilitiesV2` and `snapshotV2`.

The `@daw-browser/control-sdk/desktop` entry point exports
`connectDesktopControl`. It discovers and authenticates the packaged desktop
host through the existing registration/socket adapter, then returns a typed
desktop invoker and `close`. The SDK does not expose raw stores or an
arbitrary invoker.

## CLI surface

`@daw-browser/control-cli` provides the `daw-control` executable:

```text
auth login --base-url <origin>
auth status
auth logout
capabilities [--target <cloud|host>]
capabilities-v2 [--target <cloud|host>]
project list [--target <cloud|host>]
project current --target host
snapshot <project-id> [--target <cloud|host>]
snapshot-v2 <project-id> [--target <cloud|host>]
preview --request <file|->
approval --request <file|->
commit --request <file|->
history <project-id> [--cursor <cursor>] [--limit <number>]
recoveries <project-id> [--cursor <cursor>] [--limit <number>]
rpc --target host
```

`rpc --target host` is the canonical project-control JSONL adapter over the
authenticated desktop host, not generic runtime RPC. Host commands remain
separate:

```text
host status
host transport-status
host play
host pause
host stop
host seek <seconds>
host diagnostics
host import (--path <absolute-path>|--picker)
host export --request <file|->
host export-status
host export-cancel <job-id>
```

## MCP surface

`@daw-browser/control-mcp` registers project workflow tools and separately
named host tools.

Preferred canonical reads for new integrations:

```text
control_capabilities_v2
control_snapshot_v2
```

V1 compatibility reads:

```text
control_capabilities
control_snapshot
```

Workflow tools:

```text
project_list
project_current
control_preview
control_request_approval
control_commit
control_history
control_recoveries
```

Host tools:

```text
host_status
host_transport_status
host_play
host_pause
host_stop
host_seek
host_diagnostics
host_import_audio
host_export_run
host_export_status
host_export_cancel
host_vst_instances
host_vst_parameters
```

MCP control reads use `control:read`; preview, approval, and commit use
`control:write`. `target:"cloud"` is the default route. `target:"host"` needs
an attached desktop host and its advertised capabilities.
`project_current` is host-only. `offline_access` is an OAuth credential scope,
not a project action permission.

## REST surface

The Worker exposes retained control routes under `/api/control`:

```text
GET  /api/control/v1/capabilities
GET  /api/control/v2/capabilities
GET  /api/control/v1/projects
GET  /api/control/v1/projects/:projectId/snapshot
GET  /api/control/v2/projects/:projectId/snapshot
POST /api/control/v1/projects/:projectId/preview
POST /api/control/v1/projects/:projectId/approvals
POST /api/control/v1/projects/:projectId/commit
GET  /api/control/v1/projects/:projectId/history
GET  /api/control/v1/projects/:projectId/recoveries
```

Bearer OAuth resources are `${origin}/api`. `control:read` authorizes reads;
`control:write` authorizes preview, approval, commit, and write-side resource
operations. The API enforces project access and role checks.

### Asset and resource routes

Assets are not control actions. They are project-scoped resources whose R2
locators remain behind the Worker/Convex boundary:

```text
POST   /api/control/v1/projects/:projectId/assets
GET    /api/control/v1/projects/:projectId/assets/:assetId/content
DELETE /api/control/v1/projects/:projectId/assets/:assetId
POST   /api/control/v1/projects/:projectId/asset-folders
PATCH  /api/control/v1/projects/:projectId/asset-folders/:folderId
DELETE /api/control/v1/projects/:projectId/asset-folders/:folderId
PATCH  /api/control/v1/projects/:projectId/assets/:assetId/folder
```

Multipart asset upload requires `Content-Length`, `Idempotency-Key`, and
`x-content-sha256`, then validates bounded size, MIME/extension, and audio
metadata before the Convex/R2 begin-upload and finalize-upload sequence.
Content reads require project read access and may pass range headers through to
R2. Asset deletes use the canonical `asset.delete` commit path and its normal
revision/idempotency/approval behavior.

Separate sample, export, and cloud-backup resource families are:

```text
POST   /api/samples
GET    /api/samples/:projectId/:assetKey
DELETE /api/samples/:projectId/:assetKey
POST   /api/exports
DELETE /api/exports/:exportId
GET    /api/export/:projectId?key=<project-scoped-key>
POST   /api/cloud-backups
GET    /api/cloud-backups/:projectId
```

An agent may reference a persisted asset ID in a project action, but must not
invent an R2 key or treat a resource route as raw storage access.

## Safe workflow

1. Discover with `project.list`; on desktop use `project.current` when the
   mounted project is needed.
2. Read `control.capabilities` and use its action list and limits.
3. Read the canonical V2 `control.snapshot`.
4. Build references from snapshot IDs:
   `{ "source": "persisted", "id": "<id>" }`.
5. Preview the exact V1 request.
6. Request approval for the exact request when required.
7. Commit the exact request with `version: "v1"` and a stable idempotency key.
8. Fetch a fresh V2 snapshot and verify the result.

On `revision-conflict`, fetch a new snapshot and rebuild all references and
actions. Never commit a stale request unchanged. Recoveries expire after seven
days.

## Compatibility and deferred boundaries

V1/V2 contracts, REST routes, desktop frames, CLI commands, MCP tools, durable
rows, and `registration-v1.json` remain retained. No external deployed or
installed-consumer parity is claimed by this document.

There is no public arbitrary operation endpoint, external extension package
loader, arbitrary package/DSP loader, or cloud JSONL process transport.

For agent-facing examples and the complete action inventory, see
[agent-control.md](agent-control.md). For native trust and VST3 lifecycle, see
[native-vst3.md](native-vst3.md).

## Validation

The focused control-platform suite is:

```sh
bun run test:control-platform
```
