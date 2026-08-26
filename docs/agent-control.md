# Agent control manual

Use this document when an agent or external program needs to read or change DAW project state. The schemas in `@daw-browser/control` decide what is valid.

The first rule is simple: trust the capabilities response, not assumptions about the UI, package names, or a previous run.

## Standard workflow

1. Discover the project with `project.list`. On desktop, `project.current` can identify the mounted project.
2. Read `control.capabilities`.
3. Read `control.snapshot` and keep its revision.
4. Build V1 actions from IDs in that snapshot.
5. Preview the exact request with `control.preview`.
6. If preview requires approval, request it with `control.requestApproval`.
7. Commit the same request with a stable idempotency key.
8. Fetch a fresh snapshot. Use history when you need an audit record.

Capabilities and snapshots use the V2 representation. Mutation, approval, history, and recovery requests keep the V1 compatibility envelope.

## Pick the right target

Project control has two targets.

`cloud` addresses an authenticated shared project through the Worker and Convex.

`desktop` addresses the project mounted in the Electron app. Desktop can also advertise local-only project actions such as VST parameter changes.

`project.current` works only on desktop. Cloud discovery uses `project.list`.

Transport, diagnostics, import/export, and VST discovery are desktop runtime operations. They are not project actions.

## Discover before you write

Do not guess IDs from filenames, URLs, UI labels, or host status.

```json
{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}
```

For the mounted desktop project:

```json
{"jsonrpc":"2.0","id":2,"method":"project.current","params":{}}
```

Then read capabilities and the snapshot:

```json
{"jsonrpc":"2.0","id":3,"method":"control.capabilities","params":{}}
```

```json
{"jsonrpc":"2.0","id":4,"method":"control.snapshot","params":{"projectId":"project-1"}}
```

Cloud capabilities currently list 39 action kinds. Desktop project control lists those 39 plus `external-plugin.parameters.set` when the local project supports it.

## References

Use a persisted ID from the latest snapshot:

```json
{"source":"persisted","id":"track-1"}
```

A client reference is only for an entity created earlier in the same request, and only where the schema allows it:

```json
{"source":"client","clientRef":"new-track"}
```

Client references do not survive across requests. Do not use them as a substitute for a fresh snapshot.

## Preview, approval, and commit

### Preview

Run `control.preview` before every mutation. Preview validates the request without changing project state. It returns the digest, resolved references, warnings, change summary, revisions, and approval requirement.

Do not edit the request after preview. If the payload changes, preview again.

### Approval

If `preview.approval.required` is true, call `control.requestApproval` with the same project, revision, and ordered actions.

Approval is tied to the request digest and selected action indexes. It expires after 600 seconds. A token for one request cannot authorize another request.

### Commit

Send the exact previewed request to `control.commit`. Include a stable `idempotencyKey` and the approval token only when approval is required.

Replaying the same request with the same key is safe. Sending a different request with the same key returns an idempotency conflict.

After commit, read a fresh snapshot and verify the result.

## Revision conflicts

If commit returns `revision-conflict`, throw away the stale request.

Fetch a new snapshot. Resolve IDs again. Rebuild the actions. Preview again. Request approval again if needed. Then commit the rebuilt request.

Do not retry the old request unchanged.

## Action inventory

Cloud project control currently exposes these 39 action kinds.

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

Desktop project control can add one local-only action:

```text
external-plugin.parameters.set
```

This list is documentation. The capabilities response is the authority for the current project.

## VST parameters

VST3 runs only in the desktop app.

Use these runtime reads to inspect the native host:

```text
host.vst.instances
host.vst.parameters
```

To change a VST parameter, first confirm that local project capabilities include:

```text
external-plugin.parameters.set
```

Then build the processor and target references from the latest project snapshot and use the normal preview and commit flow.

Public control does not currently provide arbitrary plugin insertion, removal, scanner control, worker process control, or arbitrary editor-window control. Do not reach into Electron or native internals to fake those operations.

Read [native-vst3.md](native-vst3.md) before working on plugin trust, state, recovery, or packaged acceptance.

## Desktop runtime operations

The desktop runtime catalog is:

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

These commands act on the attached host. They do not replace project control.

`daw-control rpc --target host` carries project-control JSONL. Use the named host commands or MCP host tools for transport, diagnostics, import/export, and VST reads.

Do not read registration files or socket paths by hand when the desktop client can connect for you.

## Cloud assets

Assets are project resources, not extra action kinds.

```text
POST   /api/control/v1/projects/:projectId/assets
GET    /api/control/v1/projects/:projectId/assets/:assetId/content
DELETE /api/control/v1/projects/:projectId/assets/:assetId
POST   /api/control/v1/projects/:projectId/asset-folders
PATCH  /api/control/v1/projects/:projectId/asset-folders/:folderId
DELETE /api/control/v1/projects/:projectId/asset-folders/:folderId
PATCH  /api/control/v1/projects/:projectId/assets/:assetId/folder
```

Upload is multipart and capped at 10 MiB. It requires project write access, `Content-Length`, `Idempotency-Key`, and `x-content-sha256`. The Worker checks the digest, MIME type, extension, and audio metadata from the uploaded bytes before finalizing the Convex and R2 records.

A project action may refer to an asset ID returned by project state. It must not invent an R2 key.

Other project resource routes include `/api/samples`, `/api/exports`, `/api/export/:projectId`, and `/api/cloud-backups`.

## Recoveries

`control.recoveries` lists active recovery records. They expire after seven days.

Current recovery kinds are:

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

Restore one with `recovery.restore` and the persisted recovery ID returned by the recovery list or a commit result. Read a fresh snapshot after restore.

## Do not bypass the control path

Do not:

- mutate Convex directly instead of using project control
- edit IndexedDB project records directly
- send raw native frames when a public client exists
- skip preview or required approval
- invent project, track, clip, processor, asset, or recovery IDs
- assume a local-only action exists on cloud
- mutate VST state artifacts by hand
- log approval tokens, bearer tokens, registration secrets, actor credentials, socket paths, or private object keys
- describe VST worker processes as a security sandbox

## Examples

The IDs below are examples. A real client must use IDs from discovery and the latest snapshot.

### Rename a track

Preview this request first:

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

If preview succeeds without approval, commit the same actions with an idempotency key:

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

### Delete a track with approval

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

Request approval with the same project, revision, and actions. Commit only with the returned token:

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

The placeholder is not a real token. Never transmit it.

### Change a VST parameter

Use this only when local capabilities include `external-plugin.parameters.set`:

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

Preview and commit it like any other project mutation.

### Restore a recovery

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

The recovery ID must come from `control.recoveries` or a previous commit result.

## Public clients

`@daw-browser/control-sdk` provides the typed project client, JSONL adapter, and REST compatibility client. `@daw-browser/control-sdk/desktop` provides `connectDesktopControl`.

The `daw-control` CLI supports cloud and desktop project control plus separate host commands. MCP prefers `control_capabilities_v2` and `control_snapshot_v2` for reads. The unsuffixed read tools remain for V1 compatibility.

Use the supported authenticated clients. Do not print or persist credentials, registration secrets, socket paths, or private object keys.