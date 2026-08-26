# Model-independent control platform: what changed

**Merged:** 2026-08-26  
**Pull request:** #47, `feat/model-independent-control-platform`  
**Merge commit:** `b4bf014d5d9e95e82cff64df8c78a44ae46ae138`  
**Runtime-certified ancestor:** `37e400e42bcde874926d45e952a91ceb5080c94d`  
**Final reviewed PR head:** `3cff4bf5af63a8eb8fd6823babd0c119d1bb3d67`

PR #47 changed the control architecture, the Electron host, native VST3 support, cloud asset handling, agent integration, and the test gates around all of them. It was 132 commits across 926 files, so this document records the behavior that changed instead of asking readers to reconstruct the story from the diff.

Current docs:

- [Control platform architecture](../control-platform.md)
- [Agent control manual](../agent-control.md)
- [Native VST3 architecture](../native-vst3.md)
- [Packaged runtime acceptance](../../acceptance-reports/control-platform-runtime-2026-08-20.md)
- [Completed implementation tracker](../../implementation-trackers/model-independent-control-platform.md)

## What changed in practical terms

Before this merge, the repository had several ways to change DAW state. They did not share one operation catalog, one request lifecycle, or one set of semantics across cloud and desktop.

After the merge:

- project control uses one operation catalog for cloud and desktop
- the SDK, CLI, MCP, JSONL, REST, and Electron adapters all route into the same project-control model
- writes use preview, optional approval, revision checks, keyed idempotency, history, and recoveries
- the Electron app exposes an authenticated local host instead of relying on internal renderer access
- macOS VST3 discovery, trust checks, workers, parameters, state, editor windows, export, and recovery are packaged product behavior
- renderer reload, crash, and ambiguous navigation events cannot keep stale privileged ownership
- cloud audio upload checks metadata from the uploaded bytes instead of trusting caller metadata
- Factory skills and current docs tell agents which APIs they may use and which internals they must not touch

## Control ownership

The control code is split by job.

```text
UI / extension / agent / CLI / MCP
              |
        ControlClient
              |
        ControlInvoker
        /      |      \
      HTTP   Desktop   Direct
        \      |      /
         ControlHandler
              |
          control-core
              |
        project authority
```

`@daw-browser/control` owns the schemas, operation IDs, request envelopes, snapshots, serialization, digests, recovery contracts, limits, capabilities, and compatibility aliases.

`@daw-browser/control-core` owns pure project planning and projection. It also owns MIDI resolution, destructive transforms, and recovery ordering. It has no transport or storage authority.

Local and cloud handlers connect that logic to real project state. `ControlInvoker` validates the selected target plus operation input and output. The public adapters stay outside that logic.

## Operation catalog

Project control has nine operations:

| Operation | Targets | Purpose | Idempotency |
| --- | --- | --- | --- |
| `project.list` | cloud, desktop | discover projects | safe |
| `project.current` | desktop | identify the mounted project | safe |
| `control.capabilities` | cloud, desktop | read supported actions and limits | safe |
| `control.snapshot` | cloud, desktop | read project state and revision | safe |
| `control.preview` | cloud, desktop | validate and project a write | safe |
| `control.requestApproval` | cloud, desktop | approve a destructive request | none |
| `control.commit` | cloud, desktop | apply the exact request | keyed |
| `control.history` | cloud, desktop | read committed control history | safe |
| `control.recoveries` | cloud, desktop | read active recovery records | safe |

`project.current` stays desktop-only because it refers to a mounted local project.

Capabilities and snapshots use the V2 read model. Existing mutation, approval, history, and recovery requests keep their V1 compatibility envelope.

## Capability-first writes

A client should not guess what it can do.

The expected write flow is:

1. discover the project
2. read capabilities
3. read the V2 snapshot and revision
4. build V1 actions from returned IDs
5. preview the exact request
6. request approval if preview requires it
7. commit with a stable idempotency key
8. read a fresh snapshot, history, or recoveries

A `revision-conflict` means the request is stale. The client must fetch a new snapshot and rebuild the request.

## Project action inventory

Cloud project control advertises 39 action kinds.

### Project and tracks

```text
project.rename
project.settings.set
track.create
track.rename
track.mix.set
track.routing.set
track.reorder
track.group.set
track.delete
track.collapsed.set
track.color.set
track.color.cascade
track.ungroup
```

### Clips and timeline

```text
clip.midi.create
clip.audio.create
clip.source.set
clip.midi.set
clip.fades.set
clip.audioWarp.set
clip.color.set
clip.move
clip.timing.set
clip.rename
clip.delete
timeline.range.delete
```

### Mixer and built-in processors

```text
master.volume.set
effect.upsert
effect.remove
effect.reorder
instrument.set
instrument.remove
arpeggiator.set
arpeggiator.remove
```

### Automation, routing, assets, and recovery

```text
automation.set
automation.delete
sidechain.set
sidechain.remove
asset.delete
recovery.restore
```

Desktop project control can add one local-only action:

```text
external-plugin.parameters.set
```

That action is available only when the local capabilities report it.

## Preview, approval, idempotency, and recovery

`control.preview` validates references and ordering, projects the change, returns warnings and revision data, and reports whether approval is required. It does not mutate the project.

`control.requestApproval` binds approval to the exact request digest and action selection. Approval expires after 600 seconds.

`control.commit` uses a stable idempotency key. Replaying the same request with the same key does not apply the mutation twice. Reusing the key for a different request returns an idempotency conflict.

Successful writes appear in control history. Idempotent replays do not create duplicate history entries.

Destructive writes can create recovery records. Current recovery kinds are:

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

Recoveries expire after seven days and restore through `recovery.restore`.

Local recovery also preserves VST processor references, shared state artifacts, routing, grouping, and the other project data needed to reconstruct destructive edits correctly.

## SDK, CLI, JSONL, and MCP

`@daw-browser/control-sdk` became the public TypeScript entry point instead of forcing consumers to import CLI internals.

It exports `createCanonicalControlClient`, `createJsonlRpcAdapter`, the REST compatibility client, and the desktop entry point `connectDesktopControl`.

The desktop client discovers and authenticates the packaged host. It does not expose registration secrets, raw sockets, project stores, or arbitrary Electron IPC.

The `daw-control` CLI supports cloud and desktop project control:

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

Host commands stay separate:

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

`rpc --target host` carries project-control JSONL. It is not generic native RPC.

The JSONL process path gained regression coverage for malformed input, oversized lines, split UTF-8, notifications, sequential requests, and Bun stdin flow.

MCP prefers these V2 reads:

```text
control_capabilities_v2
control_snapshot_v2
```

Compatibility reads remain:

```text
control_capabilities
control_snapshot
```

Project tools:

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

Two protocol-naive model runs were part of packaged acceptance. Each model discovered the mounted project, chose the V2 snapshot, built a persisted track reference, previewed, committed, and verified the new revision without DAW protocol instructions in the prompt.

## Cloud control and assets

The Worker keeps versioned control routes under `/api/control` and checks OAuth scope, project access, and project role before it reaches Convex.

Core routes include:

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

Assets remain project resources instead of becoming fake project actions:

```text
POST   /api/control/v1/projects/:projectId/assets
GET    /api/control/v1/projects/:projectId/assets/:assetId/content
DELETE /api/control/v1/projects/:projectId/assets/:assetId
POST   /api/control/v1/projects/:projectId/asset-folders
PATCH  /api/control/v1/projects/:projectId/asset-folders/:folderId
DELETE /api/control/v1/projects/:projectId/asset-folders/:folderId
PATCH  /api/control/v1/projects/:projectId/assets/:assetId/folder
```

Upload checks changed in several important ways. The Worker requires `Content-Length`, `Idempotency-Key`, and `x-content-sha256`. It verifies size, authorization, MIME type, matching extension, SHA-256, and audio metadata from the uploaded bytes. It persists sample rate and channel count and uses MediaBunny for duration inspection when header metadata is not enough.

Known user-media validation failures return a client error. Unexpected parser, storage, Convex, or runtime failures stay server errors instead of being mislabeled as bad input.

MediaBunny moved to `1.55.1`, including the current `Quality` API for encoding bitrate.

Project deletion also cleans both the asset namespace and the project-owned backup/export prefix. R2 prefix validation fails closed so a cleanup request cannot widen into an unrelated delete.

## Desktop host and runtime commands

The Electron app became an authenticated local host with a versioned protocol. The protocol covers request and reply framing, registration discovery, socket authentication, request correlation, size limits, lifecycle generation, host runtime status, native bridge contracts, menu commands, file capabilities, and VST reads.

`registration-v1.json` remains a compatibility contract. Packaged tests covered private permissions plus missing, malformed, dead-socket, unsafe-permission, stopped-host, and restart cases.

Desktop runtime operations are separate from project control:

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

This keeps playback and diagnostics out of durable project history and prevents the desktop adapter from becoming an unrestricted native command tunnel.

## Import, playback, export, and media hydration

The packaged desktop app gained public flows for transport, local audio import, project media persistence, restart hydration, export, cancellation, output path capabilities, and diagnostics.

Packaged testing found and fixed several bugs in these paths:

- `/tmp` and `/private/tmp` path equivalence broke socket and output capability checks
- renderer replies included optional `undefined` fields that failed serialization
- `transport.stop` could return stale paused state
- main-process file metadata and `AbortSignal` crossed the context bridge incorrectly
- export preflight and final export reused one request ID before queue cleanup
- persisted local audio clips were not hydrated early enough after restart
- the native PCM queue was too small for normal export bursts
- Bun stdin flow could drop later JSONL chunks

The final one-second desktop export was independently decoded as stereo 48 kHz 16-bit PCM, 192,044 bytes.

## Native VST3

The merge completed the macOS packaged VST3 path.

Standard discovery roots are:

```text
/Library/Audio/Plug-Ins/VST3
~/Library/Audio/Plug-Ins/VST3
```

First native execution requires trust acknowledgement. Scanner and launch checks verify canonical location, executable presence, quarantine state, strict code signing, arm64 support, scanner compatibility, and bundle/executable fingerprints.

A previously trusted catalog record is not permanent launch permission. Startup revalidates it, and stale entries can be repaired by rescanning the current files.

The native process layout separates Electron main, the audio host, the scanner, playback workers, and editor workers. Worker isolation helps with crashes. It does not sandbox malicious plugin code.

Attachment checks include packaged artifact IDs, protocol and ABI versions, class ID, bus layout, parameter manifest, state revision, and transport limits. The graph publishes only after the native transaction is ready.

The real packaged campaign found a TypeScript/native attachment mismatch. TypeScript emitted the parameter-ID extension, while the native decoder expected the payload to stop after initial values. The decoder now accepts the current extension with limits.

Public VST reads are:

```text
host.vst.instances
host.vst.parameters
```

The public write is:

```text
external-plugin.parameters.set
```

It is a local project action, not a host runtime write.

Public control still does not expose arbitrary plugin insertion, removal, scanner commands, worker control, or arbitrary editor-window commands.

Opaque VST state is capped at 512 KiB and checked with SHA-256. Stateful plugins can persist captured state for rebuild, editor teardown, export, and restart. Stateless plugins use defaults plus persisted parameters.

Shared local state artifacts are reference-aware. Deleting one processor cannot remove state still referenced by another processor. Recovery only reuses an existing artifact when the stored metadata and bytes match.

Worker or native-host loss can trigger a limited rebuild. Recovery keeps the normal trust, fingerprint, manifest, protocol, and state checks. The worker supervisor allows at most three restarts.

Editor-capable plugins run their editor in a separate native worker. Open, close, focus, resize, and status use typed commands and notifications.

Manual parameter edits override scheduled automation for the addressed parameter. Native override insertion handles tombstones, preserves existing overrides, and rolls back a newly reserved override if event queuing fails. The current product flow requires stopped transport before automation re-enable succeeds.

Native export resolves and preflights attachments again. The render result is finalized before plugin teardown, and offline workers no longer initialize unused AppKit editor state.

Current limitation: Native Phase A export rejects projects that contain automation.

## Real VST acceptance

ValhallaSupermassive 5.0.0 arm64 was the installed plugin used for the packaged merge gate.

The campaign verified:

- standard-directory discovery and trust-gated scan
- successful attachment
- all 19 reported parameters
- native editor launch
- Mix change from 0.50 to 0.51 with independent MCP verification
- playback
- deliberate playback-worker termination and recovery
- cold restart with plugin and parameter state preserved
- stale catalog corruption followed by automatic repair
- repeated one-second stereo 48 kHz PCM exports of 192,044 bytes
- manual automation override and re-enable
- renderer reload and crash recovery

The browser campaign separately covered non-VST editing, routing, import, playback and seek, built-in EQ and Synth, restart media hydration, settings, keyboard shortcuts, and a one-second nonzero export.

## Renderer lifecycle

Renderer lifetime is treated as privileged ownership, not just a UI lifecycle.

A full main-frame navigation invalidates privileged requests and active manual native transactions. A committed document gets a new generation. Failed or cancelled navigation can restore the previous document only when the outcome is unambiguous. Renderer crash invalidates ownership immediately.

Electron does not expose a reliable navigation ID for every overlapping same-URL case. The lifecycle code therefore fails closed when it cannot correlate events. Retired navigation identities stay quarantined so a late event cannot be mistaken for the next clean navigation. That quarantine is capped at 128 identities. Overflow stops retaining new identities and remains fail closed until crash recovery.

A test-only shortcut that activated a document outside the real commit path was removed.

## Local and cloud conformance

The branch added one conformance suite for local IndexedDB control and cloud Convex control. It checks discovery, capabilities, V2 snapshots, preview non-mutation, approval, commit, idempotency, revision conflicts, history, recoveries, schema rejection, target rules, and project authorization.

Cloud track-delete and ungroup recovery were fixed to preserve survivor grouping and output routing.

Local destructive recovery gained VST-aware behavior through an explicit planner capability instead of presenting the planner with a fake snapshot.

## Built-in extension kernel

A trusted app-local extension kernel now handles statically imported built-ins. It validates command and shortcut declarations, stages activation before publishing it, cleans up by generation, exposes limited diagnostics and abort signals, and supports controlled command replacement.

The existing browser toggle was routed through the kernel without moving browser state into the extension system.

Project actions contributed by built-ins still use normal preview, approval, and commit rules.

External extension packages, arbitrary DSP/package loading, and a public arbitrary-operation endpoint remain out of scope.

## Security fixes and trust rules

The merge tightened several paths that carry authority or untrusted input:

- one operation catalog validates project-control inputs and outputs
- project access stays behind local authority or authenticated Worker and Convex checks
- OAuth read and write scopes are separate
- approval tokens are request-bound and expire
- desktop registration and sockets use private validated discovery
- renderer requests carry document-generation ownership
- import and output paths use file capabilities and canonical path checks
- R2 deletion prefixes must match allowed project prefixes
- audio upload checks the actual bytes and SHA-256
- native frames, parameter counts, state size, deadlines, worker limits, and packaged manifests have explicit limits
- VST bundle identity, signature, quarantine state, architecture, and fingerprints are rechecked before launch

VST worker processes are crash isolation, not hostile-code containment. Plugins still run as native code with the desktop user's authority.

## Tests and review gates

The merge gate included:

```text
bun run lint
bun run test:anti-slop
bun run typecheck
bun test
bun run test:control-platform
bun run test:control-compat
bun run build
native CTest
Electron packaging and native artifact checks
```

Final reported results:

- 2,433 Bun tests passed
- 1 intentional skip
- 0 Bun test failures
- 161 control-platform tests passed
- 40 control-compatibility tests passed
- 12 anti-slop RuleTester suites passed
- Oxlint reported 0 warnings and 0 errors
- TypeScript checks passed
- native CTest passed 6 of 6 at the runtime-certified commit
- production build passed
- Electron packaging and native artifact checks passed during runtime certification
- final correctness, structure, simplification, defensive, and security reviews found no merge blocker

## Agent docs and Factory skills

Current operating docs are:

```text
docs/control-platform.md
docs/agent-control.md
docs/native-vst3.md
```

Repo-scoped Factory skills are:

```text
.factory/skills/daw-project-control/SKILL.md
.factory/skills/daw-desktop-runtime/SKILL.md
.factory/skills/daw-vst3/SKILL.md
```

The skills keep project mutations, desktop runtime commands, and VST trust/testing rules separate.

`AGENTS.md` points coding agents to these public APIs instead of the old Workers AI and application-specific agent-route assumptions. Local Factory settings, captures, threat models, credentials, and other machine state remain ignored.

## Repository cleanup

The README was updated for the browser, cloud, Electron, and native architecture.

The model-independent-control implementation tracker is marked completed and historical. It points readers to the current docs and acceptance report.

Temporary advisor plans 001 through 010 were deleted after their work was implemented and certified.

The checked-in `security-findings.json` was also removed. It described an older August 17 working-tree scan and could be mistaken for exact-head certification evidence.

## Compatibility kept on purpose

The merge kept:

- V1 and V2 control contracts
- V1 and V2 capability and snapshot projections
- versioned REST routes
- CLI commands
- MCP compatibility tools
- desktop V1 and V2 framing where applicable
- `registration-v1.json`
- durable local control, history, and recovery records that still need migration compatibility

A newer in-repo API is not enough reason to delete one of these. Removal needs evidence from deployed or installed consumers.

## Known limits

The merge does not provide:

- VST3 in browser or cloud targets
- public arbitrary VST insertion, removal, editor control, or worker control
- a malicious-plugin sandbox
- cloud JSONL process transport
- a public arbitrary-operation RPC
- external extension package loading
- arbitrary DSP/package loading
- portable or cloud opaque VST state transport
- packaged extension activation, deactivation, or reload controls
- Native Phase A export for projects that contain automation

The current product flow also requires stopped transport before automation re-enable succeeds.

The exact overlapping same-URL Electron event sequence cannot be forced reliably through CDP. The executable lifecycle tests are the authority for that case.

## What contributors should do now

When adding an agent, extension, CLI command, MCP tool, REST adapter, or other integration:

- start with `control.capabilities` and `control.snapshot`
- use V2 reads for new integrations
- use the existing V1 write envelopes
- build persisted references from the latest snapshot
- preview every write
- request approval only when preview requires it
- reuse an idempotency key only for the identical request
- rebuild after `revision-conflict`
- keep transport, diagnostics, import/export, and VST reads out of project actions
- use `external-plugin.parameters.set` only when local capabilities advertise it
- use the SDK or desktop protocol client instead of reading registration or socket internals
- keep the VST trust, preflight, state, and size checks in place
- do not mutate Convex, IndexedDB, plugin state artifacts, or raw native frames when a public API exists

## Certification trail

Runtime certification stopped at `37e400e42bcde874926d45e952a91ceb5080c94d`. The following two PR commits changed only docs, Factory skill manifests, ignore and tracker cleanup, acceptance reporting, and stale review artifacts.

The final reviewed PR head was `3cff4bf5af63a8eb8fd6823babd0c119d1bb3d67`. Cloudflare built and deployed that exact commit before merge.

PR #47 merged as `b4bf014d5d9e95e82cff64df8c78a44ae46ae138`.

For the full runtime matrix, packaged bugs, and evidence paths, read the [acceptance report](../../acceptance-reports/control-platform-runtime-2026-08-20.md). For checkpoint-by-checkpoint implementation history, read the [completed tracker](../../implementation-trackers/model-independent-control-platform.md).