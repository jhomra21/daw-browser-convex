# Agent control operating manual

This is the operating manual for an agent or automation client using the
public DAW control surfaces. The schemas in `@daw-browser/control` are
authoritative. This document explains the safe workflow; it is not a
replacement validator.

## Golden workflow

1. Discover a project with `project.list`; on desktop, use
   `project.current` only to identify the mounted project.
2. Call `control.capabilities` and use the returned canonical V2 capabilities
   object as the authority for supported actions, limits, targets, and
   local-only support.
3. Call `control.snapshot` and use the canonical V2 snapshot and its revision.
4. Build V1 actions and references from the returned capabilities and snapshot.
5. Call `control.preview` with the exact V1 request.
6. If preview says approval is required, call `control.requestApproval` for
   that exact request.
7. Call `control.commit` with the exact request, a stable idempotency key, and
   the approval token when required.
8. Re-observe with a fresh V2 snapshot and inspect `control.history` when an
   audit record is needed.

**THE RETURNED CAPABILITIES OBJECT IS AUTHORITATIVE.** Do not infer support
from UI labels, package names, host status, cloud assumptions, or prior
responses.

## Choose the boundary

Project control changes semantic project state through the canonical operation
catalog. Desktop runtime operations are a separate catalog for the
authenticated Electron host.

Project targets are:

- `cloud`: an authenticated shared project through the Worker/Convex boundary.
- `desktop`: the authenticated packaged host and its mounted local project.

`project.current` is desktop-only. Cloud discovery uses `project.list`.
Runtime IDs such as transport, diagnostics, import/export, and VST discovery
are not project semantic actions.

## Discover and inspect

Use bounded discovery and never guess an ID from a filename, URL, or runtime
status:

```json
{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}
```

For a mounted desktop project:

```json
{"jsonrpc":"2.0","id":2,"method":"project.current","params":{}}
```

Then call canonical capabilities and snapshot operations:

```json
{"jsonrpc":"2.0","id":3,"method":"control.capabilities","params":{}}
```

```json
{"jsonrpc":"2.0","id":4,"method":"control.snapshot","params":{"projectId":"project-1"}}
```

The canonical capabilities and snapshot representations are V2. Preview,
approval, commit, history, and recovery envelopes remain V1 compatibility
contracts. The request `version` is therefore `"v1"` even when its
`expectedRevision` came from a V2 snapshot.

Cloud capabilities advertise 39 action kinds. Local project capabilities
advertise those 39 plus the local-only
`external-plugin.parameters.set`, for 40 total. Never infer local-only
support from cloud capabilities or a desktop runtime ID.

## References and actions

An existing entity is addressed with its ID from the latest snapshot:

```json
{"source":"persisted","id":"track-1"}
```

A client reference is allowed only where the schema supports it and only for
an entity created earlier in the same request:

```json
{"source":"client","clientRef":"new-track"}
```

Client references are request-local. Do not invent them for persisted
entities, reuse them across requests, or use them to avoid a fresh snapshot.
Actions are ordered, schema-validated V1 values; package schemas enforce
names, IDs, numeric ranges, array bounds, and action-specific invariants.

## Preview, approval, and commit

### Preview

Call `control.preview` before every mutation. Preview is non-mutating and
returns the request digest, resolved references, warnings, change summary,
base/current revisions, and whether approval is required. Do not alter the
request after preview.

### Approval

When `preview.approval.required` is true, call `control.requestApproval` with
the same project, revision, and ordered actions. Approval is bound to the
request digest and selected action indexes and expires after 600 seconds.

### Commit

Call `control.commit` with the exact previewed request, a stable idempotency
key, and the approval token only when required. Reusing a key is safe only for
the same request. An idempotent replay does not create a second mutation.
Never silently change a payload or key after an idempotency conflict.

After a successful or idempotent commit, fetch a fresh V2 snapshot and verify
the intended result.

## Idempotency

Every commit request must carry a stable `idempotencyKey`. Reuse that key only
for the identical project, revision, ordered actions, and approval context.
An identical replay is safe and does not apply a second mutation; a changed
request with the same key is an idempotency conflict. Do not rotate the key
to conceal a changed payload or retry a request whose original outcome is
unknown without first inspecting the returned error and re-observing state.

## Revision conflicts

On `revision-conflict`, discard the stale request. Fetch a fresh V2 snapshot,
re-resolve every persisted reference, rebuild the V1 request, preview again,
request approval again when required, and commit only the rebuilt request.
Never retry a stale request unchanged. A client reference from the old request
cannot be carried into the rebuilt request.

## Complete action inventory

The cloud catalog contains exactly these 39 action kinds:

### Project and tracks

```text
project.rename
project.settings.set
track.create
track.rename
track.routing.set
track.reorder
track.group.set
track.delete
track.collapsed.set
track.color.set
track.color.cascade
track.ungroup
```

### Mixer

```text
track.mix.set
master.volume.set
```

### Clips and timeline

```text
clip.midi.create
clip.move
clip.timing.set
clip.rename
clip.delete
clip.audio.create
clip.source.set
clip.midi.set
clip.fades.set
clip.audioWarp.set
clip.color.set
timeline.range.delete
```

### Built-in processors

```text
instrument.set
instrument.remove
arpeggiator.set
arpeggiator.remove
```

### Effects

```text
effect.upsert
effect.remove
effect.reorder
```

### Automation and routing

```text
automation.set
automation.delete
sidechain.set
sidechain.remove
```

### Assets and recovery

```text
asset.delete
recovery.restore
```

Local project control adds exactly one separate local-only action:

```text
external-plugin.parameters.set
```

## Things agents must never do

- Directly mutate Convex instead of using the public control client.
- Directly change IndexedDB entities or project history.
- Send raw native frames when a public client exists.
- Bypass preview or required approval.
- Invent project, entity, processor, asset, or recovery IDs.
- Assume local-only actions are available from cloud capabilities.
- Log secrets, approval tokens, registration tokens, bearer tokens, actor
  credentials, socket paths, or private object keys.
- Manually mutate plugin state artifacts.
- Claim VST workers are a hostile-code sandbox.

## VST agent workflow

1. Confirm the target is an attached desktop host; browser and cloud targets
   do not load native VST3 binaries.
2. Read advertised local capabilities and use
   `external-plugin.parameters.set` only when that exact action is present.
3. Use `host.vst.instances` and `host.vst.parameters` for bounded reads.
4. Do not use public control to insert/remove plugins, control processes, or
   manipulate arbitrary editors.
5. For native lifecycle, follow [native-vst3.md](native-vst3.md): standard
   discovery, user trust/consent, scanner and fingerprint checks, packaged
   worker preflight, bounded state, editor separation, recovery, and export
   constraints.

## Host runtime operations

The exact desktop runtime IDs are:

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

The CLI command `daw-control rpc --target host` is canonical **PROJECT
CONTROL JSONL**, not generic runtime RPC. Host status, playback, pause, stop,
seek, diagnostics, local import, local export, and VST reads remain separate
runtime operations. VST parameter writes belong to canonical project control.
Do not access registration/socket internals manually.

## Cloud asset resources

Assets are project-scoped resources, not additional project actions. A control
action can reference a persisted asset ID, but never grants direct R2 access
and never permits an agent to invent an object key.

```text
POST   /api/control/v1/projects/:projectId/assets
GET    /api/control/v1/projects/:projectId/assets/:assetId/content
DELETE /api/control/v1/projects/:projectId/assets/:assetId
POST   /api/control/v1/projects/:projectId/asset-folders
PATCH  /api/control/v1/projects/:projectId/asset-folders/:folderId
DELETE /api/control/v1/projects/:projectId/asset-folders/:folderId
PATCH  /api/control/v1/projects/:projectId/assets/:assetId/folder
```

Asset upload is multipart, capped at 10 MiB, and requires project write
access, `Content-Length`, `Idempotency-Key`, and the lowercase
`x-content-sha256` header. The route validates MIME type and matching file
extension, verifies the digest against uploaded bytes, and derives audio
metadata from the bytes before beginning the Convex/R2 upload.

Content reads require project read access and preserve range handling through
the object response. Folder creation, rename, deletion, and asset moves are
resource routes, not additions to the action catalog. Other resource families
include `/api/samples`, `/api/exports`, `/api/export/:projectId`, and
`/api/cloud-backups`.

## Recoveries

Destructive commits may return a persisted recovery ID. Recoveries are listed
by `control.recoveries` and expire after seven days. Supported kinds are:

```text
clip.delete
effect.remove
instrument.remove
arpeggiator.remove
automation.delete
sidechain.remove
asset.delete
track.delete
track.ungroup
timeline.range.delete
```

Restore with `recovery.restore` using the persisted recovery ID returned by
the recovery list or commit result. Re-observe after restoring.

## Examples

The following examples use IDs returned by discovery/snapshot calls. They are
documentation fixtures, not live credentials or live project requests.

### Project discovery

```json
{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}
```

### Rename preview and commit without approval

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":4,
  "actions":[
    {
      "kind":"track.rename",
      "track":{"source":"persisted","id":"track-1"},
      "name":"Bass"
    }
  ]
}
```

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":4,
  "idempotencyKey":"rename-track-project-1-revision-4",
  "actions":[
    {
      "kind":"track.rename",
      "track":{"source":"persisted","id":"track-1"},
      "name":"Bass"
    }
  ]
}
```

The second request is committed only after the first request previews
successfully. It intentionally has no `approvalToken`.

### Destructive track delete preview, approval, and commit

Preview:

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":8,
  "actions":[
    {
      "kind":"track.delete",
      "track":{"source":"persisted","id":"track-2"}
    }
  ]
}
```

Approval request:

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":8,
  "actions":[
    {
      "kind":"track.delete",
      "track":{"source":"persisted","id":"track-2"}
    }
  ]
}
```

Commit with a schema-valid documentation placeholder:

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":8,
  "idempotencyKey":"delete-track-project-1-revision-8",
  "approvalToken":"APPROVAL_TOKEN_PLACEHOLDER_32_CHARS",
  "actions":[
    {
      "kind":"track.delete",
      "track":{"source":"persisted","id":"track-2"}
    }
  ]
}
```

The placeholder is not a real token and must never be transmitted. A real
client passes only the token returned for this exact request.

### External-plugin parameter edit on a host

Use this only when local V2 capabilities advertise
`external-plugin.parameters.set`:

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":7,
  "actions":[
    {
      "kind":"external-plugin.parameters.set",
      "target":{"kind":"track","track":{"source":"persisted","id":"track-1"}},
      "processor":{"source":"persisted","id":"processor-1"},
      "changes":[{"parameterId":42,"normalizedValue":0.625}]
    }
  ]
}
```

Preview and commit this as canonical project control; it is not a raw host
runtime write.

### Recovery restore

```json
{
  "version":"v1",
  "projectId":"project-1",
  "expectedRevision":9,
  "actions":[
    {
      "kind":"recovery.restore",
      "recovery":{"id":"recovery-1"}
    }
  ]
}
```

The recovery ID must come from `control.recoveries` or a prior commit result.

## Public adapters

`@daw-browser/control-sdk` exports `createCanonicalControlClient`,
`createJsonlRpcAdapter`, and the retained REST compatibility client.
`@daw-browser/control-sdk/desktop` exports `connectDesktopControl`.

The `daw-control` CLI exposes cloud/host discovery, V2 reads, preview,
approval, commit, history, recoveries, and separate host runtime commands.
MCP prefers `control_capabilities_v2` and `control_snapshot_v2`; unsuffixed
reads are V1 compatibility tools. MCP reads use `control:read`; preview,
approval, and commit use `control:write`.

Use the existing authenticated adapters. Never print, persist, or transmit
registration secrets, bearer tokens, actor credentials, socket paths, or
private object keys.
