# Control platform architecture

This document explains how project control is split across contracts, pure project logic, trusted project owners, and transport adapters. The schemas in `@daw-browser/control` are the source of truth.

## Who owns what

`@daw-browser/control` owns versioned schemas, operation IDs, request envelopes, snapshots, serialization, request digests, recovery payloads, limits, and capabilities.

`@daw-browser/control-core` owns pure project planning and projection. It also owns MIDI resolution, destructive transforms, and recovery ordering. It does not own transport, authentication, or storage.

A project owner binds those contracts to real state:

- local desktop control uses the mounted local project
- cloud control uses the authenticated Worker and Convex path

`ControlInvoker` checks that an operation is allowed for the selected target and validates its input and output. REST, desktop, CLI, SDK, JSONL, and MCP all sit outside that boundary.

## Operation catalog

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

`project.current` is desktop-only because it refers to the project mounted in the Electron app.

Capabilities and snapshots use the V2 representation for current integrations. The existing mutation, approval, history, and recovery requests keep their V1 compatibility envelope. This keeps older callers working while new callers get the richer read model.

## Project control and desktop runtime are different APIs

Project control changes durable project state. Desktop runtime operations control the attached Electron host.

The desktop runtime catalog is owned by `@daw-browser/desktop-protocol`:

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

Do not add these IDs to `controlActionSchemaV1`. Playing the transport or asking for host diagnostics is not a project mutation.

VST parameter writes follow the opposite rule. `external-plugin.parameters.set` is a project-control action because the value belongs to project state. It is available only when local capabilities advertise it.

## TypeScript SDK

`@daw-browser/control-sdk` exports:

- `createCanonicalControlClient` for typed project discovery and control
- `createJsonlRpcAdapter` for sequential JSON-RPC over JSONL
- the retained REST compatibility client with V1 methods plus `capabilitiesV2` and `snapshotV2`

`@daw-browser/control-sdk/desktop` exports `connectDesktopControl`. It discovers the packaged desktop registration, authenticates the local connection, and returns a typed desktop invoker plus `close()`.

The desktop SDK does not expose raw stores, registration secrets, socket internals, or arbitrary Electron IPC.

## CLI

`@daw-browser/control-cli` provides the `daw-control` executable.

Project-control commands:

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

`rpc --target host` carries project-control JSONL over the authenticated desktop connection. It is not a generic host command channel.

Desktop runtime commands are separate:

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

## MCP

`@daw-browser/control-mcp` exposes project-control tools and desktop runtime tools under different names.

New integrations should prefer these read tools:

```text
control_capabilities_v2
control_snapshot_v2
```

V1 compatibility reads remain available:

```text
control_capabilities
control_snapshot
```

Project workflow tools:

```text
project_list
project_current
control_preview
control_request_approval
control_commit
control_history
control_recoveries
```

Desktop runtime tools:

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

MCP reads use `control:read`. Preview, approval, and commit use `control:write`. `target:"cloud"` is the default. `target:"host"` requires an attached desktop app. `project_current` works only on the host target.

`offline_access` is an OAuth credential scope. It is not permission to mutate a project.

## HTTP routes

The Worker keeps the versioned control routes under `/api/control`:

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

OAuth bearer tokens target `${origin}/api`. The Worker checks `control:read` or `control:write`, project access, and project role before it calls the project owner.

## Asset routes

Assets are project resources. They are not extra control actions.

```text
POST   /api/control/v1/projects/:projectId/assets
GET    /api/control/v1/projects/:projectId/assets/:assetId/content
DELETE /api/control/v1/projects/:projectId/assets/:assetId
POST   /api/control/v1/projects/:projectId/asset-folders
PATCH  /api/control/v1/projects/:projectId/asset-folders/:folderId
DELETE /api/control/v1/projects/:projectId/asset-folders/:folderId
PATCH  /api/control/v1/projects/:projectId/assets/:assetId/folder
```

Multipart upload requires `Content-Length`, `Idempotency-Key`, and `x-content-sha256`. The Worker checks file size, MIME type, extension, digest, and audio metadata before the Convex and R2 upload is finalized.

An action may refer to a persisted asset ID returned by project state. It must not invent an R2 object key.

Other resource routes include:

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

## Request lifecycle

A normal project mutation should follow this order:

1. Discover the project with `project.list`. Use `project.current` only for the mounted desktop project.
2. Read `control.capabilities` and use the returned action list and limits.
3. Read the V2 `control.snapshot` and note its revision.
4. Build references from IDs in that snapshot.
5. Preview the exact V1 request.
6. Request approval only if preview requires it.
7. Commit the same request with a stable idempotency key.
8. Read a fresh snapshot or history to confirm the result.

A persisted reference looks like this:

```json
{"source":"persisted","id":"track-1"}
```

If the commit returns `revision-conflict`, discard the stale request. Fetch a new snapshot, rebuild the references and actions, preview again, and then commit.

Recoveries expire after seven days.

## Compatibility rules

The merge kept these compatibility contracts:

- V1 and V2 control contracts
- versioned REST routes
- desktop protocol framing
- CLI commands
- MCP compatibility tools
- durable control, history, and recovery records
- `registration-v1.json`

Do not remove one of these because a newer path exists in this repository. Deletion needs evidence that deployed or installed consumers no longer depend on it.

There is no public arbitrary-operation endpoint, cloud JSONL process transport, external extension package loader, or arbitrary DSP/package loader.

For action schemas and examples, read [agent-control.md](agent-control.md). For native plugin behavior, read [native-vst3.md](native-vst3.md).

## Test

Run the focused control-platform suite with:

```sh
bun run test:control-platform
```